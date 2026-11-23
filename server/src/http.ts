import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<any>;
  text: () => Promise<string>;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

/** Tiny method + path router: patterns like "/api/rules/:id". */
export class Router {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  patch(p: string, h: Handler) { return this.on('PATCH', p, h); }
  put(p: string, h: Handler) { return this.on('PUT', p, h); }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h); }

  /** Returns false when no route matched. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== req.method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      if (!r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(segs[i]!)), true) : p === segs[i]))) continue;
      let cached: Promise<string> | null = null;
      const text = () => (cached ??= readBody(req));
      try {
        const out = await r.handler({ req, url, params, text, body: async () => { const t = await text(); return t ? JSON.parse(t) : {}; } });
        send(res, 200, out ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
        if (status === 500) console.error(e);
        send(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 50 * 1024 * 1024; // full-history CSVs can be large

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
