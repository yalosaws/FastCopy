#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { systemClipboard } = require('./clipboard');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ITEMS = 200;
const MAX_CLIPBOARD_IMAGE = 50 * 1024 * 1024;

// Identify an image by its magic bytes; the phone's declared type and file name are often generic.
function sniffImage(head) {
  const ascii = (a, b) => head.toString('latin1', a, b);
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', ext: '.png', clipboard: true };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg', clipboard: true };
  if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', ext: '.gif', clipboard: true };
  if (ascii(0, 2) === 'BM') return { mime: 'image/bmp', ext: '.bmp', clipboard: true };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp', clipboard: false };
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(ascii(8, 12))) return { mime: 'image/heic', ext: '.heic', clipboard: false };
  return null;
}

const SAME_EXT = { '.jpeg': '.jpg', '.jpe': '.jpg', '.heif': '.heic' };

function imageName(name, image, provided) {
  if (!provided) return `图片-${timestamp()}${image.ext}`;
  const ext = path.extname(name).toLowerCase();
  if ((SAME_EXT[ext] || ext) === image.ext) return name;
  return path.basename(name, path.extname(name)) + image.ext;
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// Copy to dir under name, adding " (1)", " (2)"... instead of overwriting an existing file.
async function saveCopy(src, dir, name) {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 0; ; n++) {
    const dest = path.join(dir, n ? `${stem} (${n})${ext}` : name);
    try {
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function createApp(options = {}) {
  const token = options.token || crypto.randomBytes(6).toString('hex');
  const uploadDir = options.uploadDir || path.join(__dirname, 'uploads');
  const maxUploadBytes = options.maxUploadBytes || 2 * 1024 * 1024 * 1024; // 2 GB
  // { read(), write(text), writeImage?(buf) } for the computer's clipboard, or null to disable syncing.
  const clipboard = options.clipboard === undefined ? systemClipboard() : options.clipboard;
  const clipboardInterval = options.clipboardInterval || 800;
  // Files sent from other devices are also copied here (null = don't keep copies).
  const saveDir = options.saveDir || null;
  const isLocalRequest = options.isLocalRequest || fromThisComputer;

  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const items = []; // newest last
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function addItem(item) {
    items.push(item);
    while (items.length > MAX_ITEMS) removeItem(items[0].id);
    broadcast('add', item);
    return item;
  }

  function removeItem(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i === -1) return false;
    const [item] = items.splice(i, 1);
    if (item.type === 'file') fs.rm(path.join(uploadDir, item.id), { force: true }, () => {});
    broadcast('remove', { id });
    return true;
  }

  function newId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  }

  // --- Computer clipboard sync -------------------------------------------
  // Copying text or an image on the computer adds an item; text and images sent from any device
  // land on the computer's clipboard.
  let lastClip = null; // key of the last clipboard content we saw or wrote, so we don't echo our own writes
  let polling = false;
  let clipTimer = null;

  const clipKey = (clip) => (typeof clip === 'string' ? 'text:' + clip : 'image:' + sha1(clip.image));

  async function pollClipboard() {
    if (polling) return;
    polling = true;
    try {
      const clip = await clipboard.read();
      if (clip == null) return;
      const key = clipKey(clip);
      if (lastClip === null) {
        lastClip = key; // don't publish whatever happened to be on the clipboard at startup
      } else if (key !== lastClip) {
        lastClip = key;
        if (typeof clip === 'string') {
          const latest = latestText();
          if (clip.trim() && (!latest || latest.text !== clip)) {
            addItem({ id: newId(), type: 'text', text: clip, from: '电脑剪贴板', time: Date.now() });
          }
        } else if (clip.image.length) {
          const id = newId();
          await fs.promises.writeFile(path.join(uploadDir, id), clip.image);
          addItem({
            id, type: 'file', name: `电脑截图-${timestamp()}.png`, size: clip.image.length, mime: 'image/png',
            from: '电脑剪贴板', time: Date.now(),
          });
        }
      }
    } catch {
      // Clipboard temporarily unavailable (locked by another app, ...): try again next tick.
    } finally {
      polling = false;
    }
  }

  function writeClipboard(text) {
    if (!clipboard) return;
    lastClip = clipKey(text);
    clipboard.write(text).catch((err) => console.error('写入电脑剪贴板失败：', err.message));
  }

  function writeClipboardImage(data) {
    if (!clipboard || !clipboard.writeImage) return;
    lastClip = clipKey({ image: data });
    clipboard.writeImage(data).catch((err) => console.error('图片写入电脑剪贴板失败：', err.message));
  }

  // Requests from the computer's own browser shouldn't be copied back onto its clipboard or into saveDir.
  function fromThisComputer(req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1' || Object.values(os.networkInterfaces()).flat().some((a) => a && a.address === ip);
  }

  // A device sent a file: fix up image names/types, put images on the computer's clipboard, keep a copy.
  async function receivedFile(item, req, nameProvided) {
    const file = path.join(uploadDir, item.id);
    const fh = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(16);
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    const image = sniffImage(head);
    if (image) {
      item.mime = image.mime;
      item.name = imageName(item.name, image, nameProvided);
    }
    if (isLocalRequest(req)) return;
    if (image && image.clipboard && item.size <= MAX_CLIPBOARD_IMAGE) {
      writeClipboardImage(await fs.promises.readFile(file));
    }
    if (saveDir) {
      saveCopy(file, saveDir, item.name).catch((err) => console.error('保存文件失败：', err.message));
    }
  }

  if (clipboard) {
    clipTimer = setInterval(pollClipboard, clipboardInterval);
    pollClipboard();
  }

  function latestText() {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'text') return items[i];
    return null;
  }

  // Newest text or image, whichever came last: what a phone shortcut should put on its clipboard.
  function latestClip() {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'text' || (it.type === 'file' && it.mime.startsWith('image/'))) return it;
    }
    return null;
  }

  // Optional id a client sends with its writes, so it can recognise (and skip) its own items.
  function clientId(req) {
    const id = String(req.headers['x-fastcopy-client'] || '');
    return /^[\w-]{1,64}$/.test(id) ? id : undefined;
  }

  function deviceName(req) {
    const named = String(req.headers['x-fastcopy-device'] || '').trim();
    if (named) {
      try {
        return decodeURIComponent(named).slice(0, 40);
      } catch {
        // malformed encoding: fall back to the user agent
      }
    }
    const ua = req.headers['user-agent'] || '';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Linux';
    return '设备';
  }

  function authorized(req, url) {
    if (url.searchParams.get('token') === token) return true;
    const cookie = req.headers.cookie || '';
    return cookie.split(';').some((c) => c.trim() === `fc_token=${token}`);
  }

  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('请求体过大'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serveStatic(res, file) {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
    fs.readFile(full, (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': (types[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(buf);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (!authorized(req, url)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta name="viewport" content="width=device-width"><p>访问被拒绝：请扫描电脑终端上显示的二维码打开。</p>');
    }

    if (req.method === 'GET' && pathname === '/') {
      // Remember the token so later requests (and bookmarks without it) keep working.
      res.setHeader('Set-Cookie', `fc_token=${token}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`);
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      return serveStatic(res, pathname.slice('/static/'.length));
    }

    if (req.method === 'GET' && pathname === '/api/items') {
      return sendJson(res, 200, items);
    }

    if (req.method === 'GET' && pathname === '/api/info') {
      return sendJson(res, 200, { clipboardSync: Boolean(clipboard) });
    }

    // Plain-text latest item: for phone shortcuts (iOS Shortcuts, Android HTTP Shortcuts, curl...).
    if (req.method === 'GET' && pathname === '/api/latest') {
      const item = latestText();
      if (!item) return res.writeHead(204).end();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(item.text);
    }

    // Like /api/latest, but returns the image itself when an image is newer than the latest text.
    if (req.method === 'GET' && pathname === '/api/clip') {
      const item = latestClip();
      if (!item) return res.writeHead(204).end();
      if (item.type === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(item.text);
      }
      res.writeHead(200, {
        'Content-Type': item.mime,
        'Content-Length': item.size,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(path.join(uploadDir, item.id)).pipe(res);
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify(items)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/text') {
      const raw = (await readBody(req, 5 * 1024 * 1024)).toString('utf8');
      let text = raw; // plain-text bodies are accepted too, which keeps phone shortcuts simple
      if (/json/.test(req.headers['content-type'] || '')) {
        const body = JSON.parse(raw || '{}');
        text = typeof body.text === 'string' ? body.text : '';
      }
      if (!text.trim()) return sendJson(res, 400, { error: '内容为空' });
      const item = addItem({ id: newId(), type: 'text', text, from: deviceName(req), client: clientId(req), time: Date.now() });
      writeClipboard(text);
      return sendJson(res, 201, item);
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      const nameProvided = Boolean(path.basename(url.searchParams.get('name') || ''));
      const name = path.basename(url.searchParams.get('name') || 'file').slice(0, 255) || 'file';
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxUploadBytes) return sendJson(res, 413, { error: '文件过大' });

      const id = newId();
      const dest = path.join(uploadDir, id);
      const out = fs.createWriteStream(dest);
      let size = 0;
      let aborted = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxUploadBytes && !aborted) {
          aborted = true;
          req.unpipe(out);
          out.destroy();
          fs.rm(dest, { force: true }, () => {});
          sendJson(res, 413, { error: '文件过大' });
        }
      });
      req.on('aborted', () => {
        aborted = true;
        out.destroy();
        fs.rm(dest, { force: true }, () => {});
      });
      out.on('finish', async () => {
        if (aborted) return;
        const item = {
          id,
          type: 'file',
          name,
          size,
          mime: req.headers['content-type'] || 'application/octet-stream',
          from: deviceName(req),
          client: clientId(req),
          time: Date.now(),
        };
        try {
          await receivedFile(item, req, nameProvided);
        } catch (err) {
          console.error('处理上传文件失败：', err.message);
        }
        sendJson(res, 201, addItem(item));
      });
      req.pipe(out);
      return;
    }

    const fileMatch = pathname.match(/^\/files\/([a-z0-9]+)$/);
    if (req.method === 'GET' && fileMatch) {
      const item = items.find((it) => it.id === fileMatch[1] && it.type === 'file');
      if (!item) return sendJson(res, 404, { error: '文件不存在' });
      const inline = url.searchParams.has('inline');
      res.writeHead(200, {
        'Content-Type': item.mime,
        'Content-Length': item.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(path.join(uploadDir, item.id)).pipe(res);
    }

    const delMatch = pathname.match(/^\/api\/items\/([a-z0-9]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      return removeItem(delMatch[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: '不存在' });
    }
    if (req.method === 'DELETE' && pathname === '/api/items') {
      for (const it of [...items]) removeItem(it.id);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, err.status || 400, { error: err.message });
    });
  });

  server.on('close', () => {
    clearInterval(clipTimer);
    if (clipboard && clipboard.close) clipboard.close();
  });

  return { server, token, clipboardSync: Boolean(clipboard), clipboardImages: Boolean(clipboard && clipboard.writeImage) };
}

