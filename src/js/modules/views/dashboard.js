import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { LAYER_META } from '../../data/schema.js';
import { fmtInt, fmtKm, fmtNum, timeAgo, esc } from '../../core/format.js';
import { icon } from '../../core/dom.js';

const els = {};

function kpi({ label, value, sub, color, iconName, share }) {
  return `
    <article class="kpi-card" style="--kpi-c:${color}">
      <div class="kpi-head">
        <span class="kpi-icon">${icon(iconName)}</span>
        <span class="kpi-label">${label}</span>
      </div>
      <strong>${value}</strong>
      <div class="kpi-foot"><span class="kpi-dot"></span>${sub}</div>
      ${Number.isFinite(share) ? `<div class="kpi-share-bar"><i style="width:${Math.max(0, Math.min(100, share))}%"></i></div>` : ''}
    </article>`;
}

function chartEmpty(message) {
  return `<div class="chart-empty"><span>${message}</span></div>`;
}

function renderKpis(summary) {
  const total = summary.totalRows || 1;
  const poste = summary.layers.poste.count;
  const inst = summary.layers.inst.count;
  const segments = summary.layers.bt.count + summary.layers.mt.count;
  els.kpis.innerHTML = [
    kpi({
      label: 'Postes',
      value: fmtInt(poste),
      sub: `${fmtNum((poste / total) * 100)}% da base · ${fmtInt(summary.layers.poste.missing)} sem coordenada`,
      color: LAYER_META.poste.color,
      iconName: 'pin',
      share: (poste / total) * 100,
    }),
    kpi({
      label: 'Instalações',
      value: fmtInt(inst),
      sub: `${fmtNum((inst / total) * 100)}% da base · equipamentos e chaves`,
      color: LAYER_META.inst.color,
      iconName: 'grid',
      share: (inst / total) * 100,
    }),
    kpi({
      label: 'Extensão de rede',
      value: fmtKm(summary.totalLength),
      sub: `BT ${fmtKm(summary.lengthBt)} · MT ${fmtKm(summary.lengthMt)}`,
      color: LAYER_META.bt.color,
      iconName: 'ruler',
    }),
    kpi({
      label: 'Trechos de rede',
      value: fmtInt(segments),
      sub: `BT ${fmtInt(summary.layers.bt.count)} · MT ${fmtInt(summary.layers.mt.count)}`,
      color: LAYER_META.mt.color,
      iconName: 'zap',
      share: (segments / total) * 100,
    }),
  ].join('');
}

function renderComposition() {
  const composition = library.composition();
  const total = composition.reduce((sum, item) => sum + item.count, 0);
  if (!total) {
    els.donut.style.background = 'var(--surface-3)';
    els.donut.innerHTML = `<span>0<small>registros</small></span>`;
    els.legend.innerHTML = chartEmpty('Sem dados para compor.');
    return;
  }
  let current = 0;
  const segments = composition.map((item) => {
    const start = (current / total) * 100;
    current += item.count;
    const end = (current / total) * 100;
    return `${item.color} ${start.toFixed(3)}% ${end.toFixed(3)}%`;
  });
  els.donut.style.background = `conic-gradient(${segments.join(', ')})`;
  els.donut.innerHTML = `<span>${fmtInt(total)}<small>registros</small></span>`;
  els.legend.innerHTML = composition.map((item) => `
    <div class="donut-legend-row">
      <i style="--c:${item.color}"></i>
      <span>${item.name}</span>
      <strong>${fmtInt(item.count)} · ${fmtNum((item.count / total) * 100)}%</strong>
    </div>`).join('');
  els.compositionTotal.textContent = `${fmtInt(total)} registros`;
}

function renderLengths(summary) {
  const max = Math.max(summary.lengthBt, summary.lengthMt, 1);
  const rows = [
    { name: 'Rede BT', value: summary.lengthBt, color: LAYER_META.bt.color, count: summary.layers.bt.count },
    { name: 'Rede MT', value: summary.lengthMt, color: LAYER_META.mt.color, count: summary.layers.mt.count },
  ];
  els.lengthChart.innerHTML = rows.map((row) => `
    <div class="hbar">
      <div class="hbar-head">
        <span><i style="--c:${row.color}"></i>${row.name}</span>
        <strong>${row.value ? fmtKm(row.value) : '0 km'}</strong>
      </div>
      <div class="hbar-track"><i style="--c:${row.color};width:${(row.value / max) * 100}%"></i></div>
    </div>`).join('');
  const total = summary.lengthBt + summary.lengthMt;
  els.lengthFoot.textContent = total
    ? `Extensão total de ${fmtKm(total)} em ${fmtInt(summary.layers.bt.count + summary.layers.mt.count)} trechos.`
    : 'Sem comprimento informado nos trechos de rede.';
}

