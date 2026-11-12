import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const active = new Set();

export async function startServer({ dataDir, port }) {
  if (dataDir === 'no-backend') return undefined;
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Synthetic dashboard</title>');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"ok"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  active.add(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const accessToken = randomBytes(32).toString('base64url');
  const backend = {
    url, accessToken, launchUrl: `${url}/#access=${accessToken}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => {
        active.delete(server);
        if (error) reject(error); else resolve();
      });
    })
  };
  switch (dataDir) {
    case 'missing-launch': delete backend.launchUrl; break;
    case 'invalid-launch': backend.launchUrl = `not a url ${accessToken}`; break;
    case 'wrong-origin': backend.launchUrl = `http://localhost:${server.address().port}/#access=${accessToken}`; break;
    case 'wrong-token': backend.launchUrl = `${url}/#access=${'a'.repeat(43)}`; break;
    case 'missing-token': delete backend.accessToken; break;
    case 'bad-token': backend.accessToken = 'too-short'; break;
    case 'token-in-query': backend.launchUrl = `${url}/?access=${accessToken}#access=${accessToken}`; break;
    case 'other-path': backend.launchUrl = `${url}/other#access=${accessToken}`; break;
    case 'bad-base': backend.url = `${url}/`; break;
  }
  return backend;
}
