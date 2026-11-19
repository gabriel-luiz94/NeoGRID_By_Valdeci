/* Modo de marcação temporário no mapa (texto com fundo, seta, linha e
 * desenho livre). Tudo fica em um pane do mapa — portanto sai na impressão/PDF —
 * e é apagado ao sair do modo, como o modo Projeto. */
import { esc } from '../core/format.js';
import { openDialog, closeDialog } from '../core/dom.js';
import { confirmAction } from '../ui/confirm.js';
import { toast } from '../ui/toast.js';

let deps = {};
let ativo = false;
let ferramenta = 'text';
let cor = '#f5a524';
let largura = 3;
let tamanhoTexto = 16;
let comFundo = true;
let camada = null;
let desenho = null;
let inicio = null;
let pontos = [];
let textoPendente = null;
let estadoMapa = null;

const mapa = () => deps.mapView?.map;

function garantirPane() {
  const map = mapa();
  if (!map) return;
  if (!map.getPane('markupPane')) {
    map.createPane('markupPane');
    map.getPane('markupPane').style.zIndex = '680';
    map.getPane('markupPane').style.pointerEvents = 'none';
  }
}

function atualizarBarra() {
  document.querySelectorAll('[data-markup-tool]').forEach((botao) => {
    botao.classList.toggle('is-active', botao.dataset.markupTool === ferramenta);
  });
}

function limparTemp() {
  if (desenho) {
    desenho.remove();
    desenho = null;
  }
  pontos = [];
  inicio = null;
}

function limpar() {
  camada?.clearLayers();
  limparTemp();
}

function ativar() {
  const map = mapa();
  if (!map) return;
  garantirPane();
  try { window.sairModos?.(); } catch { /* módulo do Projeto ainda não carregou */ }
  ativo = true;
  estadoMapa = {
    dragging: map.dragging.enabled(),
    doubleClickZoom: map.doubleClickZoom.enabled(),
  };
  map.dragging.disable();
  map.doubleClickZoom.disable();
  map.getContainer().style.cursor = 'crosshair';
  const bar = document.querySelector('#markupBar');
  if (bar) bar.hidden = false;
  document.querySelector('#mapMarkup')?.classList.add('is-active');
  atualizarBarra();
  toast.info('Modo marcação', 'Texto, seta, linha ou desenho livre. O botão Sair apaga tudo.', { duration: 6000 });
}

async function sair({ confirmar = true } = {}) {
  if (!ativo) return;
  const itens = camada?.getLayers?.().length || 0;
  if (itens && confirmar) {
    const ok = await confirmAction({
      title: 'Sair do modo de marcação?',
      text: `${itens} marcação(ões) serão apagadas do mapa.`,
      confirmLabel: 'Sair e apagar',
    });
    if (!ok) return;
  }
  limpar();
  ativo = false;
  const map = mapa();
  if (map) {
    if (estadoMapa?.dragging !== false) map.dragging.enable();
    if (estadoMapa?.doubleClickZoom !== false) map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
  }
  const bar = document.querySelector('#markupBar');
  if (bar) bar.hidden = true;
  document.querySelector('#mapMarkup')?.classList.remove('is-active');
  estadoMapa = null;
}

function desenharTemp() {
  const map = mapa();
  if (!map || !pontos.length) return;
  if (!desenho) {
    desenho = L.polyline(pontos, {
      pane: 'markupPane',
      color: cor,
      weight: largura,
      dashArray: '5 4',
      interactive: false,
    }).addTo(map);
  } else {
    desenho.setLatLngs(pontos);
  }
}