function renderMaterials() {
  const distribution = library.distribution('poste', 'material');
  if (!distribution.length) {
    els.materialChart.innerHTML = chartEmpty('Importe postes para ver a distribuição por material.');
    return;
  }
  const top = distribution.slice(0, 6);
  const max = top[0]?.count || 1;
  const total = distribution.reduce((sum, item) => sum + item.count, 0);
  els.materialChart.innerHTML = top.map((item) => `
    <div class="hbar is-thin">
      <div class="hbar-head">
        <span><i style="--c:var(--layer-poste)"></i>${esc(item.name)}</span>
        <strong>${fmtInt(item.count)} · ${fmtNum((item.count / total) * 100)}%</strong>
      </div>
      <div class="hbar-track"><i style="--c:var(--layer-poste);width:${(item.count / max) * 100}%"></i></div>
    </div>`).join('');
}

function renderInstallations() {
  const distribution = library.distribution('inst', 'installationType');
  if (!distribution.length) {
    els.installationChart.innerHTML = chartEmpty('Importe instalações para ver os tipos de equipamento.');
    return;
  }
  const top = distribution.slice(0, 7);
  const max = top[0]?.count || 1;
  els.installationChart.innerHTML = top.map((item, index) => `
    <div class="rank-row">
      <span class="rank-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="rank-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="rank-bar"><i style="--rank-c:var(--layer-inst);width:${(item.count / max) * 100}%"></i></span>
      <span class="rank-count">${fmtInt(item.count)}</span>
    </div>`).join('');
}

function qualityColor(value) {
  if (value >= 97) return 'var(--success)';
  if (value >= 88) return 'var(--warning)';
  return 'var(--danger)';
}

function renderQuality() {
  const quality = library.quality();
  const idHealth = 100 - quality.duplicatePct;
  const overall = Math.min(quality.locatedPct, quality.idPct, idHealth);
  const status = overall >= 97 ? 'Boa' : overall >= 88 ? 'Atenção' : 'Revisar';
  const statusColor = overall >= 97 ? 'var(--success)' : overall >= 88 ? 'var(--warning)' : 'var(--danger)';
  els.qualityBadge.textContent = status;
  els.qualityBadge.style.color = statusColor;
  els.qualityBadge.style.borderColor = `color-mix(in srgb, ${statusColor} 30%, transparent)`;
  els.qualityBadge.style.background = `color-mix(in srgb, ${statusColor} 10%, transparent)`;

  const rows = [
    {
      label: 'Registros com coordenadas',
      value: quality.locatedPct,
      detail: `${fmtInt(quality.located)} de ${fmtInt(quality.totalRows)}`,
    },
    {
      label: 'Identificadores preenchidos',
      value: quality.idPct,
      detail: `${fmtInt(quality.idPresent)} de ${fmtInt(quality.idTotal || quality.totalRows)}`,
    },
    {
      label: 'IDs sem duplicidade',
      value: idHealth,
      detail: quality.duplicates ? `${fmtInt(quality.duplicates)} duplicado(s)` : 'nenhum duplicado',
    },
  ];
  els.qualityList.innerHTML = rows.map((row) => `
    <div class="quality-row">
      <div class="quality-row-head"><span>${row.label}</span><strong>${fmtNum(row.value)}% · ${row.detail}</strong></div>
      <div class="quality-track"><i style="--q-c:${qualityColor(row.value)};width:${Math.max(0, Math.min(100, row.value))}%"></i></div>
    </div>`).join('');
}

function renderImports() {
  const imports = library.importHistory.slice(0, 5);
  if (!imports.length) {
    els.recentImports.innerHTML = `<div class="recent-empty">${icon('clock')}Nenhuma importação nesta sessão.</div>`;
    return;
  }
  els.recentImports.innerHTML = imports.map((item) => {
    const meta = LAYER_META[item.type];
    return `<div class="recent-import">
      <span class="recent-import-icon" style="color:${meta?.color || 'var(--muted)'}">${icon(meta?.icon || 'file')}</span>
      <span class="recent-import-copy"><strong title="${esc(item.fileName)}">${esc(item.fileName)}</strong><span>${meta?.name || item.type} · ${timeAgo(item.at)}${item.parseErrors ? ` · ${item.parseErrors} aviso(s)` : ''}</span></span>
      <span class="recent-import-count">${fmtInt(item.rows)}</span>
    </div>`;
  }).join('');
}

function render() {
  if (!els.empty) return;
  const hasData = library.hasData();
  els.empty.hidden = hasData;
  els.content.hidden = !hasData;
  if (!hasData) return;
  const summary = library.summary();
  renderKpis(summary);
  renderComposition();
  renderLengths(summary);
  renderMaterials();
  renderInstallations();
  renderQuality();
  renderImports();
}

export function initDashboard() {
  els.empty = document.querySelector('#dashboardEmpty');
  els.content = document.querySelector('#dashboardContent');
  els.kpis = document.querySelector('#dashboardKpis');
  els.donut = document.querySelector('#compositionDonut');
  els.legend = document.querySelector('#compositionLegend');
  els.compositionTotal = document.querySelector('#compositionTotal');
  els.lengthChart = document.querySelector('#lengthChart');
  els.lengthFoot = document.querySelector('#lengthFoot');
  els.materialChart = document.querySelector('#materialChart');
  els.installationChart = document.querySelector('#installationChart');
  els.qualityList = document.querySelector('#qualityList');
  els.qualityBadge = document.querySelector('#qualityBadge');
  els.recentImports = document.querySelector('#recentImports');

  bus.on('data:changed', render);
  bus.on('imports:changed', render);
  render();
}
