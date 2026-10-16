'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');

let server, base;
const token = 'testtoken';
const auth = { Cookie: `fc_token=${token}` };

before(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcopy-'));
  ({ server } = createApp({ token, uploadDir, maxUploadBytes: 1024 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('rejects requests without token', async () => {
  assert.strictEqual((await fetch(`${base}/api/items`)).status, 403);
});

test('token in query sets cookie on the page', async () => {
  const res = await fetch(`${base}/?token=${token}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /fc_token=testtoken/);
});

test('text round trip', async () => {
  const res = await fetch(`${base}/api/text`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好 FastCopy' }),
  });
  assert.strictEqual(res.status, 201);
  const items = await (await fetch(`${base}/api/items`, { headers: auth })).json();
  assert.ok(items.some((i) => i.type === 'text' && i.text === '你好 FastCopy'));
});

test('file upload, download and delete', async () => {
  const res = await fetch(`${base}/api/upload?name=${encodeURIComponent('照片.txt')}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.strictEqual(res.status, 201);
  const item = await res.json();
  assert.strictEqual(item.name, '照片.txt');
  assert.strictEqual(item.size, 5);

  const dl = await fetch(`${base}/files/${item.id}`, { headers: auth });
  assert.strictEqual(await dl.text(), 'hello');
  assert.match(dl.headers.get('content-disposition'), /attachment/);

  assert.strictEqual((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.strictEqual((await fetch(`${base}/files/${item.id}`, { headers: auth })).status, 404);
});

test('upload path traversal is neutralised', async () => {
  const res = await fetch(`${base}/api/upload?name=${encodeURIComponent('../../etc/passwd')}`, {
    method: 'POST', headers: auth, body: 'x',
  });
  assert.strictEqual((await res.json()).name, 'passwd');
});

test('oversized upload is rejected', async () => {
  const res = await fetch(`${base}/api/upload?name=big.bin`, {
    method: 'POST', headers: auth, body: Buffer.alloc(2048),
  });
  assert.strictEqual(res.status, 413);
});
