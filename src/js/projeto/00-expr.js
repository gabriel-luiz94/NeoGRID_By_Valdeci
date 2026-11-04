/* Motor de expressões (origem: CTWeb). */
const Expr = (() => {
  const api = {ctxFns: {}, vars: {}};
  const KW = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'LIKE', 'ILIKE', 'IN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE']);
  const RNUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y, RID = /[A-Za-z_\u00C0-\u024F][\w\u00C0-\u024F]*/y, RVAR = /[@$][A-Za-z_]\w*/y;
  const NUMRE = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
  const nn = v => v === null || v === undefined;
  const nz = v => nn(v) || v === '';
  const toNum = v => {
    if (nn(v)) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v).trim();
    if (!NUMRE.test(s)) return null;
    const x = parseFloat(s.replace(',', '.'));
    return isFinite(x) ? x : null;
  };
  const toStr = v => nn(v) ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'number' ? String(+v.toFixed(10)) : String(v);
  const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false');
  const eq = (a, b) => {
    if (nz(a) || nz(b)) return nz(a) && nz(b);
    const x = toNum(a), y = toNum(b);
    if (x !== null && y !== null) return x === y;
    return toStr(a) === toStr(b);
  };
  const lt = (a, b) => { const x = toNum(a), y = toNum(b); if (x !== null && y !== null) return x < y; return toStr(a) < toStr(b); };
  const rxCache = new Map();
  const likeRe = (p, ci) => {
    const k = (ci ? 'i' : 's') + p; let r = rxCache.get(k);
    if (!r) { r = new RegExp('^' + toStr(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$', ci ? 'i' : ''); if (rxCache.size > 300) rxCache.clear(); rxCache.set(k, r); }
    return r;
  };
  const arith = (o, a, b) => {
    const x = toNum(a), y = toNum(b);
    if (o === '+' && (x === null || y === null)) return (nn(a) || nn(b)) ? null : toStr(a) + toStr(b);
    if (x === null || y === null) return null;
    switch (o) {
      case '+': return x + y; case '-': return x - y; case '*': return x * y;
      case '/': return y === 0 ? null : x / y; case '%': return y === 0 ? null : x % y;
      case '^': return Math.pow(x, y);
    }
    return null;
  };

  // ---------- funções ----------
  const F = {};
  const S1 = f => s => nn(s) ? null : f(toStr(s));
  F.upper = S1(s => s.toUpperCase());
  F.lower = S1(s => s.toLowerCase());
  F.title = S1(s => s.toLowerCase().replace(/(^|[\s\-\/(])(\S)/g, (m, a, b) => a + b.toUpperCase()));
  F.trim = S1(s => s.trim());
  F.ltrim = S1(s => s.replace(/^\s+/, ''));
  F.rtrim = S1(s => s.replace(/\s+$/, ''));
  F.length = F.len = s => nn(s) ? null : toStr(s).length;
  F.substr = F.substring = (s, a, l) => {
    if (nn(s)) return null;
    const t = toStr(s); let i = toNum(a) ?? 1; i = i < 0 ? Math.max(0, t.length + i) : Math.max(0, i - 1);
    const n = toNum(l); return n === null ? t.slice(i) : t.substr(i, n);
  };
  F.left = (s, n) => nn(s) ? null : toStr(s).slice(0, Math.max(0, toNum(n) ?? 0));
  F.right = (s, n) => { if (nn(s)) return null; const t = toStr(s), k = Math.max(0, toNum(n) ?? 0); return k ? t.slice(-k) : ''; };
  F.replace = (s, a, b) => nn(s) ? null : (toStr(a) === '' ? toStr(s) : toStr(s).split(toStr(a)).join(toStr(b)));
  const rx = (p, fl) => { try { return new RegExp(toStr(p), fl); } catch (e) { return null; } };
  F.regexp_replace = (s, p, r) => { if (nn(s)) return null; const R = rx(p, 'g'); return R ? toStr(s).replace(R, toStr(r)) : toStr(s); };
  F.regexp_substr = (s, p) => { if (nn(s)) return null; const R = rx(p, ''), m = R && R.exec(toStr(s)); return m ? (m[1] !== undefined ? m[1] : m[0]) : null; };
  F.regexp_match = (s, p) => { const R = rx(p, ''); return !!(R && !nn(s) && R.test(toStr(s))); };
  F.strpos = (s, t) => nn(s) ? null : toStr(s).indexOf(toStr(t)) + 1;
  F.contains = (s, t) => !nn(s) && toStr(s).includes(toStr(t));
  F.starts_with = (s, t) => !nn(s) && toStr(s).startsWith(toStr(t));
  F.ends_with = (s, t) => !nn(s) && toStr(s).endsWith(toStr(t));
  F.lpad = (s, n, c) => nn(s) ? null : toStr(s).padStart(toNum(n) ?? 0, toStr(c) || ' ');
  F.rpad = (s, n, c) => nn(s) ? null : toStr(s).padEnd(toNum(n) ?? 0, toStr(c) || ' ');
  F.repeat = (s, n) => nn(s) ? null : toStr(s).repeat(Math.max(0, toNum(n) ?? 0));
  F.concat = (...a) => a.map(toStr).join('');
  F.char = n => String.fromCharCode(toNum(n) ?? 32);
  F.format_number = (n, p) => {
    const x = toNum(n); if (x === null) return null;
    const d = Math.max(0, Math.min(10, toNum(p) ?? 2));
    return x.toLocaleString('pt-BR', {minimumFractionDigits: d, maximumFractionDigits: d});
  };
  F.to_string = v => nn(v) ? null : toStr(v);
  F.to_real = F.to_number = v => toNum(v);
  F.to_int = v => { const x = toNum(v); return x === null ? null : Math.trunc(x); };
  F.abs = v => { const x = toNum(v); return x === null ? null : Math.abs(x); };
  F.round = (v, n) => { const x = toNum(v); if (x === null) return null; const k = Math.pow(10, toNum(n) ?? 0); return Math.round(x * k) / k; };
  F.floor = v => { const x = toNum(v); return x === null ? null : Math.floor(x); };
  F.ceil = v => { const x = toNum(v); return x === null ? null : Math.ceil(x); };
  F.sqrt = v => { const x = toNum(v); return x === null || x < 0 ? null : Math.sqrt(x); };
  F.min = (...a) => { const v = a.map(toNum).filter(x => x !== null); return v.length ? Math.min(...v) : null; };
  F.max = (...a) => { const v = a.map(toNum).filter(x => x !== null); return v.length ? Math.max(...v) : null; };
  F.nullif = (a, b) => eq(a, b) ? null : a;
  F.is_null = F.isnull = v => nz(v);
  const vazioRede = v => nz(v) || toStr(v) === '0' || toStr(v).toUpperCase() === 'NULO';
  F.uniq_join = (sep, ...a) => [...new Set(a.filter(v => !vazioRede(v)).map(toStr))].join(toStr(sep));
  F.join = (sep, ...a) => a.filter(v => !nz(v)).map(toStr).join(toStr(sep));
  const ABREV = {'DUPLO T': 'DT', 'CIRCULAR': 'CIR', 'RETANGULAR': 'RET', 'FANTASMA': 'FAN', 'FLY': 'FLY', 'TORRE AUTOPORTANTE': 'TA', 'T': 'T'};
  F.sigla = s => {
    if (nz(s)) return '';
    const T = toStr(s).toUpperCase();
    return ABREV[T] || (/\s/.test(T) ? T.split(/\s+/).map(p => p[0]).join('') : T.slice(0, 3));
  };

  // ---------- léxico ----------
  function lex(s) {
    const T = []; let i = 0; const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c <= ' ') { i++; continue; }
      if (c === "'" || c === '"') {
        const q = c; let j = i + 1, v = '';
        for (;;) {
          if (j >= n) throw new Error('Aspas ' + (q === "'" ? 'simples' : 'duplas') + ' sem fechar (posição ' + (i + 1) + ')');
          const d = s[j];
          if (d === q) { if (s[j + 1] === q) { v += q; j += 2; continue; } break; }
          if (d === '\\' && q === "'" && j + 1 < n) { const e = s[j + 1]; v += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; continue; }
          v += d; j++;
        }
        T.push({t: q === "'" ? 's' : 'f', v, p: i}); i = j + 1; continue;
      }
      let r;
      if ((c >= '0' && c <= '9') || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
        RNUM.lastIndex = i; r = RNUM.exec(s);
        if (r) { T.push({t: 'n', v: parseFloat(r[0]), p: i}); i += r[0].length; continue; }
      }
      if (c === '@' || c === '$') {
        RVAR.lastIndex = i; r = RVAR.exec(s);
        if (r) { T.push({t: 'v', v: r[0], p: i}); i += r[0].length; continue; }
      }
      RID.lastIndex = i; r = RID.exec(s);
      if (r) {
        const up = r[0].toUpperCase();
        T.push(KW.has(up) ? {t: 'k', v: up, p: i} : {t: 'i', v: r[0], p: i}); i += r[0].length; continue;
      }
      const two = s.substr(i, 2);
      if (['||', '<=', '>=', '<>', '!='].includes(two)) { T.push({t: 'o', v: two, p: i}); i += 2; continue; }
      if ('+-*/%^(),=<>'.includes(c)) { T.push({t: 'o', v: c, p: i}); i++; continue; }
      throw new Error('Caractere inesperado "' + c + '" (posição ' + (i + 1) + ')');
    }
    return T;
  }

  // ---------- sintaxe ----------
  function parse(src) {
    const T = lex(src); let k = 0;
    const at = () => T[k] ? ' perto da posição ' + (T[k].p + 1) : ' no fim da expressão';
    const kw = w => T[k] && T[k].t === 'k' && T[k].v === w;
    const op = o => T[k] && T[k].t === 'o' && T[k].v === o;
    const need = o => { if (!op(o)) throw new Error('Esperado "' + o + '"' + at()); k++; };
    const args = () => { const a = []; if (!op(')')) { do { a.push(or()); } while (op(',') && ++k); } need(')'); return a; };
    const or = () => { let a = and(); while (kw('OR')) { k++; a = {t: 'or', a, b: and()}; } return a; };
    const and = () => { let a = not(); while (kw('AND')) { k++; a = {t: 'and', a, b: not()}; } return a; };
    const not = () => { if (kw('NOT')) { k++; return {t: 'not', a: not()}; } return cmp(); };
    const cmp = () => {
      let a = cat();
      for (;;) {
        const t = T[k];
        if (t && t.t === 'o' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) { k++; a = {t: 'cmp', o: t.v === '!=' ? '<>' : t.v, a, b: cat()}; }
        else if (kw('IS')) {
          k++; let neg = false; if (kw('NOT')) { k++; neg = true; }
          if (!kw('NULL')) throw new Error('Esperado NULL depois de IS' + at());
          k++; a = {t: 'isnull', a, neg};
        } else {
          let neg = false; const p = k;
          if (kw('NOT')) { neg = true; k++; }
          if (kw('IN')) { k++; need('('); a = {t: 'in', a, list: args(), neg}; }
          else if (kw('LIKE') || kw('ILIKE')) { const ci = T[k].v === 'ILIKE'; k++; a = {t: 'like', a, b: cat(), neg, ci}; }
          else { k = p; break; }
        }
      }
      return a;
    };
    const cat = () => { let a = add(); while (op('||')) { k++; a = {t: 'cat', a, b: add()}; } return a; };
    const add = () => { let a = mul(); while (op('+') || op('-')) { const o = T[k++].v; a = {t: 'bin', o, a, b: mul()}; } return a; };
    const mul = () => { let a = unary(); while (op('*') || op('/') || op('%')) { const o = T[k++].v; a = {t: 'bin', o, a, b: unary()}; } return a; };
    const unary = () => { if (op('-')) { k++; return {t: 'neg', a: unary()}; } if (op('+')) { k++; return unary(); } return pow(); };
    const pow = () => { const a = prim(); if (op('^')) { k++; return {t: 'bin', o: '^', a, b: unary()}; } return a; };
    const prim = () => {
      const t = T[k];
      if (!t) throw new Error('Expressão incompleta');
      k++;
      if (t.t === 'n' || t.t === 's') return {t: 'lit', v: t.v};
      if (t.t === 'f') return {t: 'fld', n: t.v};
      if (t.t === 'v') return {t: 'var', n: t.v};
      if (t.t === 'k') {
        if (t.v === 'TRUE') return {t: 'lit', v: true};
        if (t.v === 'FALSE') return {t: 'lit', v: false};
        if (t.v === 'NULL') return {t: 'lit', v: null};
        if (t.v === 'CASE') {
          const w = []; let els = null;
          while (kw('WHEN')) { k++; const c = or(); if (!kw('THEN')) throw new Error('Esperado THEN' + at()); k++; w.push([c, or()]); }
          if (kw('ELSE')) { k++; els = or(); }
          if (!kw('END')) throw new Error('CASE sem END' + at());
          k++; return {t: 'case', w, els};
        }
        throw new Error('Palavra reservada inesperada "' + t.v + '" (posição ' + (t.p + 1) + ')');
      }
      if (t.t === 'o' && t.v === '(') { const e = or(); need(')'); return e; }
      if (t.t === 'i') {
        if (op('(')) { k++; return {t: 'call', n: t.v.toLowerCase(), args: args()}; }
        return {t: 'fld', n: t.v};
      }
      throw new Error('Símbolo inesperado "' + t.v + '" (posição ' + (t.p + 1) + ')');
    };
    const e = or();
    if (k < T.length) throw new Error('Sobrou texto na expressão' + at());
    return e;
  }

  // ---------- compilação ----------
  function comp(n) {
    switch (n.t) {
      case 'lit': { const v = n.v; return () => v; }
      case 'fld': { const nm = n.n.toUpperCase(); return c => c.fld(nm); }
      case 'var': { const nm = n.n.toLowerCase(); return c => { const f = api.vars[nm]; return f ? f(c) : null; }; }
      case 'neg': { const a = comp(n.a); return c => { const x = toNum(a(c)); return x === null ? null : -x; }; }
      case 'not': { const a = comp(n.a); return c => !truthy(a(c)); }
      case 'or': { const a = comp(n.a), b = comp(n.b); return c => truthy(a(c)) || truthy(b(c)); }
      case 'and': { const a = comp(n.a), b = comp(n.b); return c => truthy(a(c)) && truthy(b(c)); }
      case 'cmp': {
        const a = comp(n.a), b = comp(n.b), o = n.o;
        return c => {
          const x = a(c), y = b(c);
          switch (o) {
            case '=': return eq(x, y); case '<>': return !eq(x, y);
            case '<': return lt(x, y); case '>': return lt(y, x);
            case '<=': return lt(x, y) || eq(x, y); default: return lt(y, x) || eq(x, y);
          }
        };
      }
      case 'isnull': { const a = comp(n.a), g = n.neg; return c => nz(a(c)) !== g; }
      case 'in': { const a = comp(n.a), l = n.list.map(comp), g = n.neg; return c => { const x = a(c); return l.some(f => eq(x, f(c))) !== g; }; }
      case 'like': { const a = comp(n.a), b = comp(n.b), g = n.neg, ci = n.ci; return c => { const x = a(c); if (nn(x)) return false; return likeRe(b(c), ci).test(toStr(x)) !== g; }; }
      case 'cat': { const a = comp(n.a), b = comp(n.b); return c => toStr(a(c)) + toStr(b(c)); }
      case 'bin': { const a = comp(n.a), b = comp(n.b), o = n.o; return c => arith(o, a(c), b(c)); }
      case 'case': {
        const w = n.w.map(([x, y]) => [comp(x), comp(y)]), e = n.els ? comp(n.els) : null;
        return c => { for (const [x, y] of w) if (truthy(x(c))) return y(c); return e ? e(c) : null; };
      }
      case 'call': {
        const nm = n.n, a = n.args.map(comp);
        if (nm === 'if') return c => truthy(a[0] ? a[0](c) : null) ? (a[1] ? a[1](c) : null) : (a[2] ? a[2](c) : null);
        if (nm === 'coalesce') return c => { for (const f of a) { const v = f(c); if (!nz(v)) return v; } return null; };
        if (F[nm]) { const fn = F[nm]; return c => fn(...a.map(f => f(c))); }
        if (api.ctxFns[nm]) return c => api.ctxFns[nm](c, ...a.map(f => f(c)));
        throw new Error('Função desconhecida: ' + nm + '()');
      }
    }
    throw new Error('Nó inválido');
  }

  const cache = new Map();
  function compile(src) {
    let r = cache.get(src);
    if (r) return r;
    try { r = {fn: comp(parse(src)), err: null}; } catch (e) { r = {fn: null, err: e.message}; }
    if (cache.size > 800) cache.clear();
    cache.set(src, r);
    return r;
  }

  const DOC = [
    ['Texto', [
      ["upper(x)", 'Maiúsculas'], ["lower(x)", 'Minúsculas'], ["title(x)", 'Iniciais maiúsculas'], ["trim(x)", 'Remove espaços'],
      ["length(x)", 'Nº de caracteres'], ["substr(x, 1, 3)", 'Trecho (início a partir de 1)'], ["left(x, 3)", 'Primeiros caracteres'], ["right(x, 3)", 'Últimos caracteres'],
      ["replace(x, 'a', 'b')", 'Substituir texto'], ["regexp_replace(x, '\\\\s+', ' ')", 'Substituir por regex'], ["regexp_substr(x, '(\\\\d+)')", 'Extrair por regex'],
      ["lpad(x, 5, '0')", 'Completar à esquerda'], ["concat(a, b)", 'Concatenar'], ["'\\n'", 'Quebra de linha (ou char(10))'],
      ["sigla(x)", 'Abrevia tipo de poste (DUPLO T → DT)'], ["uniq_join('/', a, b, c)", 'Junta valores distintos (ignora 0 e NULO)'], ["join(' ', a, b)", 'Junta valores não vazios']]],
    ['Números', [
      ["to_real(x)", 'Converte para número'], ["to_int(x)", 'Inteiro'], ["round(x, 1)", 'Arredonda'], ["format_number(x, 1)", 'Formata (1.234,5)'],
      ["abs(x)", 'Módulo'], ["floor(x)", 'Arredonda p/ baixo'], ["ceil(x)", 'Arredonda p/ cima'], ["min(a, b)", 'Mínimo'], ["max(a, b)", 'Máximo'], ["sqrt(x)", 'Raiz']]],
    ['Lógica', [
      ["if(cond, a, b)", 'Se / senão'], ["CASE WHEN cond THEN a WHEN cond2 THEN b ELSE c END", 'Vários casos'], ["coalesce(a, b, c)", 'Primeiro valor não vazio'],
      ["nullif(a, b)", 'NULL se a = b'], ["x IS NULL", 'Está vazio'], ["x IN ('A', 'B')", 'Está na lista'], ["x LIKE 'TRAFO%'", 'Padrão (% qualquer texto)'], ["a AND b / a OR b / NOT a", 'Operadores']]],
    ['Variáveis e geometria', [
      ["$length", 'Comprimento da linha em metros'], ["$x", 'Longitude'], ["$y", 'Latitude'], ["$angle", 'Ângulo (NU_ANGULO)'], ["$id", 'Nº da linha no CSV'], ["@layer", 'poste / inst / bt / mt'],
      ["attribute('NU_ALTURA')", 'Valor de um campo pelo nome']]],
    ['Relações entre camadas', [
      ["n_inst()", 'Poste: nº de instalações'], ["inst_attr('NU_INSTALA', ', ')", 'Poste: valores das instalações'], ["n_trechos('bt')", "Poste: nº de trechos ('bt' ou 'mt')"],
      ["poste_attr('NU_ALTURA')", 'Instalação: campo do poste'], ["poste_ini('NU_ALTURA')", 'Trecho: campo do poste inicial'], ["poste_fin('NU_ALTURA')", 'Trecho: campo do poste final']]]
  ];

  return Object.assign(api, {compile, F, toNum, toStr, truthy, eq, DOC, parse});
})();
