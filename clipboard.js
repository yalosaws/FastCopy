'use strict';

// Read/write the computer's system clipboard via the platform's own tools.
// Text everywhere; images too on Windows (read() then resolves to { image: Buffer } instead of a string).

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const env = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 5000, windowsHide: true, env },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

// Writers like xclip/wl-copy fork a background process that owns the clipboard and keeps
// inherited pipes open, so wait for the command itself to exit rather than for its output to close.
function pipeTo(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function hasCommand(cmd) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// One long-lived PowerShell process answers one-line commands, so polling doesn't start a new
// PowerShell every tick. Everything crossing the pipe is base64, which sidesteps console encodings.
// The clipboard sequence number lets "read" skip re-encoding an image that hasn't changed.
const WINDOWS_HELPER = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace FastCopy -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
$utf8 = New-Object System.Text.UTF8Encoding $false
$last = -1
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $cmd, $arg = $line.Split(' ', 2)
    if ($cmd -eq 'read') {
      $seq = [FastCopy.Native]::GetClipboardSequenceNumber()
      if ($seq -eq $last) {
        $out = '{"same":true}'
      } elseif ([Windows.Forms.Clipboard]::ContainsText()) {
        $out = '{"text":"' + [Convert]::ToBase64String($utf8.GetBytes([Windows.Forms.Clipboard]::GetText())) + '"}'
        $last = $seq
      } elseif ([Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [Windows.Forms.Clipboard]::GetImage()
        $ms = New-Object IO.MemoryStream
        $img.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
        $img.Dispose()
        $out = '{"image":"' + [Convert]::ToBase64String($ms.ToArray()) + '"}'
        $last = $seq
      } else {
        $out = '{"text":""}'
        $last = $seq
      }
    } elseif ($cmd -eq 'text') {
      [Windows.Forms.Clipboard]::SetText($utf8.GetString([Convert]::FromBase64String($arg)))
      $last = [FastCopy.Native]::GetClipboardSequenceNumber()
      $out = '{"ok":true}'
    } elseif ($cmd -eq 'image') {
      $bytes = [IO.File]::ReadAllBytes($utf8.GetString([Convert]::FromBase64String($arg)))
      $img = [Drawing.Image]::FromStream((New-Object IO.MemoryStream (,$bytes)))
      [Windows.Forms.Clipboard]::SetImage($img)
      $img.Dispose()
      $last = [FastCopy.Native]::GetClipboardSequenceNumber()
      $out = '{"ok":true}'
    } else {
      $out = '{"error":"unknown command"}'
    }
  } catch {
    $out = '{"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}'
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`;

function windowsClipboard() {
  let child = null;
  let pending = []; // resolvers waiting for a reply line, oldest first
  let current; // what the clipboard held at the last read or write: string or { image }

  function start() {
    const encoded = Buffer.from(WINDOWS_HELPER, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const proc = child;
    let buf = '';
    proc.stdout.setEncoding('ascii');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const next = pending.shift();
        if (next) next.resolve(line);
      }
    });
    const fail = () => {
      if (child === proc) child = null;
      for (const p of pending.splice(0)) p.reject(new Error('剪贴板助手进程已退出'));
    };
    proc.on('exit', fail);
    proc.on('error', fail);
    proc.stdin.on('error', () => {});
  }

  async function send(line) {
    if (!child) start();
    const proc = child;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('剪贴板助手无响应'));
        proc.kill(); // pending replies are now out of step; the next call starts a fresh helper
      }, 15000);
      pending.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin.write(line + '\n');
    });
    const msg = JSON.parse(reply);
    if (msg.error) throw new Error(msg.error);
    return msg;
  }

  return {
    name: 'PowerShell',
    read: async () => {
      const msg = await send('read');
      if (msg.same) return current;
      current = msg.image ? { image: Buffer.from(msg.image, 'base64') } : Buffer.from(msg.text, 'base64').toString('utf8');
      return current;
    },
    write: async (text) => {
      await send('text ' + Buffer.from(text, 'utf8').toString('base64'));
      current = text;
    },
    writeImage: async (data) => {
      const file = path.join(os.tmpdir(), `fastcopy-${process.pid}-${Date.now()}.img`);
      fs.writeFileSync(file, data);
      try {
        await send('image ' + Buffer.from(file, 'utf8').toString('base64'));
        current = { image: data };
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    close: () => {
      if (child) child.kill();
    },
  };
}

const mac = {
  name: 'pbcopy/pbpaste',
  read: () => run('pbpaste', []),
  write: (text) => pipeTo('pbcopy', [], text),
};

function linux() {
  if (process.env.WAYLAND_DISPLAY && hasCommand('wl-paste') && hasCommand('wl-copy')) {
    return {
      name: 'wl-clipboard',
      read: () => run('wl-paste', ['--no-newline', '--type', 'text']).catch(() => ''),
      write: (text) => pipeTo('wl-copy', [], text),
    };
  }
  if (hasCommand('xclip')) {
    return {
      name: 'xclip',
      read: () => run('xclip', ['-selection', 'clipboard', '-o']).catch(() => ''),
      write: (text) => pipeTo('xclip', ['-selection', 'clipboard', '-i'], text),
    };
  }
  if (hasCommand('xsel')) {
    return {
      name: 'xsel',
      read: () => run('xsel', ['--clipboard', '--output']).catch(() => ''),
      write: (text) => pipeTo('xsel', ['--clipboard', '--input'], text),
    };
  }
  return null;
}

/**
 * Returns { name, read(), write(text), writeImage?(buffer), close?() } or null if unsupported.
 * read() resolves to the clipboard text, or to { image: Buffer } (PNG) where images are supported.
 */
function systemClipboard() {
  if (process.platform === 'win32') return windowsClipboard();
  if (process.platform === 'darwin') return mac;
  return linux();
}

module.exports = { systemClipboard };
