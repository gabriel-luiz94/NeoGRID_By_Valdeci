import { library } from '../data/library.js';
import { LAYER_META } from '../data/schema.js';
import { featureId, featureSubtitle, featureTitle, installationInfo, networkConductorText, networkLength } from '../data/labels.js';
import { esc, copyText, fmtInt } from '../core/format.js';
import { closeDialog, icon, openDialog } from '../core/dom.js';
import { toast } from './toast.js';

let deps = {};
let els = {};
let current = null;

const fieldValue = (store, row, header) => {
  const index = store.colIndex(header);
  if (index < 0) return '—';
  const raw = String(row[index] ?? '').trim();
  if (!raw) return '—';
  const descIndex = store.colIndex(`${header}_DESC`);
  const description = descIndex >= 0 ? String(row[descIndex] ?? '').trim() : '';
  if (description && description !== raw) return `${description} (${raw})`;
  return raw;
};

const render = () => {
  if (!current) return;
  const store = library.get(current.type);
  const row = store.rows[current.index];
  if (!row) return;
  const meta = LAYER_META[current.type];
  els.icon.innerHTML = icon(meta.icon);
  els.title.textContent = `${meta.singular} ${featureId(store, current.index) || `#${current.index + 1}`}`;
  els.subtitle.textContent = featureSubtitle(store, current.index) || `${fmtInt(store.stats.count)} registros nesta camada`;
  els.foot.textContent = `${store.stats.count.toLocaleString('pt-BR')} registros na camada · exibindo 1 registro`;

  const headers = store.headers.filter((header) => !/_DESC$/.test(header) && !/^GEOMETRIA_WKT$/.test(header));
  const fields = headers.map((header) => `
    <div class="detail-item">
      <span>${esc(header)}</span>
      <strong title="${esc(fieldValue(store, row, header))}">${esc(fieldValue(store, row, header))}</strong>
    </div>`).join('');

  const related = [];
  if (current.type === 'poste') {
    const poleId = store.col(row, 'NU_PG_ID');
    const installationsStore = library.get('inst');
    const installations = poleId ? installationsStore?.mp.get(poleId) || [] : [];
    if (installations.length) {
      related.push(`
        <div>
          <div class="row-related-title">Instalações vinculadas · ${installations.length}</div>
          <div class="row-related">
            ${installations.slice(0, 12).map((index) => {
              const info = installationInfo(installationsStore, index);
              const id = installationsStore.col(installationsStore.rows[index], 'NU_INSTALA');
              return `<div class="row-related-item">${icon('grid')}<span>${esc(id || info.name || 'Instalação')}${info.plate ? ` · ${esc(info.plate)}` : ''}</span><strong>${esc(info.name || '')}</strong></div>`;
            }).join('')}
          </div>
        </div>`);
    }
    const networkItems = [];
    for (const type of ['bt', 'mt']) {
      const networkStore = library.get(type);
      for (const index of networkStore?.mp.get(poleId) || []) {
        const networkRow = networkStore.rows[index];
        const id = networkStore.col(networkRow, 'NU_TRECHO');
        const detail = [networkConductorText(networkStore, networkRow), networkLength(networkStore, networkRow) && `${networkLength(networkStore, networkRow).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`]
          .filter(Boolean).join(' · ');
        networkItems.push(`<div class="row-related-item">${icon(type === 'mt' ? 'bolt' : 'zap')}<span>${esc(id || LAYER_META[type].singular)}</span><strong>${esc(detail)}</strong></div>`);
      }
    }
    if (networkItems.length) {
      related.push(`<div><div class="row-related-title">Trechos conectados · ${networkItems.length}</div><div class="row-related">${networkItems.slice(0, 12).join('')}</div></div>`);
    }
  }

  if (current.type === 'inst') {
    const poleId = store.col(row, 'NU_PG_ID');
    if (poleId) {
      related.push(`
        <div>
          <div class="row-related-title">Poste vinculado</div>
          <div class="row-related">
            <div class="row-related-item">${icon('pin')}<span>${esc(poleId)}</span><strong>NU_PG_ID</strong></div>
          </div>
        </div>`);
    }
  }

  if (current.type === 'bt' || current.type === 'mt') {
    const start = store.col(row, 'NU_PG_INI');
    const end = store.col(row, 'NU_PG_FIN');
    const conductor = networkConductorText(store, row);
    const length = networkLength(store, row);
    related.unshift(`
      <div>
        <div class="row-related-title">Resumo do trecho</div>
        <div class="row-related">
          <div class="row-related-item">${icon('link')}<span>Poste inicial</span><strong>${esc(start || '—')}</strong></div>
          <div class="row-related-item">${icon('link')}<span>Poste final</span><strong>${esc(end || '—')}</strong></div>
          <div class="row-related-item">${icon('zap')}<span>Condutor</span><strong>${esc(conductor || '—')}</strong></div>
          <div class="row-related-item">${icon('ruler')}<span>Comprimento</span><strong>${length ? `${length.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m` : '—'}</strong></div>
        </div>
      </div>`);
  }

  els.body.innerHTML = `
    <div class="feature-type-row">
      <span class="feature-type" style="--c:${meta.color}"><i></i>${meta.singular}</span>
      <span class="feature-id">${esc(featureId(store, current.index) || `#${current.index + 1}`)}</span>
    </div>
    <div class="detail-grid">${fields || '<div class="detail-item"><span>—</span><strong>Sem atributos</strong></div>'}</div>
    ${related.join('')}
  `;
};

export function initRowDialog(options = {}) {
  deps = options;
  els = {
    dialog: document.querySelector('#rowDialog'),
    icon: document.querySelector('#rowDialogIcon'),
    title: document.querySelector('#rowDialogTitle'),
    subtitle: document.querySelector('#rowDialogSubtitle'),
    body: document.querySelector('#rowDialogBody'),
    foot: document.querySelector('#rowDialogFoot'),
    copy: document.querySelector('#rowCopy'),
    locate: document.querySelector('#rowLocate'),
  };

  els.copy?.addEventListener('click', async () => {
    if (!current) return;
    const store = library.get(current.type);
    if (!store) return;
    const row = store.rows[current.index];
    const data = {};
    store.headers.forEach((header, index) => {
      data[header] = row[index] ?? '';
    });
    data.__tipo = current.type;
    data.__id = featureId(store, current.index);
    const ok = await copyText(JSON.stringify(data, null, 2));
    if (ok) toast.success('Registro copiado', 'Atributos copiados em formato JSON.', { duration: 2500 });
  });

  els.locate?.addEventListener('click', () => {
    if (!current) return;
    const { type, index } = current;
    closeDialog(els.dialog);
    deps.onLocate?.(type, index);
  });
}

export async function openRowDialog(type, index) {
  const store = library.get(type);
  if (!store || index == null || index >= store.stats.count) return;
  if (store.isDatabase && store.rows[index] === undefined) {
    try {
      await store.ensureRow(index);
    } catch {
      return;
    }
  }
  current = { type, index };
  render();
  openDialog(els.dialog);
}
