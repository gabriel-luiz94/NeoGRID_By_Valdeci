/* Anotações presas ao mapa: texto em um ponto, guardado no workspace.
 * Não altera a base nem o projeto; some ao remover a nota. */
import { esc } from '../core/format.js';
import { closeDialog, openDialog } from '../core/dom.js';
import { toast } from '../ui/toast.js';

const CHAVE = 'mapa:notas';
const CHAVE_LOCAL = 'neogrid.mapa.notas.v1';

let deps = {};
let grupo = null;
let notas = [];
let modoNovo = false;
let editando = null;

const uid = () => `nota-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function carregar() {
  try {
    const texto = await globalThis.desktop?.wsGet?.(CHAVE);
    if (texto) {
      const lido = JSON.parse(texto);
      if (Array.isArray(lido)) {
        notas = lido;
        return;
      }
    }
  } catch {
    /* segue para o armazenamento local */
  }
  try {
    const lido = JSON.parse(localStorage.getItem(CHAVE_LOCAL) || '[]');
    notas = Array.isArray(lido) ? lido : [];
  } catch {
    notas = [];
  }
}

async function salvar() {
  const texto = JSON.stringify(notas);
  try {
    localStorage.setItem(CHAVE_LOCAL, texto);
  } catch {
    /* sem armazenamento local */
  }
  try {
    await globalThis.desktop?.wsPut?.(CHAVE, texto);
  } catch {
    /* workspace indisponível: vale o armazenamento local */
  }
}

function desenhar() {
  const map = deps.mapView?.map;
  if (!map) return;
  if (!map.getPane('notasPane')) {
    map.createPane('notasPane');
    // Fica acima dos ativos e do KML, mas abaixo dos popups.
    map.getPane('notasPane').style.zIndex = '640';
  }
  if (!grupo) grupo = L.layerGroup().addTo(map);
  grupo.clearLayers();
  const icone = () => L.divIcon({
    className: 'map-note',
    html: '<span></span>',
    iconSize: [20, 20],
    iconAnchor: [10, 20],
  });
  for (const nota of notas) {
    const marcador = L.marker([nota.lat, nota.lng], {
      pane: 'notasPane',
      icon: icone(),
      draggable: true,
      riseOnHover: true,
      title: nota.texto || 'Anotação',
      keyboard: false,
    });
    if (nota.mostrar !== false && nota.texto) {
      marcador.bindTooltip(esc(nota.texto), {
        permanent: true,
        direction: 'right',
        offset: [10, -10],
        className: 'map-note-label',
        opacity: 1,
      });
    }
    marcador.on('click', () => abrir(nota));
    marcador.on('dragend', () => {
      const ponto = marcador.getLatLng();
      nota.lat = ponto.lat;
      nota.lng = ponto.lng;
      salvar();
    });
    marcador.addTo(grupo);
  }
}

function alternarModo(ligar) {
  modoNovo = ligar === true ? true : !modoNovo;
  document.querySelector('#mapNote')?.classList.toggle('is-active', modoNovo);
  const container = deps.mapView?.map?.getContainer?.();
  if (container) container.style.cursor = modoNovo ? 'crosshair' : '';
  if (modoNovo) {
    // Desliga medição/desenho de área para o clique não fazer duas coisas.
    try { window.sairModos?.(); } catch { /* módulo do Projeto ainda não carregou */ }
    toast.info('Anotação no mapa', 'Clique no ponto onde a anotação deve ficar.', { duration: 6000 });
  }
}

function abrir(alvo) {
  const dlg = document.querySelector('#noteDialog');
  if (!dlg) return;
  editando = alvo;
  const texto = document.querySelector('#noteText');
  const mostrar = document.querySelector('#noteShowOnMap');
  const excluir = document.querySelector('#noteDelete');
  const titulo = dlg.querySelector('.modal-head-copy h2');
  const nova = Boolean(alvo?.nova);
  if (texto) texto.value = nova ? '' : String(alvo?.texto || '');
  if (mostrar) mostrar.checked = nova ? true : alvo?.mostrar !== false;
  if (excluir) excluir.hidden = nova;
  if (titulo) titulo.textContent = nova ? 'Nova anotação no mapa' : 'Editar anotação';
  openDialog(dlg);
  setTimeout(() => texto?.focus(), 60);
}

async function confirmar() {
  const texto = String(document.querySelector('#noteText')?.value || '').trim();
  if (!texto) {
    toast.warning('Anotação vazia', 'Escreva o texto da anotação.');
    return;
  }
  const mostrar = document.querySelector('#noteShowOnMap')?.checked !== false;
  if (editando?.nova) {
    notas.push({
      id: uid(),
      lat: editando.nova.lat,
      lng: editando.nova.lng,
      texto,
      mostrar,
      criadoEm: Date.now(),
    });
  } else if (editando) {
    editando.texto = texto;
    editando.mostrar = mostrar;
  }
  await salvar();
  desenhar();
  closeDialog(document.querySelector('#noteDialog'));
  editando = null;
}

async function excluir() {
  if (!editando || editando.nova) return;
  notas = notas.filter((nota) => nota.id !== editando.id);
  await salvar();
  desenhar();
  closeDialog(document.querySelector('#noteDialog'));
  editando = null;
}

export function initMapNotes(options = {}) {
  deps = options;
  const map = deps.mapView?.map;
  if (!map) return;

  grupo = L.layerGroup().addTo(map);
  document.querySelector('#mapNote')?.addEventListener('click', () => alternarModo());
  document.querySelector('#noteSave')?.addEventListener('click', () => { confirmar(); });
  document.querySelector('#noteDelete')?.addEventListener('click', () => { excluir(); });
  document.querySelectorAll('#noteDialog [data-close]').forEach((botao) => {
    botao.addEventListener('click', () => closeDialog(botao.closest('dialog')));
  });
  document.querySelector('#noteDialog')?.addEventListener('close', () => {
    editando = null;
    if (modoNovo) alternarModo(false);
  });
  map.on('click', (event) => {
    if (!modoNovo) return;
    alternarModo(false);
    abrir({ nova: { lat: event.latlng.lat, lng: event.latlng.lng } });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modoNovo) alternarModo(false);
  });

  carregar().then(desenhar);
}
