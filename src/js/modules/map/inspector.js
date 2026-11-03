import { library } from '../../data/library.js';
import { LAYER_META } from '../../data/schema.js';
import { featureId, featureSubtitle, featureTitle, installationInfo, networkConductorText, networkLength } from '../../data/labels.js';
import { esc, fmtInt, fmtKm, copyText } from '../../core/format.js';
import { icon } from '../../core/dom.js';
import { getFieldSelection } from '../../core/settings.js';
import { toast } from '../../ui/toast.js';
import { bus } from '../../core/bus.js';

export class Inspector {
  constructor(options = {}) {
    this.element = document.querySelector('#inspector');
    this.title = document.querySelector('#inspectorTitle');
    this.body = document.querySelector('#inspectorBody');
    this.current = null;
    this.callbacks = options;
    this.closeButton = document.querySelector('#inspectorClose');

    this.closeButton?.addEventListener('click', () => {
      this.callbacks.onClose?.();
    });

    this.body?.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'select' && target.dataset.type) {
        const index = Number(target.dataset.index);
        if (Number.isInteger(index)) this.callbacks.onSelect?.(target.dataset.type, index);
      } else if (action === 'find-id' && target.dataset.id) {
        if (library.isDatabase()) {
          library.findByIdAsync(target.dataset.id).then((feature) => {
            if (feature) this.callbacks.onSelect?.(feature.type, feature.index);
            else toast.info('Ativo não encontrado', `Nenhum registro com o identificador ${target.dataset.id}.`);
          }).catch(() => {
            toast.info('Ativo não encontrado', `Nenhum registro com o identificador ${target.dataset.id}.`);
          });
        } else {
          const feature = library.findById(target.dataset.id);
          if (feature) this.callbacks.onSelect?.(feature.type, feature.index);
          else toast.info('Ativo não encontrado', `Nenhum registro com o identificador ${target.dataset.id}.`);
        }
      } else if (action === 'row' && this.current) {
        this.callbacks.onOpenRow?.(this.current.type, this.current.index);
      } else if (action === 'copy' && this.current) {
        this.copyCurrent();
      } else if (action === 'locate' && this.current) {
        this.callbacks.onSelect?.(this.current.type, this.current.index);
      }
    });

    this.renderEmpty();
  }

  fieldsFor(type) {
    const store = library.get(type);
    if (!store) return [];
    const selected = getFieldSelection(type);
    if (selected?.length) {
      return selected.filter((header) => store.colIndex(header) >= 0 && !/^GEOMETRIA_WKT$/.test(header));
    }
    return store.effectiveFieldHeaders();
  }

  value(store, row, header) {
    const index = store.colIndex(header);
    if (index < 0) return '—';
    const raw = String(row[index] ?? '').trim();
    if (!raw) return '—';
    const descIndex = store.colIndex(`${header}_DESC`);
    const description = descIndex >= 0 ? String(row[descIndex] ?? '').trim() : '';
    if (description && description !== raw) {
      return `${esc(description)} <small>(${esc(raw)})</small>`;
    }
    return esc(raw);
  }

  renderEmpty() {
    const summary = library.summary();
    this.title.textContent = 'Nenhum ativo selecionado';
    const hasData = library.hasData();
    const relatedStats = hasData
      ? `<div class="inspector-summary">
           <div><span>Postes</span><strong>${fmtInt(summary.layers.poste.count)}</strong></div>
           <div><span>Instalações</span><strong>${fmtInt(summary.layers.inst.count)}</strong></div>
           <div><span>Rede BT</span><strong>${fmtKm(summary.lengthBt)}</strong></div>
           <div><span>Rede MT</span><strong>${fmtKm(summary.lengthMt)}</strong></div>
         </div>`
      : '';
    this.body.innerHTML = `
      <div class="inspector-empty">
        <div class="inspector-empty-art">${icon('pin')}</div>
        <h3>${hasData ? 'Selecione um ativo no mapa' : 'Importe os dados para começar'}</h3>
        <p>${hasData
          ? 'Clique em um poste, instalação ou trecho de rede para ver atributos e conexões.'
          : 'Os detalhes de cada ativo ficam disponíveis depois da importação dos arquivos CSV.'}</p>
        <div class="inspector-empty-tips">
          <div class="inspector-tip"><kbd>Clique</kbd><span>Abrir os detalhes de um ativo</span></div>
          <div class="inspector-tip"><kbd>F</kbd><span>Ir para a área com mais dados</span></div>
          <div class="inspector-tip"><kbd>Esc</kbd><span>Limpar a seleção</span></div>
        </div>
        ${relatedStats}
        <div class="inspector-legend">
          <span><i style="--c: var(--layer-poste)"></i>Postes</span>
          <span><i style="--c: var(--layer-bt)"></i>Rede BT</span>
          <span><i style="--c: var(--layer-mt)"></i>Rede MT</span>
          <span><i style="--c: var(--layer-inst)"></i>Instalações</span>
        </div>
      </div>`;
  }

  async loadDbRelations(store, row, index) {
    const { dbLinks, dbFindById } = await import('../../data/database-client.js');
    const relations = { installations: [], networks: [], poleId: '', poleIndex: null, siblings: [] };
    try {
      if (store.type === 'poste') {
        const poleId = store.col(row, 'NU_PG_ID');
        relations.poleId = poleId;
        if (!poleId) return relations;
        const links = await dbLinks(poleId);
        const instStore = library.get('inst');
        const instIds = (links.inst || []).slice(0, 8);
        await instStore?.ensureRows(instIds);
        relations.installations = instIds
          .filter((i) => instStore?.rows[i] !== undefined)
          .map((i) => {
            const info = installationInfo(instStore, i);
            return {
              index: i,
              id: instStore.col(instStore.rows[i], 'NU_INSTALA') || instStore.col(instStore.rows[i], 'NU_INSTALACAO_MT_ID'),
              name: info.name,
              plate: info.plate,
            };
          });
        const nets = (links.nets || []).slice(0, 6);
        const byLayer = new Map();
        for (const net of nets) {
          if (!byLayer.has(net.layer)) byLayer.set(net.layer, []);
          byLayer.get(net.layer).push(net.rid);
        }
        for (const [layer, rids] of byLayer) {
          const netStore = library.get(layer);
          await netStore?.ensureRows(rids);
          for (const rid of rids) {
            const netRow = netStore?.rows[rid];
            if (!netRow) continue;
            relations.networks.push({
              type: layer, index: rid,
              id: netStore.col(netRow, 'NU_TRECHO') || netStore.col(netRow, 'NU_TRECHO_MT_ID') || netStore.col(netRow, 'NU_TRECHO_BT_ID'),
              detail: [networkConductorText(netStore, netRow), networkLength(netStore, netRow) && `${networkLength(netStore, netRow).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`].filter(Boolean).join(' · '),
            });
          }
        }
      } else if (store.type === 'inst') {
        const poleId = store.col(row, 'NU_PG_ID');
        relations.poleId = poleId;
        if (poleId) {
          try {
            const poleIndex = await dbFindById('poste', poleId);
            if (poleIndex != null) {
              await library.get('poste')?.ensureRow(poleIndex);
              relations.poleIndex = poleIndex;
            }
          } catch { /* sem poste vinculado */ }
          try {
            const links = await dbLinks(poleId);
            const ids = (links.inst || []).filter((i) => i !== index).slice(0, 6);
            await store.ensureRows(ids);
            relations.siblings = ids
              .filter((i) => store.rows[i] !== undefined)
              .map((i) => {
                const info = installationInfo(store, i);
                return { index: i, id: store.col(store.rows[i], 'NU_INSTALA') || store.col(store.rows[i], 'NU_INSTALACAO_MT_ID'), name: info.name };
              });
          } catch { /* sem vizinhos */ }
        }
      }
    } catch {
      /* vínculos indisponíveis; atributos continuam */
    }
    return relations;
  }

  dbRelationsHtml(store) {
    const relations = this.dbRelations;
    if (!relations) return '';
    const sections = [];
    if (store.type === 'poste') {
      if (relations.installations.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Instalações vinculadas</span><span>${relations.installations.length}</span></div>
            <div class="chip-list">
              ${relations.installations.map((item) => `<button class="chip is-link" data-action="select" data-type="inst" data-index="${item.index}" title="${esc(item.name)}">${esc(item.id || item.name || 'Instalação')}${item.plate ? ` · ${esc(item.plate)}` : ''}</button>`).join('')}
            </div>
          </div>`);
      }
      if (relations.networks.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Trechos conectados</span><span>${relations.networks.length}</span></div>
            <div class="related-list">
              ${relations.networks.map(({ type: networkType, index: networkIndex, id, detail }) => {
                const meta = LAYER_META[networkType];
                return `<button class="related-item" data-action="select" data-type="${networkType}" data-index="${networkIndex}">
                  <i style="--c:${meta.color}"></i>
                  <span class="related-item-copy"><strong>${esc(id || `${meta.singular} ${networkIndex + 1}`)}</strong><small>${esc(detail || meta.name)}</small></span>
                  ${icon('chevron-right')}
                </button>`;
              }).join('')}
            </div>
          </div>`);
      }
    }
    if (store.type === 'inst' && relations.poleId) {
      sections.push(`
        <div class="inspector-section">
          <div class="inspector-section-head"><span>Poste vinculado</span></div>
          <div class="chip-list">
            <button class="chip is-link" data-action="find-id" data-id="${esc(relations.poleId)}">${icon('pin')} ${esc(relations.poleId)}</button>
          </div>
          ${relations.poleIndex == null ? '<p class="field-hint" style="margin-top:7px">O poste informado não está presente na base de postes.</p>' : ''}
        </div>`);
      if (relations.siblings.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Outros equipamentos no poste</span><span>${relations.siblings.length}</span></div>
            <div class="related-list">
              ${relations.siblings.map((item) => `<button class="related-item" data-action="select" data-type="inst" data-index="${item.index}">
                <i style="--c:${LAYER_META.inst.color}"></i>
                <span class="related-item-copy"><strong>${esc(item.id || item.name || 'Instalação')}</strong><small>${esc(item.name || '')}</small></span>
                ${icon('chevron-right')}
              </button>`).join('')}
            </div>
          </div>`);
      }
    }
    return sections.join('');
  }

  async setFeature(type, index) {
    const store = library.get(type);
    if (!store || index == null || index < 0 || index >= store.stats.count) {
      this.clear();
      return;
    }
    if (store.isDatabase && store.rows[index] === undefined) {
      this.current = { type, index };
      this.element.classList.add('is-open');
      this.title.textContent = 'Carregando ativo…';
      this.body.innerHTML = '<div class="inspector-empty"><div class="search-spinner"></div><p>Buscando atributos no banco…</p></div>';
      try {
        await store.ensureRow(index);
      } catch {
        this.clear();
        return;
      }
      if (this.current?.type !== type || this.current?.index !== index) return;
    }
    this.current = { type, index };
    this.dbRelations = null;
    if (store.isDatabase) {
      try {
        this.dbRelations = await this.loadDbRelations(store, store.rows[index], index);
      } catch {
        this.dbRelations = null;
      }
      if (this.current?.type !== type || this.current?.index !== index) return;
    }
    this.element.classList.add('is-open');
    this.render();
    bus.emit('feature:selected', this.current);
  }

  clear() {
    this.current = null;
    this.dbRelations = null;
    this.element.classList.remove('is-open');
    this.renderEmpty();
    bus.emit('feature:selected', null);
  }

  refresh() {
    if (!this.current) {
      this.renderEmpty();
      return;
    }
    const store = library.get(this.current.type);
    if (!store || this.current.index >= store.stats.count) {
      this.clear();
      return;
    }
    this.render();
  }

  render() {
    if (!this.current) {
      this.renderEmpty();
      return;
    }
    const { type, index } = this.current;
    const store = library.get(type);
    const row = store.rows[index];
    if (!row) {
      this.clear();
      return;
    }
    const meta = LAYER_META[type];
    const title = featureTitle(store, index);
    const subtitle = featureSubtitle(store, index);
    this.title.textContent = title;

    const fields = this.fieldsFor(type).slice(0, 11);
    const attributes = fields.map((header) => `
      <div class="attribute-row">
        <dt>${esc(header)}</dt>
        <dd title="${esc(String(row[store.colIndex(header)] ?? ''))}">${this.value(store, row, header)}</dd>
      </div>`).join('');

    this.body.innerHTML = `
      <div class="feature-type-row">
        <span class="feature-type" style="--c:${meta.color}"><i></i>${meta.singular}</span>
        <span class="feature-id">${esc(featureId(store, index) || `#${index + 1}`)}</span>
      </div>
      <h3 class="feature-heading">${esc(title)}</h3>
      ${subtitle ? `<p class="feature-subheading">${esc(subtitle)}</p>` : ''}
      <div class="feature-actions">
        <button class="btn btn-soft btn-sm" data-action="locate">${icon('crosshair')} Centralizar</button>
        <button class="btn btn-ghost btn-sm" data-action="copy">${icon('copy')} Copiar</button>
      </div>
      <dl class="attribute-list">${attributes || '<div class="attribute-row"><dt>Campos</dt><dd>Sem atributos disponíveis</dd></div>'}</dl>
      <button class="inspector-more" data-action="row">
        <span>Ver todos os ${store.stats.count ? 'campos' : 'dados'} do registro</span>
        ${icon('arrow-right')}
      </button>
      ${this.relatedHtml(store, index)}
    `;
  }

  relatedHtml(store, index) {
    if (store.isDatabase) return this.dbRelationsHtml(store);
    const row = store.rows[index];
    const type = store.type;
    const sections = [];

    if (type === 'poste') {
      const poleId = store.col(row, 'NU_PG_ID');
      const installationsStore = library.get('inst');
      const installations = poleId ? installationsStore?.mp.get(poleId) || [] : [];
      const networks = [];
      for (const networkType of ['bt', 'mt']) {
        const networkStore = library.get(networkType);
        for (const networkIndex of networkStore?.mp.get(poleId) || []) {
          networks.push({ type: networkType, index: networkIndex, store: networkStore });
        }
      }

      if (installations.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Instalações vinculadas</span><span>${installations.length}</span></div>
            <div class="chip-list">
              ${installations.slice(0, 8).map((installationIndex) => {
                const info = installationInfo(installationsStore, installationIndex);
                const id = installationsStore.col(installationsStore.rows[installationIndex], 'NU_INSTALA');
                return `<button class="chip is-link" data-action="select" data-type="inst" data-index="${installationIndex}" title="${esc(info.name)}">${esc(id || info.name || 'Instalação')}${info.plate ? ` · ${esc(info.plate)}` : ''}</button>`;
              }).join('')}
              ${installations.length > 8 ? `<span class="chip">+${installations.length - 8}</span>` : ''}
            </div>
          </div>`);
      }

      if (networks.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Trechos conectados</span><span>${networks.length}</span></div>
            <div class="related-list">
              ${networks.slice(0, 6).map(({ type: networkType, index: networkIndex, store: networkStore }) => {
                const meta = LAYER_META[networkType];
                const networkRow = networkStore.rows[networkIndex];
                const id = networkStore.col(networkRow, 'NU_TRECHO');
                const detail = [networkConductorText(networkStore, networkRow), networkLength(networkStore, networkRow) && `${networkLength(networkStore, networkRow).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`]
                  .filter(Boolean).join(' · ');
                return `<button class="related-item" data-action="select" data-type="${networkType}" data-index="${networkIndex}">
                  <i style="--c:${meta.color}"></i>
                  <span class="related-item-copy"><strong>${esc(id || `${meta.singular} ${networkIndex + 1}`)}</strong><small>${esc(detail || meta.name)}</small></span>
                  ${icon('chevron-right')}
                </button>`;
              }).join('')}
            </div>
          </div>`);
      }
    }

    if (type === 'inst') {
      const poleId = store.col(row, 'NU_PG_ID');
      const siblings = poleId ? (library.get('inst')?.mp.get(poleId) || []).filter((item) => item !== index) : [];
      if (poleId) {
        const poleIndex = library.get('poste')?.by.get(poleId);
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Poste vinculado</span></div>
            <div class="chip-list">
              <button class="chip is-link" data-action="find-id" data-id="${esc(poleId)}">${icon('pin')} ${esc(poleId)}</button>
              ${siblings.length ? `<span class="chip">${siblings.length} outra${siblings.length > 1 ? 's' : ''} instalação${siblings.length > 1 ? 'ões' : ''}</span>` : ''}
            </div>
            ${poleIndex == null ? '<p class="field-hint" style="margin-top:7px">O poste informado não está presente na base de postes importada.</p>' : ''}
          </div>`);
      }
      if (siblings.length) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Outros equipamentos no poste</span><span>${siblings.length}</span></div>
            <div class="related-list">
              ${siblings.slice(0, 6).map((installationIndex) => {
                const info = installationInfo(store, installationIndex);
                const id = store.col(store.rows[installationIndex], 'NU_INSTALA');
                return `<button class="related-item" data-action="select" data-type="inst" data-index="${installationIndex}">
                  <i style="--c:${LAYER_META.inst.color}"></i>
                  <span class="related-item-copy"><strong>${esc(id || info.name || 'Instalação')}</strong><small>${esc(info.name || '')}</small></span>
                  ${icon('chevron-right')}
                </button>`;
              }).join('')}
            </div>
          </div>`);
      }
    }

    if (type === 'bt' || type === 'mt') {
      const start = store.col(row, 'NU_PG_INI');
      const end = store.col(row, 'NU_PG_FIN');
      if (start || end) {
        sections.push(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Postes do trecho</span></div>
            <div class="chip-list">
              ${start ? `<button class="chip is-link" data-action="find-id" data-id="${esc(start)}">${icon('pin')} ${esc(start)}</button>` : ''}
              ${end ? `<button class="chip is-link" data-action="find-id" data-id="${esc(end)}">${icon('pin')} ${esc(end)}</button>` : ''}
            </div>
          </div>`);
      }
    }

    const hasNetwork = type === 'bt' || type === 'mt';
    if (hasNetwork) {
      const conductor = networkConductorText(store, row);
      const length = networkLength(store, row);
      if (conductor || length) {
        sections.unshift(`
          <div class="inspector-section">
            <div class="inspector-section-head"><span>Resumo elétrico</span></div>
            <div class="inspector-summary">
              <div><span>Condutor</span><strong title="${esc(conductor)}">${esc(conductor || '—')}</strong></div>
              <div><span>Comprimento</span><strong>${length ? `${length.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m` : '—'}</strong></div>
            </div>
          </div>`);
      }
    }

    return sections.join('');
  }

  async copyCurrent() {
    if (!this.current) return;
    const store = library.get(this.current.type);
    const row = store.rows[this.current.index];
    const data = {};
    store.headers.forEach((header, index) => {
      data[header] = row[index] ?? '';
    });
    data.__tipo = store.type;
    data.__id = featureId(store, this.current.index);
    const ok = await copyText(JSON.stringify(data, null, 2));
    if (ok) toast.success('Registro copiado', 'Os atributos foram copiados para a área de transferência.', { duration: 2600 });
    else toast.error('Não foi possível copiar', 'A área de transferência não está disponível.');
  }
}
