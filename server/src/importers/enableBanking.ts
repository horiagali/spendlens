import { createHash, createSign, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { parseCents } from '../money.ts';
import type { ImportedTxn } from '../types.ts';

/**
 * Enable Banking (https://enablebanking.com) client for reading your own Revolut account via
 * PSD2 Open Banking. Their free "restricted" production mode allows personal use on accounts
 * you link yourself. Docs: https://enablebanking.com/docs/api/reference/
 *
 * Everything (app id, key path, session) lives in data/enablebanking.json, which is gitignored.
 */

const API = 'https://api.enablebanking.com';

export interface EbConfig {
  appId: string;
  keyPath: string; // path to the private key .pem downloaded when creating the app
  country: string; // e.g. "NL": the country you use Revolut in
  bankName: string; // "Revolut"
  redirectUrl: string; // must be whitelisted on the app; only its ?code= is used
  session?: {
    id: string;
    validUntil: string;
    accounts: { uid: string; identificationHash?: string; currency?: string; name?: string }[];
  };
  lastSync?: string; // ISO timestamp of last successful sync
}

const configPath = () => resolve(config.dataDir, 'enablebanking.json');

export function loadEbConfig(): EbConfig | null {
  return existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as EbConfig) : null;
}

export function saveEbConfig(c: EbConfig) {
  writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT as required by Enable Banking (max lifetime 24h). */
export function makeJwt(appId: string, privateKeyPem: string, ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }));
  const payload = b64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + ttlSeconds }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

export class EnableBanking {
  private cfg: EbConfig;
  constructor(cfg: EbConfig) { this.cfg = cfg; }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = readFileSync(resolve(config.dataDir, this.cfg.keyPath), 'utf8');
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${makeJwt(this.cfg.appId, key)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Enable Banking ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  }

  /** Revolut's entry for the configured country, including its maximum consent length. */
  async findBank(): Promise<{ name: string; country: string; maximum_consent_validity?: number }> {
    const { aspsps } = await this.call<{ aspsps: { name: string; country: string; maximum_consent_validity?: number }[] }>(
      'GET', `/aspsps?country=${encodeURIComponent(this.cfg.country)}&psu_type=personal`);
    const bank = aspsps.find((a) => a.name.toLowerCase() === this.cfg.bankName.toLowerCase());
    if (!bank) throw new Error(`${this.cfg.bankName} not found for country ${this.cfg.country}. Available: ${aspsps.map((a) => a.name).slice(0, 30).join(', ')}…`);
    return bank;
  }

  /** Step 1 of linking: returns the URL to open in a browser to approve access in Revolut. */
  async startAuth(): Promise<{ url: string; state: string }> {
    const bank = await this.findBank();
    const days = Math.floor((bank.maximum_consent_validity ?? 90 * 86400) / 86400) - 1;
    const validUntil = new Date(Date.now() + days * 86400_000).toISOString();
    const state = randomUUID();
    const res = await this.call<{ url: string }>('POST', '/auth', {
      access: { valid_until: validUntil },
      aspsp: { name: bank.name, country: bank.country },
      state,
      redirect_url: this.cfg.redirectUrl,
      psu_type: 'personal',
    });
    return { url: res.url, state };
  }

  /** Step 2: exchange the ?code= from the redirect for a session, and remember its accounts. */
  async finishAuth(redirectedUrlOrCode: string): Promise<EbConfig['session']> {
    const code = redirectedUrlOrCode.includes('code=')
      ? new URL(redirectedUrlOrCode.trim()).searchParams.get('code')!
      : redirectedUrlOrCode.trim();
    const res = await this.call<{ session_id: string; access: { valid_until: string }; accounts: any[] }>('POST', '/sessions', { code });
    this.cfg.session = {
      id: res.session_id,
      validUntil: res.access.valid_until,
      accounts: res.accounts.map((a) => ({ uid: a.uid, identificationHash: a.identification_hash, currency: a.currency, name: a.name ?? a.product })),
    };
    saveEbConfig(this.cfg);
    return this.cfg.session;
  }

  /** All booked transactions for an account since `dateFrom` (or the longest history available). */
  async transactions(accountUid: string, dateFrom: string | null): Promise<any[]> {
    const out: any[] = [];
    let continuationKey: string | null = null;
    do {
      const q = new URLSearchParams({ transaction_status: 'BOOK' });
      if (dateFrom) q.set('date_from', dateFrom);
      else q.set('strategy', 'longest');
      if (continuationKey) q.set('continuation_key', continuationKey);
      const page: { transactions: any[]; continuation_key: string | null } =
        await this.call('GET', `/accounts/${encodeURIComponent(accountUid)}/transactions?${q}`);
      out.push(...page.transactions);
      continuationKey = page.continuation_key;
    } while (continuationKey);
    return out;
  }
}

/**
 * Map an Enable Banking transaction onto the same shape (and description style) as the Revolut
 * CSV, so counterparty detection and the built-in noise rules work for both sources.
 */
export function mapEbTransaction(t: any, account: { uid: string; currency?: string }): ImportedTxn {
  const amountAbs = parseCents(String(t.transaction_amount.amount));
  const amount = t.credit_debit_indicator === 'DBIT' ? -Math.abs(amountAbs) : Math.abs(amountAbs);
  const code: string = (t.bank_transaction_code?.code ?? '').toUpperCase();
  const remittance = (t.remittance_information ?? []).join(' ').trim();
  const counterparty: string | undefined = amount < 0 ? t.creditor?.name : t.debtor?.name;
  const isCard = !!t.merchant_category_code || code.includes('CARD');
  const type = code || (isCard ? 'CARD_PAYMENT' : 'TRANSFER');
  let description: string;
  // Vault/pocket moves are named in the remittance text ("To pocket EUR Savings"), not the counterparty.
  if (/pocket|vault|round[ -]?up|savings|exchanged/i.test(remittance)) description = remittance;
  else if (type === 'TRANSFER' && counterparty) description = amount < 0 ? `To ${counterparty}` : `Transfer from ${counterparty}`;
  else description = counterparty || remittance || type;
  const date: string = t.transaction_date ?? t.booking_date ?? t.value_date;
  const ref: string = t.entry_reference ?? t.transaction_id
    ?? createHash('sha256').update(JSON.stringify([account.uid, date, t.transaction_amount, t.credit_debit_indicator, remittance, counterparty])).digest('hex').slice(0, 24);
  return {
    // Both legs of an exchange share entry_reference across pockets, so include the account.
    id: `eb_${createHash('sha256').update(`${account.uid}|${ref}`).digest('hex').slice(0, 24)}`,
    source: 'enable_banking',
    account: 'Current',
    type,
    startedAt: `${date} 00:00:00`,
    completedAt: t.booking_date ? `${t.booking_date} 00:00:00` : null,
    description,
    amount,
    fee: 0,
    currency: t.transaction_amount.currency,
    state: 'COMPLETED',
    balance: t.balance_after_transaction?.balance_amount ? parseCents(String(t.balance_after_transaction.balance_amount.amount)) : null,
    raw: { ...t, remittance },
  };
}
