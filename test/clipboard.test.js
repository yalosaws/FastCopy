'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');

const token = 't';
const auth = { Cookie: `fc_token=${token}` };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory stand-in for the computer's clipboard.
const fake = {
  value: 'already there at startup',
  writes: [],
  read: async () => fake.value,
  write: async (text) => { fake.writes.push(text); fake.value = text; },
};

let server, base;

before(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcopy-'));
  ({ server } = createApp({ token, uploadDir, clipboard: fake, clipboardInterval: 20 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await wait(60);
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const getItems = async () => (await fetch(`${base}/api/items`, { headers: auth })).json();

test('existing clipboard content is not published at startup', async () => {
  assert.deepStrictEqual(await getItems(), []);
  assert.strictEqual((await fetch(`${base}/api/latest?token=${token}`)).status, 204);
});

test('copying on the computer publishes a text item', async () => {
  fake.value = '电脑上复制的内容';
  await wait(80);
  const items = await getItems();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].text, '电脑上复制的内容');
  assert.strictEqual(items[0].from, '电脑剪贴板');

  const latest = await fetch(`${base}/api/latest?token=${token}`);
  assert.strictEqual(await latest.text(), '电脑上复制的内容');
});

test('text from the phone lands on the computer clipboard without echoing back', async () => {
  const res = await fetch(`${base}/api/text`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 (iPhone)' },
    body: '手机发来的',
  });
  assert.strictEqual(res.status, 201);
  await wait(80);
  assert.deepStrictEqual(fake.writes, ['手机发来的']);
  const items = await getItems();
  assert.strictEqual(items.filter((i) => i.text === '手机发来的').length, 1);
});

test('whitespace-only clipboard is ignored', async () => {
  const before = (await getItems()).length;
  fake.value = '   ';
  await wait(80);
  assert.strictEqual((await getItems()).length, before);
});
