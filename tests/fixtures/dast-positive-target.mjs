// Synthetic scanner acceptance target only. No filesystem, model, DB or forwarding.
import { createServer } from 'node:http';

if (process.getuid() !== 1000 || process.argv.length !== 2) throw new Error('Synthetic target refused');
const html = '<!doctype html><html><head><title>MR21 synthetic detector control</title></head>' +
  '<body><h1>Synthetic detector control</h1><p>Test card: 4111111111111111</p>' +
  '<a href="/docs">Docs</a><a href="/">Home</a></body></html>';
let count = 0; let invalid = false;
const server = createServer((req, res) => {
  const valid = req.method === 'GET' && req.headers.host === '127.0.0.1:18080' &&
    typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') &&
    req.url.length <= 1024 && !/[\u0000-\u001f\u007f\\?#]/.test(req.url) && count < 4096;
  if (!valid) {
    invalid = true; process.stdout.write('{"event":"invalid"}\n');
    res.writeHead(400); res.end('invalid synthetic request'); return;
  }
  count++; process.stdout.write(JSON.stringify({ event: 'request', path: req.url }) + '\n');
  const value = req.url === '/.env' ? ['text/plain', 'APP_NAME=MR21_SYNTHETIC_CONTROL\n'] :
    req.url === '/.git/config' ? ['text/plain', '[core]\nrepositoryformatversion=0\n'] :
      ['/', '/docs'].includes(req.url) ? ['text/html; charset=utf-8', html] : null;
  const body = value ? value[1] : 'not found';
  res.writeHead(value ? 200 : 404, { 'content-type': value ? value[0] : 'text/plain', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
server.requestTimeout = 5000; server.headersTimeout = 5000;
server.listen(18080, '127.0.0.1', () => process.stdout.write('{"event":"ready"}\n'));
process.once('SIGTERM', () => {
  server.closeAllConnections(); server.close(() => { process.exitCode = invalid ? 1 : 0; });
});
