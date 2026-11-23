import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export const config = {
  root,
  dataDir: resolve(process.env.SPENDLENS_DATA ?? resolve(root, 'data')),
  get dbPath() { return resolve(this.dataDir, 'spendlens.db'); },
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 5174),
};
