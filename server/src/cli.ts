import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { EnableBanking, loadEbConfig, saveEbConfig, type EbConfig } from './importers/enableBanking.ts';
import { parseRevolutCsv } from './importers/revolutCsv.ts';
import { importTransactions } from './store.ts';
import { syncEnableBanking, syncStatus } from './sync.ts';

const [cmd, ...args] = process.argv.slice(2);
const rl = () => createInterface({ input: process.stdin, output: process.stdout });

async function ask(q: string, def?: string): Promise<string> {
  const r = rl();
  const a = (await r.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  r.close();
  return a || def || '';
}

async function bank(sub: string | undefined) {
  if (sub === 'setup') {
    const prev = loadEbConfig();
    const cfg: EbConfig = {
      ...prev,
      appId: await ask('Enable Banking application ID', prev?.appId),
      keyPath: await ask(`Private key file, relative to ${config.dataDir}`, prev?.keyPath ?? 'enablebanking.pem'),
      country: (await ask('Country you use Revolut in (2-letter code, e.g. NL, DE, RO)', prev?.country)).toUpperCase(),
      bankName: prev?.bankName ?? 'Revolut',
      redirectUrl: await ask('Redirect URL (as whitelisted on the app)', prev?.redirectUrl ?? 'https://localhost/callback'),
    };
    if (!existsSync(resolve(config.dataDir, cfg.keyPath))) console.warn(`⚠ Key file not found at ${resolve(config.dataDir, cfg.keyPath)}`);
    saveEbConfig(cfg);
    const b = await new EnableBanking(cfg).findBank();
    console.log(`✓ Saved. Found ${b.name} (${b.country}), max consent ${Math.round((b.maximum_consent_validity ?? 0) / 86400)} days. Next: npm run bank -- link`);
  } else if (sub === 'link') {
    const cfg = loadEbConfig();
    if (!cfg) throw new Error('Run `npm run bank -- setup` first.');
    const eb = new EnableBanking(cfg);
    const { url } = await eb.startAuth();
    console.log(`\n1. Open this URL and approve access in Revolut:\n\n   ${url}\n`);
    console.log('2. You will end up on a page that may fail to load. That is fine.');
    const redirected = await ask('3. Paste the full URL from the address bar here');
    const session = await eb.finishAuth(redirected);
    console.log(`✓ Linked ${session!.accounts.length} account(s), valid until ${session!.validUntil}.`);
    console.log('Fetching full history now (banks often only allow deep history right after linking)…');
    const r = await syncEnableBanking(openDb(config.dbPath));
    console.log(`✓ ${r.added} new, ${r.updated} updated, ${r.unchanged} already known.`);
  } else if (sub === 'sync') {
    const r = await syncEnableBanking(openDb(config.dbPath));
    console.log(`✓ ${r.added} new, ${r.updated} updated, ${r.unchanged} already known.`);
  } else if (sub === 'status') {
    console.log(syncStatus());
  } else {
    console.error('Usage: npm run bank -- setup | link | sync | status');
    process.exit(1);
  }
}

if (cmd === 'import') {
  if (args.length === 0) { console.error('Usage: npm run import -- <statement.csv> [...more.csv]'); process.exit(1); }
  const db = openDb(config.dbPath);
  for (const file of args) {
    const res = importTransactions(db, parseRevolutCsv(readFileSync(file, 'utf8')), basename(file));
    console.log(`${basename(file)}: ${res.added} added, ${res.updated} updated, ${res.unchanged} unchanged`);
  }
} else if (cmd === 'bank') {
  await bank(args[0]).catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
} else {
  console.error('Commands: import <file.csv>... | bank setup|link|sync|status');
  process.exit(1);
}