// Keep the token across restarts so bookmarks and phone shortcuts keep working.
function loadToken() {
  if (process.env.FASTCOPY_TOKEN) return process.env.FASTCOPY_TOKEN;
  const file = path.join(os.homedir(), '.fastcopy', 'token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const token = crypto.randomBytes(6).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch {}
  return token;
}

// Lower rank = more likely to be the Wi-Fi address a phone can reach.
function addressRank(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

// 198.18.0.0/15 is used by proxy TUN adapters (Clash / mihomo fake-ip), unreachable from the phone.
function isProxyAddress(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

function lanAddresses(interfaces = os.networkInterfaces()) {
  const result = [];
  for (const list of Object.values(interfaces)) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal && !isProxyAddress(addr.address)) result.push(addr.address);
    }
  }
  // Stable sort keeps interface order within the same rank.
  return result.sort((x, y) => addressRank(x) - addressRank(y));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const noClipboard = process.env.FASTCOPY_CLIPBOARD === '0';
  const saveEnv = process.env.FASTCOPY_SAVE_DIR;
  const saveDir = saveEnv === '0' ? null : saveEnv || path.join(os.homedir(), 'Downloads', 'FastCopy');
  const { server, token, clipboardSync, clipboardImages } = createApp({ token: loadToken(), clipboard: noClipboard ? null : undefined, saveDir });
  server.listen(port, '0.0.0.0', () => {
    const ips = lanAddresses();
    const urls = (ips.length ? ips : ['localhost']).map((ip) => `http://${ip}:${port}/?token=${token}`);
    console.log('\nFastCopy 已启动 🚀  手机与电脑需连接同一 Wi-Fi\n');
    urls.forEach((u) => console.log('  ' + u));
    if (clipboardSync) {
      const what = clipboardImages ? '文字和图片' : '文字';
      console.log(`\n📋 电脑剪贴板同步已开启：电脑上复制的${what}会自动出现在手机上，手机发来的${what}会自动进入电脑剪贴板`);
    } else if (!noClipboard) {
      console.log('\n⚠️  未找到剪贴板工具，剪贴板同步未开启（Linux 请安装 xclip 或 wl-clipboard）');
    }
    if (saveDir) console.log(`\n📁 手机发来的文件会另存到：${saveDir}`);
    console.log('\n手机快捷指令地址：');
    console.log(`  获取最新文字或图片：${urls[0].replace('/?token=', '/api/clip?token=')}`);
    console.log(`  发送文字到电脑（POST）：${urls[0].replace('/?token=', '/api/text?token=')}`);
    console.log(`  发送图片/文件到电脑（POST）：${urls[0].replace('/?token=', '/api/upload?token=')}`);
    console.log('\n用手机扫描二维码打开：\n');
    try {
      require('qrcode-terminal').generate(urls[0], { small: true });
    } catch {
      console.log('（未安装 qrcode-terminal，请手动在手机浏览器中输入上面的地址）');
    }
  });
}

module.exports = { createApp, lanAddresses };
