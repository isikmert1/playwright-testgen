const { readFileSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const publicDirectory = path.join(__dirname, 'public');
const routes = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/styles.css', ['text/css; charset=utf-8', 'styles.css']],
]);

function createServer() {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/health') {
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
      return;
    }

    const route = routes.get(pathname);
    if (route == null) {
      response.writeHead(404).end();
      return;
    }

    const [contentType, filename] = route;
    const body = readFileSync(path.join(publicDirectory, filename));
    response
      .writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
      })
      .end(request.method === 'HEAD' ? undefined : body);
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('PORT must be an integer from 0 to 65535.');
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    if (process.send != null) process.send({ type: 'ready', origin });
    else process.stdout.write(`${origin}\n`);
  });
}

module.exports = { createServer };
