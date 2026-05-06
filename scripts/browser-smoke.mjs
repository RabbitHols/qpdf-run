import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';

const root = resolve('.');
const chrome = process.env.CHROME_BIN || 'google-chrome';
const timeoutMs = Number(process.env.QPDF_RUN_SMOKE_TIMEOUT_MS || 30000);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/examples/browser/smoke.html' : url.pathname);
    const filePath = resolve(join(root, pathname));

    if (!isInsideRoot(filePath)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error && error.code === 'ENOENT' ? 404 : 500);
    response.end(error && error.message || String(error));
  }
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/examples/browser/smoke.html`;

  try {
    const dom = await runChrome(url);
    const result = parseSmokeResult(dom);

    if (!result.ok) {
      throw new Error(`Browser smoke failed: ${result.message || JSON.stringify(result)}`);
    }
    if (!result.firstBytes || !result.secondBytes) {
      throw new Error(`Browser smoke produced empty output: ${JSON.stringify(result)}`);
    }
    if (result.missingOutputCode !== 'QPDF_OUTPUT_MISSING') {
      throw new Error(`Browser smoke did not verify missing output errors: ${JSON.stringify(result)}`);
    }

    console.log(`browser smoke ok: ${result.firstBytes} bytes, then ${result.secondBytes} bytes; missing output => ${result.missingOutputCode}`);
  } catch (error) {
    console.error(error && error.stack || String(error));
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

function runChrome(url) {
  return new Promise((resolveChrome, rejectChrome) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      url
    ];
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      rejectChrome(new Error(`Chrome smoke timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        inspectPage(match[1], url, child)
          .then(resolveChrome, rejectChrome)
          .finally(() => {
            child.kill('SIGTERM');
          });
      }
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectChrome(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectChrome(new Error(`Chrome exited before DevTools was ready with ${code}\n${stderr}`));
    });
  });
}

async function inspectPage(browserWsUrl, pageUrl, child) {
  const browserUrl = new URL(browserWsUrl);
  const listUrl = `http://${browserUrl.host}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let page;

  while (Date.now() < deadline) {
    const targets = await fetchJson(listUrl);
    page = targets.find(target => target.type === 'page' && target.url === pageUrl);
    if (page) break;
    await delay(100);
  }

  if (!page) {
    throw new Error('Unable to find Chrome page target for smoke test.');
  }

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Chrome exited during smoke test with ${child.exitCode}`);
      }

      const response = await cdp.send('Runtime.evaluate', {
        expression: 'window.qpdfRunSmokeResult || null',
        returnByValue: true,
        awaitPromise: false
      });
      const value = response.result && response.result.result && response.result.result.value;
      if (value) return JSON.stringify(value);
      await delay(100);
    }

    throw new Error(`Smoke result was not published within ${timeoutMs}ms.`);
  } finally {
    cdp.close();
  }
}

function parseSmokeResult(json) {
  return JSON.parse(json);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return await response.json();
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function connectCdp(wsUrl) {
  return new Promise((resolveConnection, rejectConnection) => {
    const url = new URL(wsUrl);
    const key = randomBytes(16).toString('base64');
    const socket = connect(Number(url.port), url.hostname);
    let handshake = '';
    let buffer = Buffer.alloc(0);
    let connected = false;
    let nextId = 1;
    const pending = new Map();

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n'));
    });
    socket.on('data', chunk => {
      if (!connected) {
        handshake += chunk.toString('binary');
        const headerEnd = handshake.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = handshake.slice(0, headerEnd);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          rejectConnection(new Error(`CDP websocket handshake failed:\n${header}`));
          socket.destroy();
          return;
        }
        validateAcceptHeader(header, key);
        connected = true;
        buffer = Buffer.from(handshake.slice(headerEnd + 4), 'binary');
        resolveConnection(api);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
      readFrames();
    });
    socket.on('error', error => {
      if (!connected) rejectConnection(error);
      pending.forEach(entry => entry.reject(error));
      pending.clear();
    });
    socket.on('close', () => {
      const error = new Error('CDP websocket closed.');
      pending.forEach(entry => entry.reject(error));
      pending.clear();
    });

    const api = {
      send(method, params) {
        const id = nextId++;
        const payload = JSON.stringify({ id, method, params });
        socket.write(encodeFrame(payload));
        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
        });
      },
      close() {
        socket.end();
      }
    };

    function readFrames() {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const high = buffer.readUInt32BE(2);
          const low = buffer.readUInt32BE(6);
          length = high * 2 ** 32 + low;
          offset = 10;
        }

        const masked = Boolean(second & 0x80);
        const maskOffset = masked ? 4 : 0;
        if (buffer.length < offset + maskOffset + length) return;

        let payload = buffer.slice(offset + maskOffset, offset + maskOffset + length);
        if (masked) {
          const mask = buffer.slice(offset, offset + 4);
          payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
        }
        buffer = buffer.slice(offset + maskOffset + length);

        const opcode = first & 0x0f;
        if (opcode === 1) handleMessage(payload.toString('utf8'));
        if (opcode === 8) socket.end();
      }
    }

    function handleMessage(message) {
      const parsed = JSON.parse(message);
      if (!parsed.id) return;
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.error) {
        entry.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
      } else {
        entry.resolve(parsed);
      }
    }
  });
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  const mask = randomBytes(4);
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }

  const masked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function validateAcceptHeader(header, key) {
  const expected = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const match = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im);
  if (!match || match[1].trim() !== expected) {
    throw new Error('CDP websocket accept header was invalid.');
  }
}

function isInsideRoot(filePath) {
  const relative = normalize(filePath).slice(root.length);
  return filePath === root || relative.startsWith(sep);
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}
