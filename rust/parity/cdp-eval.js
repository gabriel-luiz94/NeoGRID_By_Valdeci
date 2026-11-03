'use strict';
// Sonda estado JS da pagina: __neo, desktop, erros.
const port = Number(process.argv[2]) || 9224;
const exprs = process.argv.slice(3);
if (!exprs.length) {
  exprs.push(
    'location.href',
    'typeof window.__neo',
    'typeof window.desktop',
    'JSON.stringify(Object.keys(window.desktop || {}))',
    'document.querySelectorAll("canvas").length',
  );
}
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /tauri|localhost|app:\/\//.test(t.url)) || list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await send('Runtime.enable');
  for (const expr of exprs) {
    const wrapped = /await|return/.test(expr) ? `(async () => { ${expr} })()` : expr;
    const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true });
    const v = r.result?.result?.value;
    const ex = r.result?.exceptionDetails;
    console.log(JSON.stringify(expr), '=>', ex ? ('EXC ' + JSON.stringify(ex.text || ex).slice(0, 200)) : JSON.stringify(v)?.slice(0, 300));
  }
  ws.close();
}
main().catch((e) => {
  console.error('FALHA:', e.message);
  process.exit(1);
});
