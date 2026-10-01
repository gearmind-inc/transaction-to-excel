import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../tests/fixtures/transactions.html', import.meta.url));
const structured = await readFile(new URL('../tests/fixtures/structured-browser.html', import.meta.url));
const port = Number(process.env.MVP_FIXTURE_PORT || 4173);
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/transactions') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } else if (req.url === '/structured') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(structured);
  } else { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic fixture: http://127.0.0.1:${port}/transactions`));
