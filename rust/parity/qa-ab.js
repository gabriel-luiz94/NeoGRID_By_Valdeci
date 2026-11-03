'use strict';
// QA A/B: mesmo cenário via CDP no Electron e no Tauri.
// Uso: node qa-ab.js --port <cdp> --db <sqlite> --out <dir> --tag <nome> [--url <navegar-para>]
// Cenário: ?test=1 -> __neo.openDatabase -> summary -> views -> screenshots.
// Relata erros de console, estado do app e salva PNGs para revisão humana.
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const PORT = Number(args.port || 9333);
const DB = (args.db || '').replace(/\\/g, '/');
const OUT = args.out || '.';
const TAG = args.tag || 'shell';
const NAV_URL = args.url || null;

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error('ws: ' + (e.message || e)));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { tag: TAG, errors: [], checks: {}, screenshots: [] };

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('sem pagina no CDP');
  // Prefere a página do app (não devtools)
  const page = pages.find((t) => /tauri|localhost|app:\/\//.test(t.url)) || pages[0];
  console.log(`[${TAG}] pagina: ${page.url}`);

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Log.enable');
  await cdp.send('Runtime.enable');

  // `--url` opcional; sem ele, navega no próprio app para `?test=1`
  // (a porta do servidor embutido é efêmera).
  let target = NAV_URL;
  if (!target) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: 'location.origin',
      returnByValue: true,
    });
    const origin = probe.result?.value;
    if (!/^https?:/.test(origin || '')) throw new Error(`origem inesperada: ${origin}`);
    target = `${origin}/index.html?test=1`;
  }
  await cdp.send('Page.navigate', { url: target });

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '?').slice(0, 300));
    }
    return r.result?.value;
  };

  // Espera o harness de teste do app
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      ready = await evaluate('!!(window.__neo && window.__neo.ready)', false);
    } catch { /* ainda carregando */ }
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('__neo nunca ficou pronto');
  report.checks.ready = true;

  const step = async (name, expression) => {
    try {
      const value = await evaluate(expression);
      report.checks[name] = value;
      console.log(`[${TAG}] ${name} = ${JSON.stringify(value).slice(0, 160)}`);
      return value;
    } catch (e) {
      report.checks[name] = { error: e.message };
      console.log(`[${TAG}] ${name} ERRO ${e.message.slice(0, 160)}`);
      return null;
    }
  };

  const shot = async (name) => {
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${TAG}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
    report.screenshots.push(file);
    console.log(`[${TAG}] shot ${file}`);
  };

  await step('summary_before', 'window.__neo.getSummary()');
  await step('open', `(async () => { await window.__neo.openDatabase(${JSON.stringify(DB)}); return window.__neo.getSummary(); })()`);
  await sleep(1500);
  await step('summary_after', 'window.__neo.getSummary()');
  await step('dom_counts', `({
    canvas: document.querySelectorAll('canvas').length,
    sidebar: (document.querySelector('#sidebarLayers') || { textContent: '' }).textContent.slice(0, 120),
    status: (document.querySelector('#statusText') || { textContent: '' }).textContent.slice(0, 120),
  })`);
  await shot('01-map');
  await step('goto_exports', `window.__neo.setView('exports'); document.querySelector('[data-view="exports"]') ? 'ok' : 'sem-botao'`);
  await sleep(800);
  await shot('02-exports');
  await step('goto_settings', `window.__neo.setView('settings'); 'ok'`);
  await sleep(800);
  await shot('03-settings');
  await step('back_map', `window.__neo.setView('map'); 'ok'`);
  await sleep(800);

  for (const ev of cdp.events) {
    if (ev.method === 'Log.entryAdded') {
      const e = ev.params.entry;
      if ((e.level === 'error' || e.level === 'warning') && !/favicon\.ico/.test(e.url || '')) {
        report.errors.push({ level: e.level, text: (e.text || '').slice(0, 300), url: e.url });
      }
    } else if (ev.method === 'Runtime.exceptionThrown') {
      report.errors.push({ level: 'exception', text: JSON.stringify(ev.params.exceptionDetails).slice(0, 300) });
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      report.errors.push({ level: 'console.error', text: JSON.stringify(ev.params.args).slice(0, 300) });
    }
  }
  cdp.close();

  const file = path.join(OUT, `${TAG}-report.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[${TAG}] erros console: ${report.errors.length} -> ${file}`);
}

main().catch((e) => {
  console.error('QA FALHOU:', e.message);
  process.exit(1);
});
