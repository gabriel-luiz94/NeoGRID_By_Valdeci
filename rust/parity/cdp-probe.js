'use strict';
// Diagnostico via Chrome DevTools Protocol no WebView2.
// Uso: node cdp-probe.js [port]  (app precisa rodar com
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=PORT)
const port = Number(process.argv[2]) || 9222;

const api = async (path, method = 'GET', body = null) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  return res.json();
};

async function evaluate(wsUrl, expression, awaitPromise = true) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      try {
        resolve(JSON.parse(ev.data));
      } catch (e) {
        reject(e);
      }
    };
    ws.onerror = reject;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
  });
  ws.close();
  return result;
}

async function main() {
  const targets = await api('/json/list');
  console.log('targets:', targets.map((t) => ({ title: t.title, url: t.url, type: t.type })));
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http')) || targets.find((t) => t.type === 'page');
  if (!page) {
    console.log('SEM PAGINA');
    process.exit(2);
  }
  const probes = {
    href: 'location.href',
    title: 'document.title',
    bodyLen: 'document.body ? document.body.innerText.length : -1',
    bodyText: 'document.body ? document.body.innerText.slice(0, 300) : null',
    internals: 'typeof window.__TAURI_INTERNALS__',
    tauriGlobal: 'typeof window.__TAURI__',
    scripts: '[...document.scripts].map((s) => s.src || "(inline)")',
  };
  for (const [name, expr] of Object.entries(probes)) {
    try {
      const r = await evaluate(page.webSocketDebuggerUrl, expr, false);
      console.log(name, '=>', JSON.stringify(r.result?.result?.value ?? r.result ?? r).slice(0, 400));
    } catch (e) {
      console.log(name, 'ERRO', e.message);
    }
  }
}

main().catch((e) => {
  console.error('FALHA:', e.message);
  process.exit(1);
});
