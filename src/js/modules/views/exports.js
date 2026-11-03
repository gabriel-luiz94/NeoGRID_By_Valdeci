import { bus } from '../../core/bus.js';
import { library } from '../../data/library.js';
import { icon } from '../../core/dom.js';
import { esc, fmtBytes, fmtInt, timeAgo } from '../../core/format.js';

let els = {};

const formatIcons = {
  DXF: 'ruler',
  CSV: 'file-csv',
  PDF: 'printer',
};

function render() {
  if (!els.history) return;
  const entries = library.exportHistory;
  if (els.count) els.count.textContent = `${entries.length} arquivo${entries.length === 1 ? '' : 's'}`;
  if (!entries.length) {
    els.history.innerHTML = `<div class="history-empty">${icon('export')}<p>As exportações geradas nesta sessão aparecem aqui.</p></div>`;
    return;
  }
  els.history.innerHTML = entries.map((entry) => `
    <div class="export-history-row">
      <span class="export-history-icon">${icon(formatIcons[entry.format] || 'file')}</span>
      <span class="export-history-copy">
        <strong>${esc(entry.name)}</strong>
        <span>${entry.format}${entry.rows ? ` · ${fmtInt(entry.rows)} registros` : ''}${entry.bytes ? ` · ${fmtBytes(entry.bytes)}` : ''} · ${timeAgo(entry.at)}</span>
      </span>
      ${entry.path ? `<button class="ghost-btn" data-reveal="${entry.path}" type="button">Mostrar na pasta</button>` : ''}
    </div>`).join('');
}

export function initExports() {
  els = {
    history: document.querySelector('#exportHistory'),
    count: document.querySelector('#exportHistoryCount'),
  };
  if (!els.history) return;
  els.history.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reveal]');
    if (button) window.desktop?.revealFile(button.dataset.reveal);
  });
  bus.on('exports:changed', render);
  bus.on('data:changed', () => {
    // Os cards permanecem disponíveis; os módulos validam a presença de dados.
  });
  render();
}
