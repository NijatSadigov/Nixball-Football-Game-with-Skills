// Minimal static file server for the built client (dist/public).
// Kept dependency-free so the production bundle is a single file + assets.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function makeStaticHandler(publicDir: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (!existsSync(publicDir)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('NixBall server is running, but the client is not built.\nRun: npm run build\n(In dev, use the Vite server on port 5173 instead.)');
      return;
    }

    const rel = url === '/' ? 'index.html' : url.slice(1);
    const file = path.resolve(publicDir, rel);
    // path traversal guard
    if (!file.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      res.end();
      return;
    }

    let target = file;
    if (!existsSync(target) || !statSync(target).isFile()) {
      // SPA fallback: unknown paths get the app shell
      target = path.join(publicDir, 'index.html');
      if (!existsSync(target)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
    }

    const ext = path.extname(target).toLowerCase();
    const isAsset = rel.startsWith('assets/');
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(target).pipe(res);
  };
}
