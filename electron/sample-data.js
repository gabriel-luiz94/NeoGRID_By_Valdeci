'use strict';

function buildSampleData() {
  const poles = [];
  const bt = [];
  const mt = [];
  const installations = [];
  const baseLon = -34.902;
  const baseLat = -8.052;
  const stepLon = 0.00062;
  const stepLat = 0.00046;
  const cols = 34;
  const rows = 24;
  const poleId = (x, y) => String(210000 + y * cols + x);
  const coord = (x, y) => [
    (baseLon + x * stepLon + Math.sin(y * 1.7 + x) * 0.000035).toFixed(7),
    (baseLat + y * stepLat + Math.cos(x * 1.3) * 0.00003).toFixed(7),
  ];
  const materials = ['CONCRETO', 'CONCRETO', 'CONCRETO', 'DUPLO T', 'CIRCULAR'];
  const poleTypes = ['DT', 'CIR', 'RET', 'DT', 'TA'];
  const poleHeights = ['12', '11', '13', '12', '12', '9'];
  const efforts = ['300', '200', '600', '300', '1000'];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = poleId(x, y);
      const [lon, lat] = coord(x, y);
      const broken = (x === 6 && y === 3) || (x === 7 && y === 3) || (x === 14 && y === 9) || (x === 22 && y === 17);
      poles.push([
        id,
        broken ? '' : lon,
        broken ? '' : lat,
        x % 9 === 0 ? '0' : '15',
        poleHeights[(x + y) % poleHeights.length],
        efforts[(x * 2 + y) % efforts.length],
        x % 7 === 0 ? 'BT + MT' : 'BT',
        materials[(x + y * 2) % materials.length],
        poleTypes[(x + y) % poleTypes.length],
        (x + y) % 6 === 0 ? `INS-${id}` : '',
      ].join(';'));

      if (x < cols - 1) {
        const [lon2, lat2] = coord(x + 1, y);
        const a = coord(x, y);
        const b = coord(x + 1, y);
        const length = (Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1])) * 111320).toFixed(1);
        bt.push([
          `BT-${id}-${poleId(x + 1, y)}`,
          id,
          poleId(x + 1, y),
          'CAA 185',
          'CAA 185',
          'CAA 185',
          'CAA 70',
          length,
          `LINESTRING (${a[0]} ${a[1]}, ${b[0]} ${b[1]})`,
          '3F+N',
          '',
        ].join(';'));
      }
      if (y < rows - 1 && (x + y) % 3 !== 0) {
        const [lon2, lat2] = coord(x, y + 1);
        const a = coord(x, y);
        const b = coord(x, y + 1);
        const length = (Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1])) * 111320).toFixed(1);
        bt.push([
          `BT-${id}-${poleId(x, y + 1)}`,
          id,
          poleId(x, y + 1),
          'CAA 70',
          'CAA 70',
          '',
          'CAA 70',
          length,
          `LINESTRING (${a[0]} ${a[1]}, ${b[0]} ${b[1]})`,
          '2F+N',
          '',
        ].join(';'));
      }
      if (y === 4 || y === 12 || y === 20) {
        if (x < cols - 1) {
          const a = coord(x, y);
          const b = coord(x + 1, y);
          const length = (Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1])) * 111320).toFixed(1);
          mt.push([
            `MT-${id}-${poleId(x + 1, y)}`,
            id,
            poleId(x + 1, y),
            'AL 185',
            'AL 185',
            'AL 185',
            '',
            length,
            `LINESTRING (${a[0]} ${a[1]}, ${b[0]} ${b[1]})`,
            '3F',
            '',
          ].join(';'));
        }
      }
      if ((x * 3 + y) % 11 === 0) {
        const kinds = ['TRAFO', 'CHAVE FUSIVEL RELIGADORA', 'CHAVE FACA', 'TRAFO', 'CHAVE FUSIVEL RELIGADORA'];
        const kind = kinds[(x + y) % kinds.length];
        installations.push([
          `INS-${id}`,
          kind,
          kind === 'TRAFO' ? ['112,5 kVA', '75 kVA', '150 kVA'][(x + y) % 3] : (x % 2 ? 'CH-01' : 'CH-02'),
          id,
          coord(x, y)[0],
          coord(x, y)[1],
          '0',
          kind,
        ].join(';'));
      }
    }
  }

  const postes = ['NU_PG_ID;GEO_X;GEO_Y;NU_ANGULO;NU_ALTURA;NU_ESFORCO;DE_BARRAMEN;MATERIAL;TIPO_PG;NU_INSTALA', ...poles].join('\r\n');
  const redeBt = ['NU_TRECHO;NU_PG_INI;NU_PG_FIN;CONDUTOR_A;CONDUTOR_B;CONDUTOR_C;CONDUTOR_N;NU_COMPRIMENTO_REAL;GEOMETRIA_WKT;CD_FASE;NU_INSTALA', ...bt].join('\r\n');
  const redeMt = ['NU_TRECHO;NU_PG_INI;NU_PG_FIN;CONDUTOR_A;CONDUTOR_B;CONDUTOR_C;CONDUTOR_N;NU_COMPRIMENTO_REAL;GEOMETRIA_WKT;CD_FASE;NU_INSTALA', ...mt].join('\r\n');
  const instalacoes = ['NU_INSTALA;TIPO_INSTA;DE_PLACA;NU_PG_ID;GEO_X;GEO_Y;NU_ANGULO;TIPO_SIGLA', ...installations].join('\r\n');
  return { postes, redeBt, redeMt, instalacoes };
}

module.exports = { buildSampleData };
