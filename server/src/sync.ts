import type { DB } from './db.ts';
import { EnableBanking, loadEbConfig, mapEbTransaction, saveEbConfig } from './importers/enableBanking.ts';
import { importTransactions, type ImportResult } from './store.ts';

export interface SyncStatus {
  configured: boolean;
  linked: boolean;
  validUntil: string | null;
  daysLeft: number | null;
  lastSync: string | null;
  accounts: number;
}

export function syncStatus(): SyncStatus {
  const c = loadEbConfig();
  const validUntil = c?.session?.validUntil ?? null;
  return {
    configured: !!c,
    linked: !!c?.session,
    validUntil,
    daysLeft: validUntil ? Math.floor((Date.parse(validUntil) - Date.now()) / 86_400_000) : null,
    lastSync: c?.lastSync ?? null,
    accounts: c?.session?.accounts.length ?? 0,
  };
}

/**
 * Pull booked transactions for every linked account. The first sync asks for the longest history
 * the bank allows; later syncs re-fetch a week of overlap so late-booked payments are caught.
 */
export async function syncEnableBanking(db: DB): Promise<ImportResult> {
  const cfg = loadEbConfig();
  if (!cfg?.session) throw new Error('Bank sync is not linked yet. Run `npm run bank -- link`.');
  if (Date.parse(cfg.session.validUntil) < Date.now()) throw new Error('Bank access expired. Run `npm run bank -- link` to renew it.');
  const eb = new EnableBanking(cfg);
  const dateFrom = cfg.lastSync ? new Date(Date.parse(cfg.lastSync) - 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const total: ImportResult = { added: 0, updated: 0, unchanged: 0 };
  for (const account of cfg.session.accounts) {
    const raw = await eb.transactions(account.uid, dateFrom);
    if (raw.length === 0) continue;
    const r = importTransactions(db, raw.map((t) => mapEbTransaction(t, account)), `bank sync (${account.currency ?? account.uid})`);
    total.added += r.added; total.updated += r.updated; total.unchanged += r.unchanged;
  }
  cfg.lastSync = new Date().toISOString();
  saveEbConfig(cfg);
  return total;
}

const SYNC_EVERY_MS = 8 * 3600_000; // banks allow ~4 unattended fetches a day

/** Background sync while the server runs. Quietly does nothing until bank sync is linked. */
export function startAutoSync(db: DB) {
  const tick = async () => {
    const s = syncStatus();
    if (!s.linked || (s.daysLeft ?? 0) < 0) return;
    if (s.lastSync && Date.now() - Date.parse(s.lastSync) < SYNC_EVERY_MS) return;
    try {
      const r = await syncEnableBanking(db);
      console.log(`bank sync: ${r.added} new, ${r.updated} updated`);
    } catch (e) {
      console.error('bank sync failed:', (e as Error).message);
    }
  };
  tick();
  setInterval(tick, 30 * 60_000).unref();
}
