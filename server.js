#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ITEMS = 200;

function createApp(options = {}) {
  const token = options.token || crypto.randomBytes(6).toString('hex');
  const uploadDir = options.uploadDir || path.join(__dirname, 'uploads');
  const maxUploadBytes = options.maxUploadBytes || 2 * 1024 * 1024 * 1024; // 2 GB

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

  function deviceName(req) {
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
      const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString('utf8') || '{}');
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return sendJson(res, 400, { error: '内容为空' });
      const item = addItem({ id: newId(), type: 'text', text, from: deviceName(req), time: Date.now() });
      return sendJson(res, 201, item);
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
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
      out.on('finish', () => {
        if (aborted) return;
        const item = addItem({
          id,
          type: 'file',
          name,
          size,
          mime: req.headers['content-type'] || 'application/octet-stream',
          from: deviceName(req),
          time: Date.now(),
        });
        sendJson(res, 201, item);
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

  return { server, token };
}

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const { server, token } = createApp({ token: process.env.FASTCOPY_TOKEN });
  server.listen(port, '0.0.0.0', () => {
    const ips = lanAddresses();
    const urls = (ips.length ? ips : ['localhost']).map((ip) => `http://${ip}:${port}/?token=${token}`);
    console.log('\nFastCopy 已启动 🚀  手机与电脑需连接同一 Wi-Fi\n');
    urls.forEach((u) => console.log('  ' + u));
    console.log('\n用手机扫描二维码打开：\n');
    try {
      require('qrcode-terminal').generate(urls[0], { small: true });
    } catch {
      console.log('（未安装 qrcode-terminal，请手动在手机浏览器中输入上面的地址）');
    }
  });
}

module.exports = { createApp };
