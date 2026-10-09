// 2ページ（親・子）を同じ Chrome で開いて操作する小さな CDP ドライバ
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
    '--window-size=820,1200', 'about:blank'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return proc; } catch (e) {}
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

class Page {
  constructor(name, info) {
    this.name = name; this.info = info; this.id = 0; this.wait = {}; this.logs = [];
  }
  async connect() {
    this.ws = new WebSocket(this.info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.wait[m.id]) { this.wait[m.id](m); delete this.wait[m.id]; }
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ');
        this.logs.push(m.params.type + ': ' + t);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      }
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => { this.wait[id] = res; });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(this.name + ' eval: ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async waitFor(expr, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) {
      try { const v = await this.eval(expr); if (v) return v; } catch (e) {}
      await sleep(250);
    }
    throw new Error(this.name + ': timeout waiting for ' + (label || expr));
  }
  async mouse(type, x, y) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
  }
  async scribble(selector) {
    const r = await this.eval(`(function(){var b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height};})()`);
    const x0 = r.x + r.w * 0.3, y0 = r.y + r.h * 0.4;
    await this.mouse('mousePressed', x0, y0);
    for (let i = 1; i <= 10; i++) await this.mouse('mouseMoved', x0 + i * 12, y0 + Math.sin(i) * 20);
    await this.mouse('mouseReleased', x0 + 120, y0);
  }
}

async function newPage(name, url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const info = await r.json();
  return new Page(name, info).connect();
}

async function closePage(page) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${page.info.id}`);
}

module.exports = { launch, newPage, closePage, sleep };
