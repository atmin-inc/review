import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Serves the built dashboard (web/dist). Files are read once at startup and matched by exact path,
// so no request path reaches the filesystem. Any other GET page path gets index.html for client routing.
export function site(root: string): (request: IncomingMessage, response: ServerResponse) => boolean {
  const files = new Map<string, { body: Buffer; type: string }>();
  let missing = false;
  try {
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (types[extname(name)]) files.set(`/${relative(root, path).split(sep).join('/')}`, { body: readFileSync(path), type: types[extname(name)]! });
      }
    };
    walk(root);
  } catch { missing = true; }
  if (missing || !files.has('/index.html')) process.stderr.write(`atmin review: dashboard UI not built at ${root}; run npm run build:web. Pages answer 503 until then.\n`);
  return (request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    if (!['GET', 'HEAD'].includes(request.method ?? '') || path === '/healthz' || /^\/(api|auth|webhooks)(\/|$)/.test(path)) return false;
    const file = files.get(path) ?? (extname(path) ? undefined : files.get('/index.html'));
    const headers = { 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    if (!file) {
      const built = files.has('/index.html');
      response.writeHead(built ? 404 : 503, { ...headers, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end(built ? 'not found\n' : 'The atmin dashboard is not built on this server.\n');
      return true;
    }
    // Build output under /assets/ carries a content hash in its name; pages must revalidate.
    response.writeHead(200, { ...headers, 'Content-Type': file.type, 'Content-Length': file.body.length,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : file.body);
    return true;
  };
}
