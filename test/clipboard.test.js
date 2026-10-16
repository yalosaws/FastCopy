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
  imageWrites: [],
  read: async () => fake.value,
  write: async (text) => { fake.writes.push(text); fake.value = text; },
  writeImage: async (data) => { fake.imageWrites.push(data); fake.value = { image: data }; },
};

let server, base, saveDir;

before(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcopy-'));
  saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcopy-save-'));
  // Treat every request as coming from a phone (the tests themselves run on this computer).
  ({ server } = createApp({ token, uploadDir, saveDir, clipboard: fake, clipboardInterval: 20, isLocalRequest: () => false }));
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

test('client id and device name are recorded on items', async () => {
  const res = await fetch(`${base}/api/text`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/plain', 'X-FastCopy-Client': 'abc-123', 'X-FastCopy-Device': encodeURIComponent('我的手机') },
    body: 'from app',
  });
  const item = await res.json();
  assert.strictEqual(item.client, 'abc-123');
  assert.strictEqual(item.from, '我的手机');
});

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake png body')]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('fake jpeg body')]);
const HEIC = Buffer.concat([Buffer.from('00000018', 'hex'), Buffer.from('ftypheic'), Buffer.from('fake heic body')]);

const upload = (name, body, type = 'application/octet-stream') =>
  fetch(`${base}/api/upload${name ? '?name=' + encodeURIComponent(name) : ''}`, {
    method: 'POST', headers: { ...auth, 'Content-Type': type }, body,
  });

test('copying an image on the computer publishes it and /api/clip serves it', async () => {
  fake.value = { image: PNG };
  await wait(80);
  const item = (await getItems()).pop();
  assert.strictEqual(item.type, 'file');
  assert.strictEqual(item.mime, 'image/png');
  assert.strictEqual(item.from, '电脑剪贴板');
  assert.match(item.name, /^电脑截图-\d{8}-\d{6}\.png$/);

  const clip = await fetch(`${base}/api/clip?token=${token}`);
  assert.strictEqual(clip.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await clip.arrayBuffer()).equals(PNG));
  // /api/latest stays text-only for existing shortcuts
  assert.strictEqual(await (await fetch(`${base}/api/latest?token=${token}`)).text(), 'from app');
});

test('the same image left on the clipboard is not published again', async () => {
  const before = (await getItems()).length;
  fake.value = { image: Buffer.from(PNG) };
  await wait(80);
  assert.strictEqual((await getItems()).length, before);
});

test('an image from the phone lands on the computer clipboard and in the save folder', async () => {
  const before = (await getItems()).length;
  const res = await upload('photo', JPEG);
  assert.strictEqual(res.status, 201);
  const item = await res.json();
  assert.strictEqual(item.name, 'photo.jpg');
  assert.strictEqual(item.mime, 'image/jpeg');
  await wait(80);
  assert.ok(fake.imageWrites.at(-1).equals(JPEG));
  assert.strictEqual((await getItems()).length, before + 1, 'clipboard write must not echo back as a new item');
  assert.ok(fs.readFileSync(path.join(saveDir, 'photo.jpg')).equals(JPEG));
});

test('saved files never overwrite each other', async () => {
  await upload('photo.jpg', JPEG);
  await wait(50);
  assert.ok(fs.existsSync(path.join(saveDir, 'photo (1).jpg')));
});

test('images without a name get a timestamped one; formats Windows cannot paste are only saved', async () => {
  const writes = fake.imageWrites.length;
  const item = await (await upload(null, HEIC)).json();
  assert.match(item.name, /^图片-\d{8}-\d{6}\.heic$/);
  assert.strictEqual(item.mime, 'image/heic');
  await wait(50);
  assert.strictEqual(fake.imageWrites.length, writes);
  assert.ok(fs.existsSync(path.join(saveDir, item.name)));
});

test('non-image files are saved but leave the clipboard alone', async () => {
  const writes = fake.imageWrites.length;
  const item = await (await upload('notes.txt', 'hello', 'text/plain')).json();
  assert.strictEqual(item.mime, 'text/plain');
  await wait(50);
  assert.strictEqual(fake.imageWrites.length, writes);
  assert.strictEqual(fs.readFileSync(path.join(saveDir, 'notes.txt'), 'utf8'), 'hello');
});

test('/api/clip returns text when text is newer than the latest image', async () => {
  await fetch(`${base}/api/text`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '最新文字' });
  const clip = await fetch(`${base}/api/clip?token=${token}`);
  assert.match(clip.headers.get('content-type'), /^text\/plain/);
  assert.strictEqual(await clip.text(), '最新文字');
});
