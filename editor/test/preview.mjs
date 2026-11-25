/* Only a local demo server; Cloudflare deploys src/worker.mjs and public/, never this file. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ADMIN, AUTHOR, ORIGIN, fixture } from './fixture.mjs';

export async function servePreview(port = 0) {
  const f = await fixture();
  const server = createServer(async (req, res) => {
    try {
      const local = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== new URL(local).host) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, local);
      if (url.pathname === '/__synthetic_admin' && req.method === 'GET') {
        const login = await f.login(ADMIN);
        res
          .writeHead(303, {
            location: '/',
            'set-cookie': login.callback.headers.getSetCookie(),
          })
          .end();
        return;
      }
      if (url.pathname === '/login' && req.method === 'GET') {
        const login = await f.login(AUTHOR);
        res
          .writeHead(303, {
            location: '/',
            'set-cookie': login.callback.headers.getSetCookie(),
          })
          .end();
        return;
      }
      const body = [];
      let length = 0;
      for await (const data of req) {
        length += data.length;
        if (length > 16500) {
          res.writeHead(413).end();
          return;
        }
        body.push(data);
      }
      const { authorization: _dropped, ...headers } = req.headers;
      if (headers.origin === local) headers.origin = ORIGIN;
      const result = await f.request(url.pathname + url.search, {
        method: req.method,
        headers,
        ...(body.length ? { body: Buffer.concat(body) } : {}),
      });
      const entries = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) entries['set-cookie'] = cookies;
      let contents = Buffer.from(await result.arrayBuffer());
      if (url.pathname === '/') {
        contents = Buffer.from(
          contents
            .toString()
            .replace(
              '<main>',
              '<main><p><strong>Demonstração local · somente dados sintéticos.</strong> <a href="/__synthetic_admin">Alternar para administrador de teste</a></p>',
            ),
        );
        delete entries['content-length'];
      }
      res.writeHead(result.status, entries).end(contents);
    } catch {
      res.writeHead(500).end('Falha da prévia sintética.');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { url } = await servePreview(Number(process.argv[2] || 4242));
  console.log(`Prévia sintética (sem Discord ou GitHub): ${url}`);
}