function finalizar() {
  if (!inicio) return;
  const lista = [...pontos];
  if (ferramenta === 'pen') {
    if (lista.length > 1) {
      L.polyline(lista, {
        pane: 'markupPane',
        color: cor,
        weight: largura,
        interactive: false,
        smoothFactor: 1,
      }).addTo(camada);
    }
  } else if (lista.length >= 2) {
    const [a, b] = lista;
    if (a.distanceTo(b) > 2) {
      L.polyline([a, b], {
        pane: 'markupPane',
        color: cor,
        weight: largura,
        interactive: false,
      }).addTo(camada);
      if (ferramenta === 'arrow') {
        const rad = Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * rad);
        const graus = Math.atan2(dLng, b.lat - a.lat) / rad;
        L.marker(b, {
          pane: 'markupPane',
          interactive: false,
          icon: L.divIcon({
            className: 'mk-arrow',
            html: `<span style="transform:rotate(${graus.toFixed(1)}deg);color:${cor}"></span>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
        }).addTo(camada);
      }
    }
  }
  limparTemp();
}

function criarTexto(latlng, texto) {
  const classe = `mk-text${comFundo ? '' : ' sem-fundo'}`;
  L.marker(latlng, {
    pane: 'markupPane',
    interactive: false,
    icon: L.divIcon({
      className: classe,
      html: `<span style="font-size:${tamanhoTexto}px;--mk-cor:${cor}">${esc(texto)}</span>`,
      iconSize: null,
      iconAnchor: [0, 0],
    }),
  }).addTo(camada);
}

function abrirTexto(latlng) {
  textoPendente = latlng;
  const area = document.querySelector('#markupText');
  if (area) area.value = '';
  openDialog(document.querySelector('#markupTextDialog'));
}

function confirmarTexto() {
  const texto = String(document.querySelector('#markupText')?.value || '').trim();
  if (!texto || !textoPendente) return;
  criarTexto(textoPendente, texto);
  closeDialog(document.querySelector('#markupTextDialog'));
  textoPendente = null;
}

function aoDown(event) {
  if (!ativo) return;
  if (event.originalEvent && event.originalEvent.button !== 0) return;
  if (ferramenta === 'text') {
    abrirTexto(event.latlng);
    return;
  }
  if (desenho) {
    desenho.remove();
    desenho = null;
  }
  inicio = event.latlng;
  pontos = [event.latlng];
}

function aoMove(event) {
  if (!ativo || !inicio) return;
  if (ferramenta === 'pen') {
    const ultimo = pontos[pontos.length - 1];
    if (ultimo && event.latlng.distanceTo(ultimo) < 2) return;
    pontos.push(event.latlng);
  } else {
    pontos = [inicio, event.latlng];
  }
  desenharTemp();
}

function aoUp(event) {
  if (!ativo || !inicio) return;
  if (ferramenta !== 'pen' && pontos.length < 2) {
    pontos = [inicio, event.latlng];
  }
  finalizar();
}

export function initMapMarkup(options = {}) {
  deps = options;
  const map = mapa();
  if (!map) return;
  garantirPane();
  camada = L.layerGroup().addTo(map);

  map.on('mousedown', aoDown);
  map.on('mousemove', aoMove);
  map.on('mouseup', aoUp);

  document.querySelector('#mapMarkup')?.addEventListener('click', () => {
    if (ativo) sair();
    else ativar();
  });
  document.querySelectorAll('[data-markup-tool]').forEach((botao) => {
    botao.addEventListener('click', () => {
      ferramenta = botao.dataset.markupTool || 'text';
      atualizarBarra();
    });
  });
  const corInput = document.querySelector('#markupColor');
  corInput?.addEventListener('input', () => { cor = corInput.value || '#f5a524'; });
  const larguraInput = document.querySelector('#markupWidth');
  larguraInput?.addEventListener('input', () => { largura = Number(larguraInput.value) || 3; });
  const fonteInput = document.querySelector('#markupFont');
  fonteInput?.addEventListener('input', () => {
    tamanhoTexto = Number(fonteInput.value) || 16;
    // Ajusta também os textos já colocados, sem precisar apagar.
    document.querySelectorAll('.mk-text span').forEach((span) => {
      span.style.fontSize = `${tamanhoTexto}px`;
    });
  });
  const fundoInput = document.querySelector('#markupBg');
  fundoInput?.addEventListener('change', () => {
    comFundo = fundoInput.checked;
    document.querySelectorAll('.mk-text').forEach((el) => {
      el.classList.toggle('sem-fundo', !comFundo);
    });
  });

  document.querySelector('#markupClear')?.addEventListener('click', () => {
    if (!camada?.getLayers().length) return;
    limpar();
    toast.info('Marcações apagadas', 'O mapa está limpo; continue marcando ou saia do modo.');
  });
  document.querySelector('#markupExit')?.addEventListener('click', () => { sair(); });
  document.querySelector('#markupTextOk')?.addEventListener('click', confirmarTexto);
  document.querySelector('#markupText')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      confirmarTexto();
    }
  });
  document.querySelector('#markupTextDialog')?.addEventListener('close', () => { textoPendente = null; });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ativo && !document.querySelector('#markupTextDialog')?.open) sair();
  });
  // Se o botão do mouse for solto fora do mapa, encerra o traço mesmo assim.
  window.addEventListener('mouseup', () => {
    if (ativo && inicio) finalizar();
  });
}
