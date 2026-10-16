'use strict';

// Read/write the computer's system clipboard (text only) via the platform's own tools.

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

const PS = ['-NoProfile', '-NonInteractive', '-Command'];

const windows = {
  name: 'PowerShell',
  read: () => run('powershell.exe', [...PS, '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'])
    .then((s) => s.replace(/\r?\n$/, '')),
  // Pass the text through a UTF-8 temp file: stdin and argv both mangle non-ASCII text on Windows.
  write: async (text) => {
    const file = path.join(os.tmpdir(), `fastcopy-${process.pid}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    try {
      await run('powershell.exe', [...PS, `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath '${file}')`]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
};

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

/** Returns { name, read(): Promise<string>, write(text): Promise } or null if unsupported. */
function systemClipboard() {
  if (process.platform === 'win32') return windows;
  if (process.platform === 'darwin') return mac;
  return linux();
}

module.exports = { systemClipboard };
