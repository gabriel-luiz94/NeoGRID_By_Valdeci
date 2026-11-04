/* Módulo DXF: importa blocos (ASCII) e escreve DXF R12 (POLYLINE, INSERT, ATTRIB). */
const DXF = (() => {
  const RAD = Math.PI / 180;
  // paleta ACI completa (1-255), gerada como no AutoCAD
  const PAL = [null, ...'ff0000ffff0000ff0000ffff0000ffff00ffffffff808080c0c0c0ff0000ff7f7fa50000a552527f00007f3f3f4c00004c2626260000261313ff3f00ff9f7fa52900a567527f1f007f4f3f4c13004c2f26260900261713ff7f00ffbf7fa55200a57c527f3f007f5f3f4c26004c3926261300261c13ffbf00ffdf7fa57c00a591527f5f007f6f3f4c39004c4226261c00262113ffff00ffff7fa5a500a5a5527f7f007f7f3f4c4c004c4c26262600262613bfff00dfff7f7ca50091a5525f7f006f7f3f394c00424c261c26002126137fff00bfff7f52a5007ca5523f7f005f7f3f264c00394c261326001c26133fff009fff7f29a50067a5521f7f004f7f3f134c002f4c2609260017261300ff007fff7f00a50052a552007f003f7f3f004c00264c2600260013261300ff3f7fff9f00a52952a567007f1f3f7f4f004c13264c2f00260913581700ff7f7fffbf00a55252a57c007f3f3f7f5f004c26264c3900261313581c00ffbf7fffdf00a57c52a591007f5f3f7f6f004c39264c4200261c13585800ffff7fffff00a5a552a5a5007f7f3f7f7f004c4c264c4c00262613585800bfff7fdfff007ca55291a5005f7f3f6f7f00394c26427e001c26135858007fff7fbfff0052a5527ca5003f7f3f5f7f00264c26397e001326131c58003fff7f9fff0029a55267a5001f7f3f4f7f00134c262f7e0009261317580000ff7f7fff0000a55252a500007f3f3f7f00004c26267e0000261313583f00ff9f7fff2900a56752a51f007f4f3f7f13004c2f267e0900261713587f00ffbf7fff5200a57c52a53f007f5f3f7f26004c39267e1300261c1358bf00ffdf7fff7c00a59152a55f007f6f3f7f39004c42264c1c0026581358ff00ffff7fffa500a5a552a57f007f7f3f7f4c004c4c264c260026581358ff00bfff7fdfa5007ca552917f005f7f3f6f4c00394c264226001c581358ff007fff7fbfa50052a5527c7f003f7f3f5f4c00264c263926001358131cff003fff7f9fa50029a552677f001f7f3f4f4c00134c262f260009581317000000656565666666999999ccccccffffff'.match(/.{6}/g).map(h => [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)))];
  const hex2rgb = h => { h = String(h || '#ffffff').replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) || 0); };
  const acic = new Map();
  const aci = hex => {
    const key = String(hex || '#ffffff').toLowerCase(); let r0 = acic.get(key); if (r0 !== undefined) return r0;
    const [r, g, b] = hex2rgb(key); let best = 7, bd = 1e12;
    if (r === g && g === b && (r === 255 || r === 0)) best = 7;   // branco/preto: cor 7 (inverte conforme o fundo)
    else for (let k = 1; k < 256; k++) {
      const [R, G, B] = PAL[k], rm = (r + R) / 2, dr = r - R, dg = g - G, db = b - B;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;   // distância "redmean"
      if (d < bd) { bd = d; best = k; }
    }
    acic.set(key, best); return best;
  };
  const aciHex = c => PAL[c] ? '#' + PAL[c].map(v => v.toString(16).padStart(2, '0')).join('') : null;
  const f3 = v => (+v).toFixed(3);
  let MT = false; // true: textos saem como MTEXT (DXF R2000)
  const mtEsc = s => tx(String(s).replace(/\\/g, '\\\\').replace(/[{}]/g, m => '\\' + m).replace(/\r?\n/g, '\\P'));
  const tx = s => String(s).replace(/[^\x20-\x7E]/g, ch => '\\U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const tagOk = s => String(s).toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'TAG';

  // ---------- leitura ----------
  function pairs(text) {
    const L = text.split(/\r?\n/), out = [];
    for (let i = 0; i + 1 < L.length; i += 2) {
      const c = parseInt(L[i].trim(), 10);
      if (isNaN(c)) { i--; continue; }
      out.push([c, L[i + 1].trim()]);
    }
    return out;
  }
  const get = (r, c, d) => { const x = r.g.find(q => q[0] === c); return x ? x[1] : d; };
  const num = (r, c, d = 0) => { const x = get(r, c); return x === undefined ? d : (parseFloat(x) || 0); };
  function recs(sec) {
    const R = []; let cur = null;
    for (const [c, v] of sec) { if (c === 0) { cur = {type: v, g: []}; R.push(cur); } else if (cur) cur.g.push([c, v]); }
    return R;
  }
  function conv(R) {
    const ents = [], att = [], un = {};
    for (let i = 0; i < R.length; i++) {
      const r = R[i], cc = get(r, 62), c = cc === undefined ? undefined : parseInt(cc, 10);
      switch (r.type) {
        case 'LINE': ents.push({t: 'LINE', a: [num(r, 10), num(r, 20)], b: [num(r, 11), num(r, 21)], c}); break;
        case 'CIRCLE': ents.push({t: 'CIRCLE', p: [num(r, 10), num(r, 20)], r: num(r, 40), c}); break;
        case 'ARC': ents.push({t: 'ARC', p: [num(r, 10), num(r, 20)], r: num(r, 40), a0: num(r, 50), a1: num(r, 51), c}); break;
        case 'POINT': ents.push({t: 'POINT', p: [num(r, 10), num(r, 20)], c}); break;
        case 'LWPOLYLINE': {
          const pts = [];
          for (const [cd, v] of r.g) {
            if (cd === 10) pts.push([parseFloat(v), 0, 0]);
            else if (cd === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(v);
            else if (cd === 42 && pts.length) pts[pts.length - 1][2] = parseFloat(v);
          }
          ents.push({t: 'PLINE', pts, closed: !!(parseInt(get(r, 70, '0'), 10) & 1), c}); break;
        }
        case 'POLYLINE': {
          const fl = parseInt(get(r, 70, '0'), 10), pts = []; let j = i + 1;
          while (j < R.length && R[j].type === 'VERTEX') { const v = R[j], vf = parseInt(get(v, 70, '0'), 10); if (!(vf & 16)) pts.push([num(v, 10), num(v, 20), num(v, 42)]); j++; }
          if (j < R.length && R[j].type === 'SEQEND') j++;
          i = j - 1;
          if (fl & (8 | 16 | 64)) un.POLYLINE_3D = (un.POLYLINE_3D || 0) + 1;
          else ents.push({t: 'PLINE', pts, closed: !!(fl & 1), c});
          break;
        }
        case 'SOLID': case 'TRACE': {
          const p = [[num(r, 10), num(r, 20)], [num(r, 11), num(r, 21)], [num(r, 12), num(r, 22)], [num(r, 13), num(r, 23)]];
          ents.push({t: 'SOLID', pts: [p[0], p[1], p[3], p[2]], c}); break;
        }
        case 'TEXT': ents.push({t: 'TEXT', p: [num(r, 10), num(r, 20)], h: num(r, 40, 1), s: get(r, 1, ''), rot: num(r, 50), c}); break;
        case 'MTEXT': ents.push({t: 'TEXT', p: [num(r, 10), num(r, 20)], h: num(r, 40, 1), s: (get(r, 1, '') + r.g.filter(q => q[0] === 3).map(q => q[1]).join('')).replace(/\\P.*$/, '').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, ''), rot: num(r, 50), c}); break;
        case 'ATTDEF': att.push({tag: get(r, 2, 'TAG'), prompt: get(r, 3, ''), def: get(r, 1, ''), p: [num(r, 10), num(r, 20)], h: num(r, 40, 1), flags: parseInt(get(r, 70, '0'), 10)}); break;
        case 'INSERT': ents.push({t: 'INSERT', name: get(r, 2, ''), p: [num(r, 10), num(r, 20)], sx: num(r, 41, 1) || 1, sy: num(r, 42, 1) || 1, rot: num(r, 50), c}); break;
        case 'ATTRIB': case 'VERTEX': case 'SEQEND': break;
        default: un[r.type] = (un[r.type] || 0) + 1;
      }
    }
    return {ents, att, un};
  }
  function parseAll(text) {
    if (text.startsWith('AutoCAD Binary DXF')) throw new Error('DXF binário não é suportado. Salve o desenho como DXF ASCII.');
    const P = pairs(text), secs = {};
    for (let i = 0; i < P.length; i++) {
      if (P[i][0] === 0 && P[i][1] === 'SECTION') {
        const name = P[i + 1] && P[i + 1][0] === 2 ? P[i + 1][1] : ''; i += 2; const s = i;
        while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) i++;
        secs[name] = P.slice(s, i);
      }
    }
    if (!secs.ENTITIES && !secs.BLOCKS) throw new Error('Arquivo sem seções BLOCKS/ENTITIES (é mesmo um DXF?)');
    const blocks = {}; let acc = null;
    for (const r of recs(secs.BLOCKS || [])) {
      if (r.type === 'BLOCK') acc = {nome: get(r, 2, ''), base: [num(r, 10), num(r, 20)], R: []};
      else if (r.type === 'ENDBLK') { if (acc) blocks[acc.nome] = acc; acc = null; }
      else if (acc) acc.R.push(r);
    }
    for (const b of Object.values(blocks)) { const c = conv(b.R); b.ents = c.ents; b.att = c.att; b.un = c.un; delete b.R; }
    return {blocks, model: conv(recs(secs.ENTITIES || []))};
  }

  // ---------- geometria ----------
  const T = (a, b, c, d, e, f) => ({a, b, c, d, e, f});
  const ID = T(1, 0, 0, 1, 0, 0);
  const mul = (m1, m2) => T(m1.a * m2.a + m1.c * m2.b, m1.b * m2.a + m1.d * m2.b, m1.a * m2.c + m1.c * m2.d, m1.b * m2.c + m1.d * m2.d,
    m1.a * m2.e + m1.c * m2.f + m1.e, m1.b * m2.e + m1.d * m2.f + m1.f);
  const arcPts = (cx, cy, r, a0, a1, step = 8) => {
    while (a1 <= a0) a1 += 360;
    const n = Math.max(2, Math.ceil((a1 - a0) / step)), o = [];
    for (let k = 0; k <= n; k++) { const a = (a0 + (a1 - a0) * k / n) * RAD; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]); }
    return o;
  };
  function bulgePts(p0, p1, b) {
    if (!b) return [[p1[0], p1[1]]];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy);
    if (c < 1e-12) return [[p1[0], p1[1]]];
    const th = 4 * Math.atan(b), d = (c / 2) / Math.tan(th / 2), ux = dx / c, uy = dy / c;
    const cx = (p0[0] + p1[0]) / 2 - uy * d, cy = (p0[1] + p1[1]) / 2 + ux * d, R = Math.abs(c / (2 * Math.sin(th / 2)));
    const a0 = Math.atan2(p0[1] - cy, p0[0] - cx), n = Math.max(1, Math.ceil(Math.abs(th) / (8 * RAD))), o = [];
    for (let k = 1; k <= n; k++) { const a = a0 + th * k / n; o.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
    return o;
  }
  function xfEnt(e, M) {
    const P = p => [M.a * p[0] + M.c * p[1] + M.e, M.b * p[0] + M.d * p[1] + M.f];
    const det = M.a * M.d - M.b * M.c, sc = Math.sqrt(Math.abs(det)), mir = det < 0;
    const uni = Math.abs(Math.hypot(M.a, M.b) - Math.hypot(M.c, M.d)) < 1e-9 * (1 + sc) && Math.abs(M.a * M.c + M.b * M.d) < 1e-9 * (1 + sc * sc);
    const rot = Math.atan2(M.b, M.a) / RAD;
    switch (e.t) {
      case 'LINE': return {...e, a: P(e.a), b: P(e.b)};
      case 'POINT': return {...e, p: P(e.p)};
      case 'PLINE': return {...e, pts: e.pts.map(q => { const p = P(q); return [p[0], p[1], mir ? -(q[2] || 0) : (q[2] || 0)]; })};
      case 'SOLID': return {...e, pts: e.pts.map(P)};
      case 'TEXT': return {...e, p: P(e.p), h: e.h * sc, rot: (e.rot || 0) + rot};
      case 'CIRCLE':
        if (uni) return {...e, p: P(e.p), r: e.r * sc};
        return {t: 'PLINE', pts: arcPts(e.p[0], e.p[1], e.r, 0, 360, 11.25).map(q => { const p = P(q); return [p[0], p[1], 0]; }), closed: true, c: e.c};
      case 'ARC':
        if (uni && !mir) return {...e, p: P(e.p), r: e.r * sc, a0: e.a0 + rot, a1: e.a1 + rot};
        return {t: 'PLINE', pts: arcPts(e.p[0], e.p[1], e.r, e.a0, e.a1).map(q => { const p = P(q); return [p[0], p[1], 0]; }), closed: false, c: e.c};
    }
    return e;
  }
  function flatten(ents, M, blocks, depth, un) {
    const out = [];
    for (const e of ents) {
      if (e.t !== 'INSERT') { out.push(xfEnt(e, M)); continue; }
      const bb = blocks[e.name];
      if (!bb || depth > 6) { un['INSERT de ' + e.name] = (un['INSERT de ' + e.name] || 0) + 1; continue; }
      const c = Math.cos(e.rot * RAD), s = Math.sin(e.rot * RAD);
      const m = T(c * e.sx, s * e.sx, -s * e.sy, c * e.sy, e.p[0] - (c * e.sx * bb.base[0] - s * e.sy * bb.base[1]), e.p[1] - (s * e.sx * bb.base[0] + c * e.sy * bb.base[1]));
      out.push(...flatten(bb.ents, mul(M, m), blocks, depth + 1, un));
    }
    return out;
  }
  function prepBloco(bl) {
    const dp = [];
    for (const e of bl.ents) {
      switch (e.t) {
        case 'LINE': dp.push({pts: [e.a, e.b], c: e.c}); break;
        case 'CIRCLE': dp.push({pts: arcPts(e.p[0], e.p[1], e.r, 0, 360, 11.25), closed: true, c: e.c}); break;
        case 'ARC': dp.push({pts: arcPts(e.p[0], e.p[1], e.r, e.a0, e.a1), c: e.c}); break;
        case 'SOLID': dp.push({pts: e.pts, closed: true, fill: true, c: e.c}); break;
        case 'PLINE': {
          const o = e.pts.length ? [[e.pts[0][0], e.pts[0][1]]] : [], n = e.pts.length;
          for (let k = 0; k < (e.closed ? n : n - 1); k++) o.push(...bulgePts(e.pts[k], e.pts[(k + 1) % n], e.pts[k][2]));
          dp.push({pts: o, closed: e.closed, c: e.c}); break;
        }
      }
    }
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const p of dp) for (const q of p.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    if (x0 > x1) { x0 = y0 = 0; x1 = y1 = 1; }
    bl.dp = dp; bl.bb = [x0, y0, x1, y1]; bl.max = Math.max(x1 - x0, y1 - y0) || 1;
    return bl;
  }
  function importar(parsed, arq) {
    const out = {}, un0 = {};
    const nomeArq = String(arq || 'DESENHO').replace(/\.[^.]+$/, '').replace(/[^\w$-]+/g, '_').toUpperCase() || 'DESENHO';
    const make = (nome, b, ents) => {
      const un = {...(b.un || {})}, fl = flatten(ents, ID, parsed.blocks, 0, un);
      if (!fl.length) return;
      out[nome] = prepBloco({nome, base: b.base.slice(), ents: fl, att: b.att || [], un, centro: false, origem: arq});
    };
    for (const nm of Object.keys(parsed.blocks)) { if (nm[0] === '*') continue; make(nm, parsed.blocks[nm], parsed.blocks[nm].ents); }
    if (parsed.model.ents.length) make(nomeArq, {base: [0, 0], att: [], un: parsed.model.un}, parsed.model.ents);
    return out;
  }
  function formaEnts(est, u) {
    const s = est.tam * u, h = (est.tamh || est.tam) * u;
    const P = pts => ({t: 'PLINE', pts: pts.map(p => [p[0], p[1], 0]), closed: true});
    switch (est.forma) {
      case 'ret': return [P([[-s / 2, -h / 2], [s / 2, -h / 2], [s / 2, h / 2], [-s / 2, h / 2]])];
      case 'quad': return [P([[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]])];
      case 'losango': return [P([[0, s / 2], [s / 2, 0], [0, -s / 2], [-s / 2, 0]])];
      case 'tri': return [P([[0, s / 2], [s / 2, -.39 * s], [-s / 2, -.39 * s]])];
      case 'cruz': return [{t: 'LINE', a: [-s / 2, 0], b: [s / 2, 0]}, {t: 'LINE', a: [0, -s / 2], b: [0, s / 2]}];
      case 'linha': return [{t: 'LINE', a: [-s / 2, 0], b: [s / 2, 0]}];
      default: return [{t: 'CIRCLE', p: [0, 0], r: s / 2}];
    }
  }


  // ---------- escrita R2000 (AC1015): usada quando os textos saem como MTEXT ----------
  // MTEXT só existe a partir do R2000, e esse formato exige handles, marcadores de subclasse,
  // BLOCK_RECORD e a hierarquia de dono; sem eles o AutoCAD/NanoCAD pede "recuperar" o arquivo.
  let HN = 0x100;
  const hx = n => n.toString(16).toUpperCase();
  const nh = () => hx(HN++);
  const H_MODEL = '1F', H_PAPER = '1E', H_TB = {BLOCK_RECORD: '1', LAYER: '2', STYLE: '3', LTYPE: '5', VIEW: '6', UCS: '7', VPORT: '8', APPID: '9', DIMSTYLE: 'A'};
  let OWN = H_MODEL; const BRS = new Map();   // dono atual e BLOCK_RECORDs (nome -> handle)
  const ent2 = (o, tipo, L, extra) => o.push(0, tipo, 5, nh(), 330, OWN, 100, 'AcDbEntity', 8, L, ...(extra || []));
  function wEnt2(o, e, L, col, blk) {
    const cc = e.c != null && e.c > 0 && e.c < 256 ? e.c : (blk ? 0 : col);
    const C = cc != null ? [62, cc] : [], LT = e.lt ? [6, e.lt] : [];
    switch (e.t) {
      case 'LINE': ent2(o, 'LINE', L, [...LT, ...C, 100, 'AcDbLine', 10, f3(e.a[0]), 20, f3(e.a[1]), 30, 0, 11, f3(e.b[0]), 21, f3(e.b[1]), 31, 0]); break;
      case 'CIRCLE': ent2(o, 'CIRCLE', L, [...LT, ...C, 100, 'AcDbCircle', 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.r)]); break;
      case 'ARC': ent2(o, 'ARC', L, [...LT, ...C, 100, 'AcDbCircle', 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.r), 100, 'AcDbArc', 50, f3(e.a0), 51, f3(e.a1)]); break;
      case 'POINT': ent2(o, 'POINT', L, [...C, 100, 'AcDbPoint', 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0]); break;
      case 'PLINE': {
        const w = e.w ? (+e.w).toFixed(4) : null;
        ent2(o, 'LWPOLYLINE', L, [...LT, ...C, 100, 'AcDbPolyline', 90, e.pts.length, 70, e.closed ? 1 : 0, ...(w ? [43, w] : []),
          ...e.pts.flatMap(p => [10, f3(p[0]), 20, f3(p[1]), ...(p[2] ? [42, (+p[2]).toFixed(6)] : [])])]); break;
      }
      case 'SOLID': {
        const p = e.pts, q = [p[0], p[1], p[3] || p[2], p[2]];
        ent2(o, 'SOLID', L, [...C, 100, 'AcDbTrace', 10, f3(q[0][0]), 20, f3(q[0][1]), 30, 0, 11, f3(q[1][0]), 21, f3(q[1][1]), 31, 0, 12, f3(q[2][0]), 22, f3(q[2][1]), 32, 0, 13, f3(q[3][0]), 23, f3(q[3][1]), 33, 0]); break;
      }
      case 'TEXT': {
        const hj = e.hj || 0, vj = e.vj == null ? 0 : e.vj, row = vj === 3 ? 0 : vj === 2 ? 1 : 2, ap = row * 3 + (hj === 1 || hj === 4 ? 2 : hj === 2 ? 3 : 1);
        ent2(o, 'MTEXT', L, [...C, 100, 'AcDbMText', 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.h), 41, 0, 71, ap, 72, 5, 1, mtEsc(e.s), 7, 'STANDARD', 50, f3(e.rot || 0)]);
        break;
      }
    }
  }
  function wInsert2(o, name, L, x, y, sx, rot, att, col) {
    const k = (+sx).toFixed(6);
    ent2(o, 'INSERT', L, [...(col != null ? [62, col] : []), 100, 'AcDbBlockReference', ...(att && att.length ? [66, 1] : []), 2, name, 10, f3(x), 20, f3(y), 30, 0, 41, k, 42, k, 43, k, 50, f3(rot)]);
    if (att && att.length) {
      for (const a of att) ent2(o, 'ATTRIB', L, [100, 'AcDbText', 10, f3(a.p[0]), 20, f3(a.p[1]), 30, 0, 40, f3(a.h), 1, tx(a.val), 50, f3(a.rot || 0), 7, 'STANDARD', 100, 'AcDbAttribute', 2, tagOk(a.tag), 70, a.flags == null ? 1 : a.flags]);
      ent2(o, 'SEQEND', L);
    }
  }
  function wBlock2(o, name, ents, att) {
    const br = nh(); BRS.set(name, br); const prev = OWN; OWN = br;
    o.push(0, 'BLOCK', 5, nh(), 330, br, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '');
    for (const e of ents) wEnt2(o, e, '0', null, true);
    for (const a of att || []) o.push(0, 'ATTDEF', 5, nh(), 330, br, 100, 'AcDbEntity', 8, '0', 100, 'AcDbText', 10, f3(a.p[0]), 20, f3(a.p[1]), 30, 0, 40, f3(a.h), 1, tx(a.def || ''), 7, 'STANDARD', 100, 'AcDbAttributeDefinition', 3, tx(a.prompt || a.tag), 2, tagOk(a.tag), 70, a.flags == null ? 1 : a.flags);
    o.push(0, 'ENDBLK', 5, nh(), 330, br, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd');
    OWN = prev;
  }
  function build2(layers, blocks, body, fonte, lts) {
    const L = [['0', 7], ...layers.filter(l => l[0] !== '0')];
    BRS.clear(); const bo = []; for (const b of blocks) wBlock2(bo, b.nome, b.ents, b.att);
    const tb = (nome, n, recs) => [0, 'TABLE', 2, nome, 5, H_TB[nome], 100, 'AcDbSymbolTable', 70, n, ...recs, 0, 'ENDTAB'];
    const rec = (tipo, nome, sub, extra) => [0, tipo, 5, nh(), 330, H_TB[nome], 100, 'AcDbSymbolTableRecord', 100, sub, ...extra];
    const lt = (n, d, pat) => rec('LTYPE', 'LTYPE', 'AcDbLinetypeTableRecord', [2, n, 70, 0, 3, d, 72, 65, 73, pat.length, 40, pat.reduce((s, v) => s + Math.abs(v), 0).toFixed(4), ...pat.flatMap(v => [49, v.toFixed(4), 74, 0])]);
    const ltR = [...lt('ByBlock', '', []), ...lt('ByLayer', '', []), ...lt('CONTINUOUS', 'Solid line', []), ...(lts || []).flatMap(([n, pat]) => lt(n, n, pat))];
    const names = ['*Model_Space', '*Paper_Space', ...blocks.map(b => b.nome)];
    const brR = [0, 'BLOCK_RECORD', 5, H_MODEL, 330, H_TB.BLOCK_RECORD, 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, '*Model_Space', 340, '0',
      0, 'BLOCK_RECORD', 5, H_PAPER, 330, H_TB.BLOCK_RECORD, 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, '*Paper_Space', 340, '0',
      ...blocks.flatMap(b => [0, 'BLOCK_RECORD', 5, BRS.get(b.nome), 330, H_TB.BLOCK_RECORD, 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, b.nome, 340, '0'])];
    const tabelas = [0, 'SECTION', 2, 'TABLES',
      ...tb('VPORT', 1, rec('VPORT', 'VPORT', 'AcDbViewportTableRecord', [2, '*Active', 70, 0, 10, 0, 20, 0, 11, 1, 21, 1, 12, 0, 22, 0, 13, 0, 23, 0, 14, 10, 24, 10, 15, 0, 25, 0, 16, 0, 26, 0, 36, 1, 17, 0, 27, 0, 37, 0, 40, 100, 41, 1.5, 42, 50, 43, 0, 44, 0, 50, 0, 51, 0, 71, 0, 72, 100, 73, 1, 74, 3, 75, 0, 76, 0, 77, 0, 78, 0])),
      ...tb('LTYPE', 3 + (lts || []).length, ltR),
      ...tb('LAYER', L.length, L.flatMap(([n, c]) => rec('LAYER', 'LAYER', 'AcDbLayerTableRecord', [2, n, 70, 0, 62, c, 6, 'CONTINUOUS']))),
      ...tb('STYLE', 1, rec('STYLE', 'STYLE', 'AcDbTextStyleTableRecord', [2, 'STANDARD', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, .2, 3, fonte || 'txt', 4, ''])),
      ...tb('VIEW', 0, []), ...tb('UCS', 0, []),
      ...tb('APPID', 1, rec('APPID', 'APPID', 'AcDbRegAppTableRecord', [2, 'ACAD', 70, 0])),
      ...tb('DIMSTYLE', 0, []),
      ...tb('BLOCK_RECORD', names.length, brR), 0, 'ENDSEC'];
    const blk = [0, 'SECTION', 2, 'BLOCKS',
      0, 'BLOCK', 5, nh(), 330, H_MODEL, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin', 2, '*Model_Space', 70, 0, 10, 0, 20, 0, 30, 0, 3, '*Model_Space', 1, '',
      0, 'ENDBLK', 5, nh(), 330, H_MODEL, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd',
      0, 'BLOCK', 5, nh(), 330, H_PAPER, 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockBegin', 2, '*Paper_Space', 70, 0, 10, 0, 20, 0, 30, 0, 3, '*Paper_Space', 1, '',
      0, 'ENDBLK', 5, nh(), 330, H_PAPER, 100, 'AcDbEntity', 67, 1, 8, '0', 100, 'AcDbBlockEnd', ...bo, 0, 'ENDSEC'];
    const objs = [0, 'SECTION', 2, 'OBJECTS',
      0, 'DICTIONARY', 5, 'C', 330, '0', 100, 'AcDbDictionary', 281, 1, 3, 'ACAD_GROUP', 350, 'D',
      0, 'DICTIONARY', 5, 'D', 330, 'C', 100, 'AcDbDictionary', 281, 1, 0, 'ENDSEC'];
    const h = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$HANDSEED', 5, hx(HN + 16), 0, 'ENDSEC'];
    return [...h, ...tabelas, ...blk, 0, 'SECTION', 2, 'ENTITIES', ...body, 0, 'ENDSEC', ...objs, 0, 'EOF'].join('\n') + '\n';
  }

  // ---------- escrita (R12) ----------
  let HK = null;   // gancho do módulo Projeto: HK(tipo, {e|..., L, col}) devolve o objeto (possivelmente editado) ou null para omitir
  function wEnt(o, e, L, col, blk) {
    if (!blk && HK) { const r = HK('E', {e, L, col}); if (!r) return; e = r.e; L = r.L; col = r.col; }
    if (MT) return wEnt2(o, e, L, col, blk);
    const cc = e.c != null && e.c > 0 && e.c < 256 ? e.c : (blk ? 0 : col);
    const C = cc != null ? [62, cc] : [];
    switch (e.t) {
      case 'LINE': o.push(0, 'LINE', 8, L, ...(e.lt ? [6, e.lt] : []), ...C, 10, f3(e.a[0]), 20, f3(e.a[1]), 30, 0, 11, f3(e.b[0]), 21, f3(e.b[1]), 31, 0); break;
      case 'CIRCLE': o.push(0, 'CIRCLE', 8, L, ...C, 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.r)); break;
      case 'ARC': o.push(0, 'ARC', 8, L, ...C, 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.r), 50, f3(e.a0), 51, f3(e.a1)); break;
      case 'POINT': o.push(0, 'POINT', 8, L, ...C, 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0); break;
      case 'PLINE':
        o.push(0, 'POLYLINE', 8, L, ...(e.lt ? [6, e.lt] : []), ...C, 66, 1, 10, 0, 20, 0, 30, 0, 70, e.closed ? 1 : 0, ...(e.w ? [40, (+e.w).toFixed(4), 41, (+e.w).toFixed(4)] : []));
        for (const p of e.pts) o.push(0, 'VERTEX', 8, L, 10, f3(p[0]), 20, f3(p[1]), 30, 0, ...(p[2] ? [42, (+p[2]).toFixed(6)] : []));
        o.push(0, 'SEQEND', 8, L); break;
      case 'SOLID': {
        const p = e.pts; const q = [p[0], p[1], p[3] || p[2], p[2]];
        o.push(0, 'SOLID', 8, L, ...C, 10, f3(q[0][0]), 20, f3(q[0][1]), 30, 0, 11, f3(q[1][0]), 21, f3(q[1][1]), 31, 0, 12, f3(q[2][0]), 22, f3(q[2][1]), 32, 0, 13, f3(q[3][0]), 23, f3(q[3][1]), 33, 0); break;
      }
      case 'TEXT':
        if (MT) {
          const hj = e.hj || 0, vj = e.vj == null ? 0 : e.vj, row = vj === 3 ? 0 : vj === 2 ? 1 : 2, ap = row * 3 + (hj === 1 || hj === 4 ? 2 : hj === 2 ? 3 : 1);
          o.push(0, 'MTEXT', 100, 'AcDbEntity', 8, L, ...C, 100, 'AcDbMText', 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.h), 41, 0, 71, ap, 72, 5, 1, mtEsc(e.s), 7, 'STANDARD', 50, f3(e.rot || 0));
          break;
        }
        o.push(0, 'TEXT', 8, L, ...C, 10, f3(e.p[0]), 20, f3(e.p[1]), 30, 0, 40, f3(e.h), 1, tx(String(e.s).replace(/\n/g, ' ')), 50, f3(e.rot || 0),
          ...(e.w && e.w !== 1 ? [41, (+e.w).toFixed(3)] : []), 72, e.hj || 0, 73, e.vj == null ? 0 : e.vj, 11, f3(e.p[0]), 21, f3(e.p[1]), 31, 0); break;
    }
  }
  // att: [{tag, val, p:[x,y], h, rot, flags}]
  function wInsert(o, name, L, x, y, sx, rot, att, col) {
    if (HK) { const r = HK('I', {name, L, x, y, sx, rot, att, col}); if (!r) return; ({name, L, x, y, sx, rot, att, col} = r); }
    if (MT) return wInsert2(o, name, L, x, y, sx, rot, att, col);
    const k = (+sx).toFixed(6);
    o.push(0, 'INSERT', 8, L, ...(col != null ? [62, col] : []), ...(att && att.length ? [66, 1] : []), 2, name, 10, f3(x), 20, f3(y), 30, 0, 41, k, 42, k, 43, k, 50, f3(rot));
    if (att && att.length) {
      for (const a of att) o.push(0, 'ATTRIB', 8, L, 10, f3(a.p[0]), 20, f3(a.p[1]), 30, 0, 40, f3(a.h), 1, tx(a.val), 2, tagOk(a.tag), 70, a.flags == null ? 1 : a.flags, 50, f3(a.rot || 0));
      o.push(0, 'SEQEND', 8, L);
    }
  }
  function wBlock(o, name, ents, att) {
    if (MT) return wBlock2(o, name, ents, att);
    o.push(0, 'BLOCK', 8, '0', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name);
    for (const e of ents) wEnt(o, e, '0', null, true);
    for (const a of att || []) o.push(0, 'ATTDEF', 8, '0', 10, f3(a.p[0]), 20, f3(a.p[1]), 30, 0, 40, f3(a.h), 1, tx(a.def || ''), 3, tx(a.prompt || a.tag), 2, tagOk(a.tag), 70, a.flags == null ? 1 : a.flags);
    o.push(0, 'ENDBLK', 8, '0');
  }
  // layers: [[nome, aci]], blocks: [{nome, ents, att}], body: array de pares
  function build(layers, blocks, body, fonte, lts) {
    if (MT) return build2(layers, blocks, body, fonte, lts);
    const L = [['0', 7], ...layers.filter(l => l[0] !== '0')];
    const bo = []; for (const b of blocks) wBlock(bo, b.nome, b.ents, b.att);
    const h = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, MT ? 'AC1015' : 'AC1009', 0, 'ENDSEC', 0, 'SECTION', 2, 'TABLES',
      0, 'TABLE', 2, 'LTYPE', 70, 1 + (lts || []).length, 0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0,
      ...(lts || []).flatMap(([n, pat]) => [0, 'LTYPE', 2, n, 70, 0, 3, n, 72, 65, 73, pat.length, 40, pat.reduce((s, v) => s + Math.abs(v), 0).toFixed(4), ...pat.flatMap(v => [49, v.toFixed(4)])]), 0, 'ENDTAB',
      0, 'TABLE', 2, 'LAYER', 70, L.length, ...L.flatMap(([n, c]) => [0, 'LAYER', 2, n, 70, 0, 62, c, 6, 'CONTINUOUS']), 0, 'ENDTAB',
      0, 'TABLE', 2, 'STYLE', 70, 1, 0, 'STYLE', 2, 'STANDARD', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, .2, 3, fonte || 'txt', 4, '', 0, 'ENDTAB',
      0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS', ...bo, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
    return [...h, ...body, 0, 'ENDSEC', 0, 'EOF'].join('\n') + '\n';
  }
  return {setHook: f => { HK = f || null; }, ctx: null, setMtext: v => { MT = !!v; if (MT) { HN = 0x100; OWN = H_MODEL; } }, parseAll, importar, prepBloco, xfEnt, T, ID, mul, arcPts, formaEnts, wEnt, wInsert, wBlock, build, aci, aciHex, tagOk};
})();
