/* Consulta por expressão e SQL (origem: CTWeb, adaptada ao NeoGrid). */
function csvTexto(cols, rows) {
  const q = v => { v = v == null ? '' : String(v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return '\uFEFF' + cols.map(q).join(';') + '\n' + rows.map(r => r.map(q).join(';')).join('\n') + '\n';
}
function tabelaRes(cols, rows, onclick) {
  const max = 300;
  return mk('div', {class: 'qs', style: 'max-height:300px'}, mk('table', {class: 'qt'}, mk('tr', null, ...cols.map(c => mk('th', null, c))),
    ...rows.slice(0, max).map((r, k) => mk('tr', onclick ? {class: 'clk', onclick: () => onclick(k)} : null, ...r.map(v => mk('td', null, v == null ? '' : String(v)))))),
    rows.length > max ? mk('small', null, `Mostrando ${max} de ${nBR(rows.length)} linhas. Exporte o CSV para ver tudo.`) : '');
}
async function abrirConsulta() {
  const dlg = $('#cons'), c = $('#cons-c'); c.replaceChildren();
  const ts = window.NG.camadas();
  if (!ts.length) { alert('Não há dados carregados para consultar.'); return; }
  const aba = {v: 'f'};
  const tabs = mk('div', {class: 'sub'}), corpo = mk('div');
  const render = () => {
    tabs.replaceChildren(...[['f', 'Filtro por expressão'], ['s', 'SQL (banco)']].map(([k, l]) => mk('button', {class: aba.v === k ? 'on' : '', onclick: () => { aba.v = k; render(); }}, l)));
    corpo.replaceChildren(); (aba.v === 'f' ? consultaFiltro : consultaSQL)(corpo, ts);
  };
  c.append(mk('h3', {style: 'margin-top:0'}, 'Consultar dados'), tabs, corpo); render();
  dlg.hidden = false;
}
function consultaFiltro(box, ts) {
  const sc = mk('select', null, ...ts.map(t => mk('option', {value: t}, NOME[t])));
  const regs = ['', ...window.NG.regionais()];
  const sr = mk('select', null, ...regs.map(r => mk('option', {value: r}, r || '(todas as regionais)')));
  const ex = mk('textarea', {rows: 3, class: 'mono', placeholder: `"ALIM" = 'ALM12' AND to_real("NU_ALTURA") >= 11`});
  const cols = mk('input', {type: 'text', placeholder: 'Colunas a mostrar, separadas por vírgula (vazio = principais)'});
  const vis = mk('input', {type: 'checkbox'}); vis.checked = false;
  const lim = mk('input', {type: 'number', value: 200000, min: 100, step: 10000});
  const st = mk('div', {class: 'mut'}), res = mk('div');
  let atual = null;
  const rodar = async () => {
    const t = sc.value, src = ex.value.trim(); res.replaceChildren(); st.textContent = 'Consultando...';
    let comp = null; if (src) { comp = Expr.compile(src); if (comp.err) { st.textContent = 'Expressão inválida: ' + comp.err; return; } }
    try {
      let d, ordem = null;
      const j = await window.NG.lerCamada(t, vis.checked ? map.getBounds() : null, +lim.value || 200000, sr.value);
      d = montarDS(t, j.h, j.rows, false);
      if (j.corte) st.textContent = `Atenção: lidas só as primeiras ${nBR(j.n)} linhas (aumente o limite). `;
      const idx = [], teste = () => { for (let i = 0; i < d.rows.length; i++) { if (!comp || truthy(ev(src, t, i))) idx.push(i); } };
      comD({[t]: d}, teste);
      const nomes = cols.value.trim() ? cols.value.split(',').map(s => s.trim().toUpperCase()).filter(n => d.hi.has(n)) : d.sel.map(j => d.h[j]);
      const js = nomes.map(n => d.hi.get(n));
      const linhas = idx.map(i => js.map(j => d.rows[i][j]));
      atual = {t, d, idx, nomes, linhas};
      st.textContent += `${nBR(idx.length)} de ${nBR(d.rows.length)} linhas lidas atendem ao filtro.`;
      res.replaceChildren(
        tabelaRes(nomes, linhas, k => { const i = idx[k], x = d.X[i], y = d.Y[i]; if (isFinite(x)) window.NG.focar(y, x); }),
        mk('div', {style: 'display:flex;gap:6px;margin-top:6px'},
          mk('button', {onclick: () => baixar('consulta_' + t + '.csv', csvTexto(nomes, linhas), 'text/csv;charset=utf-8')}, 'Exportar CSV'),
          mk('button', {onclick: () => destacar(atual)}, 'Mostrar no mapa')));
    } catch (e) { st.textContent = 'Falha: ' + e.message; }
  };
  box.append(fr('Camada', sc), regs.length > 1 ? fr('Regional', sr) : '', fr('Filtro (expressão)', ex), fr('Colunas', cols),
    fr('Somente a área visível', vis), fr('Máx. de linhas lidas', lim),
    mk('div', {class: 'hint'}, 'Mesma linguagem dos rótulos: "CAMPO", comparações, AND/OR, LIKE, regexp_match(), to_real()... Vazio = todas as linhas.'),
    mk('button', {class: 'p', onclick: rodar}, 'Consultar'), st, res);
}
function destacar(r) {
  achado.clearLayers(); const pts = [];
  const { t, d } = r, lin = LINHA(t);
  for (const i of r.idx.slice(0, 3000)) {
    if (lin) { for (const ring of geo(d, i)) { L.polyline(ring, {color: '#e11d8f', weight: 4, interactive: false}).addTo(achado); pts.push(ring[0]); } }
    else if (isFinite(d.X[i])) { L.circleMarker([d.Y[i], d.X[i]], {radius: 9, color: '#fff', weight: 2, fillColor: '#e11d8f', fillOpacity: .7, interactive: false}).addTo(achado); pts.push([d.Y[i], d.X[i]]); }
  }
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.2), {maxZoom: 19});
  $('#st').textContent = nBR(Math.min(3000, r.idx.length)) + ' elemento(s) destacado(s)' + (r.idx.length > 3000 ? ' (de ' + nBR(r.idx.length) + ')' : '');
}
function consultaSQL(box) {
  if (!window.NG.temBanco()) { box.append(mk('p', {class: 'hint'}, 'A consulta SQL usa a base SQLite. Abra uma base em Importar → Base completa em SQLite.')); return; }
  const views = window.NG.camadas().map(t => 'v_' + t);
  const ta = mk('textarea', {rows: 5, class: 'mono'}); ta.value = "select REGIONAL, count(*) as n\nfrom v_poste\ngroup by REGIONAL\norder by n desc";
  const st = mk('div', {class: 'mut'}), res = mk('div');
  const rodar = async () => {
    st.textContent = 'Executando...'; res.replaceChildren();
    try {
      const j = await window.NG.sql(ta.value, 20000);
      st.textContent = `${nBR(j.rows.length)} linha(s)` + (j.corte ? ' (cortado em 20.000)' : '');
      res.replaceChildren(tabelaRes(j.cols, j.rows), mk('button', {style: 'margin-top:6px', onclick: () => baixar('consulta.csv', csvTexto(j.cols, j.rows), 'text/csv;charset=utf-8')}, 'Exportar CSV'));
    } catch (e) { st.textContent = 'Erro: ' + e.message; }
  };
  box.append(mk('p', {class: 'hint'}, 'Somente leitura (SELECT), limite de 60 segundos. Tabelas amigáveis: ' + views.join(' · ') + '. A coluna WKT da geometria sai descompactada.'), ta, mk('button', {class: 'p', onclick: rodar}, 'Executar'), st, res);
}
