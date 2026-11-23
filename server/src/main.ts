import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { buildApi } from './api.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { startAutoSync } from './sync.ts';

const db = openDb(config.dbPath);
const api = buildApi(db);
const webDist = resolve(config.root, 'web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  if (await api.handle(req, res)) return;
  if (req.url?.startsWith('/api/')) { res.writeHead(404).end(); return; }
  // Serve the built web app, falling back to index.html for client-side routes.
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(webDist, path);
  if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Web app not built. Run `npm run build`, or `npm run dev:web` for development.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(config.port, config.host, () => {
  startAutoSync(db);
  console.log(`spendlens running at http://${config.host}:${config.port} (data: ${config.dataDir})`);
});
