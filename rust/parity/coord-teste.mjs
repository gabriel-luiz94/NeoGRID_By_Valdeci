// Testa o interpretador de coordenadas da barra de pesquisa. Uso: node rust/parity/coord-teste.mjs
import { describeCoordinate, parseCoordinateQuery, utmParaLatLon } from '../../src/js/core/format.js';

let falhas = 0;
const ok = (nome, passou, extra = '') => {
  if (!passou) falhas += 1;
  console.log(`${passou ? 'ok  ' : 'FALHA'} ${nome}${extra ? ` ${extra}` : ''}`);
};
const perto = (a, b, tolerancia = 1e-6) => Math.abs(a - b) <= tolerancia;

// Projeção direta igual à do motor (src/js/projeto/10-base.js), para conferir a volta.
function utm(lat, lon, Z) {
  const RAD = Math.PI / 180;
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep = e2 / (1 - e2);
  const p = lat * RAD, dl = (lon - ((Z - 1) * 6 - 180 + 3)) * RAD, sn = Math.sin(p), cs = Math.cos(p), tn = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * sn * sn), T = tn * tn, C = ep * cs * cs, A = dl * cs;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - 35 * e2 ** 3 / 3072 * Math.sin(6 * p));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep) * A ** 5 / 120) + 500000;
  let y = k0 * (M + N * tn * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep) * A ** 6 / 720));
  if (lat < 0) y += 1e7;
  return [x, y];
}

// Ida e volta em pontos de Pernambuco, nos fusos 24 e 25.
for (const [lat, lon, Z] of [[-8.0615, -34.8925, 25], [-8.2838, -35.9758, 25], [-9.3891, -40.5003, 24], [-7.5, -38.2, 24], [-8.05, -36.5, 24]]) {
  const [x, y] = utm(lat, lon, Z);
  const [la, lo] = utmParaLatLon(x, y, Z, true);
  const erro = Math.hypot((la - lat) * 111000, (lo - lon) * 110000);
  ok(`ida e volta ${lat},${lon} fuso ${Z}`, erro < 0.01, `erro ${(erro * 100).toFixed(3)} cm`);
}

// Formato do pedido: fuso, faixa, X e Y.
const [xr, yr] = utm(-8.0615, -34.8925, 25);
const texto = `25M ${xr.toFixed(0)} ${yr.toFixed(0)}`;
for (const consulta of [
  texto,
  texto.toLowerCase(),
  `25 M ${xr.toFixed(0)} ${yr.toFixed(0)}`,
  `25M  ${xr.toFixed(2)} m E ${yr.toFixed(2)} m S`,
  `25 M ${xr.toFixed(2).replace('.', ',')} ${yr.toFixed(2).replace('.', ',')}`,
  `25M ${xr.toFixed(0)},${yr.toFixed(0)}`,
  `25M ${xr.toFixed(0)}E ${yr.toFixed(0)}N`,
  `UTM ${texto}`,
  `25L ${xr.toFixed(0)} ${yr.toFixed(0)}`,
  `25S ${xr.toFixed(0)} ${yr.toFixed(0)}`,
]) {
  const r = describeCoordinate(consulta);
  ok(`UTM "${consulta}"`, r && !r.erro && perto(r.lat, -8.0615, 2e-5) && perto(r.lon, -34.8925, 2e-5), JSON.stringify(r));
}
ok('rótulo do UTM pode ser digitado de novo', (() => {
  const a = describeCoordinate(texto);
  const b = describeCoordinate(a.label);
  return b && !b.erro && perto(a.lat, b.lat) && perto(a.lon, b.lon);
})());

// O exemplo do pedido tem valores fora do UTM: avisa em vez de levar a um lugar errado.
for (const consulta of ['25M 5151515 51515151', '61M 289000 9108000', '25I 289000 9108000', '25N 289000 9108000', '25M 50000 9108000', '25C 289000 9108000']) {
  const r = describeCoordinate(consulta);
  ok(`UTM inválido "${consulta}"`, Boolean(r?.erro), r?.erro || JSON.stringify(r));
}
ok('X e Y sem fuso pedem o fuso', /fuso/.test(describeCoordinate('289000 9108000')?.erro || ''));

// Geográficas continuam valendo.
for (const consulta of ['-8.0615, -34.8925', '-8.0615 -34.8925', '-8,0615 -34,8925', '-8,0615; -34,8925', '-34.8925, -8.0615', '-34,8925 -8,0615']) {
  const c = parseCoordinateQuery(consulta);
  ok(`geográfica "${consulta}"`, c && perto(c[0], -8.0615) && perto(c[1], -34.8925), JSON.stringify(c));
}
for (const consulta of [`8°03'41.4"S 34°53'33"W`, `8°03'41.4"S 34°53'33"O`, `34°53'33"W 8°03'41.4"S`, `8 03 41.4 S 34 53 33 O`]) {
  const c = parseCoordinateQuery(consulta);
  ok(`graus e minutos "${consulta}"`, c && perto(c[0], -8.0615, 1e-4) && perto(c[1], -34.8925, 1e-4), JSON.stringify(c));
}
const h = parseCoordinateQuery('8,0615 S 34,8925 O');
ok('decimal com hemisfério', h && perto(h[0], -8.0615) && perto(h[1], -34.8925), JSON.stringify(h));

// Códigos e endereços não podem virar coordenada.
for (const consulta of ['H044357', 'T18120', 'B019195', '42666', '10758734', 'Rua do Sol 100', 'Av. Norte 25', 'BR 232', '25M']) {
  const r = describeCoordinate(consulta);
  ok(`não é coordenada "${consulta}"`, r === null, JSON.stringify(r));
}

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
