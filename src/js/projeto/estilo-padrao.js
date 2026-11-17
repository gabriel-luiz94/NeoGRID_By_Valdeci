/* Estilo padrão do NeoGrid.
 *
 * Gerado a partir de "Estilos → Geral → Exportar configuração" e embutido como
 * padrão de fábrica: vale para instalações novas e para "Restaurar tudo ao
 * padrão". Só os blocos usados pelas regras foram incluídos (o arquivo de
 * origem tinha 629 blocos; aqui ficam 4).
 *
 * Para trocar o padrão, substitua o objeto abaixo (ou gere de novo a partir do
 * JSON exportado) e recompile.
 */
const ESTILO_PADRAO = {
 "cfg": {
  "v": 2,
  "cam": {
   "poste": {
    "base": {
     "forma": "bloco",
     "tam": 14,
     "tamh": 7,
     "cor": "#333333",
     "borda": "#08141c",
     "bordaW": 1,
     "larg": 3,
     "opac": 1,
     "girar": true,
     "angOff": 0,
     "zoomEsc": true,
     "bloco": "pg.Concreto.Duplo_T.nao",
     "blocoModo": "ajustar",
     "blocoK": 1,
     "atrib": "NU_PG_ID\nNU_ALTURA\nNU_ESFORCO\nDE_BARRAMENTO"
    },
    "rules": [
     {
      "nome": "Regra 1",
      "on": true,
      "expr": "   upper(coalesce(\"TIPO_PG\",\"CD_TIPO_PG_DESC\",'')) LIKE 'CIR%'",
      "camada": "",
      "est": {
       "forma": "bloco",
       "tam": 10,
       "bloco": "pg.Concreto.Circular.nao",
       "blocoModo": "original"
      }
     },
     {
      "nome": "Regra 2",
      "on": true,
      "expr": "upper(coalesce(\"TIPO_PG\",\"CD_TIPO_PG_DESC\",'')) LIKE 'FAN%'",
      "camada": "",
      "est": {
       "forma": "circ",
       "cor": "#e5e1d7",
       "tam": 10
      }
     },
     {
      "nome": "Regra 3",
      "on": true,
      "expr": "upper(coalesce(\"MATERIAL\",\"CD_INDD_MATERIAL_PG_DESC\",'')) LIKE '%FIBRA%'",
      "camada": "",
      "est": {
       "tam": 10,
       "forma": "bloco",
       "bloco": "pg.Concreto.Circular.nao",
       "cor": "#000000"
      }
     }
    ],
    "labels": [
     {
      "on": true,
      "nome": "Altura/esforço",
      "filtro": "",
      "expr": "\"DE_BARRAMENTO\"||'\\n'||coalesce(\"NU_ALTURA\",'?')  || coalesce(\"NU_ESFORCO\",'?')||upper(left(coalesce(\"TIPO_PG\",\"CD_TIPO_PG_DESC\"),1))",
      "fonte": "Arial",
      "tam": 11,
      "neg": false,
      "ital": false,
      "cor": "#000000",
      "corExpr": "",
      "halo": false,
      "haloCor": "#03080c",
      "haloW": 1,
      "alinh": "esq",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#17303f",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "dir",
      "modo": "horizontal",
      "lado": "acima",
      "ancora": "meio",
      "dist": 9,
      "dx": 0,
      "dy": 0,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 17,
      "maxZ": 22,
      "colisao": true,
      "prior": 0,
      "camada": "TXT_POSTES",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   },
   "inst": {
    "base": {
     "forma": "circ",
     "tam": 10,
     "tamh": 7,
     "cor": "#a78bfa",
     "borda": "#08141c",
     "bordaW": 1.5,
     "larg": 3,
     "opac": 1,
     "girar": true,
     "angOff": 0,
     "zoomEsc": true,
     "bloco": "",
     "blocoModo": "ajustar",
     "blocoK": 1,
     "atrib": "NU_INSTALA\nTIPO_INSTA\nDE_PLACA"
    },
    "rules": [
     {
      "nome": "Chave fusível religadora",
      "on": true,
      "expr": "upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE 'CHAVE FUSIVEL RELIGADORA%'",
      "camada": "",
      "est": {
       "forma": "quad",
       "tam": 14,
       "bordaW": 1.5
      }
     },
     {
      "nome": "Transformador",
      "on": true,
      "expr": "upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE 'TRAFO%'",
      "camada": "",
      "est": {
       "forma": "bloco",
       "tam": 23,
       "cor": "#ff0000",
       "girar": true,
       "zoomEsc": true,
       "bloco": "INSTALACAOMT.TRAFO_CIA_AEREO.FECHADO",
       "blocoModo": "original",
       "blocoK": 0.7
      }
     },
     {
      "nome": "Chave",
      "on": true,
      "expr": "upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE 'CHAVE%'",
      "camada": "",
      "est": {
       "forma": "bloco",
       "tam": 20,
       "larg": 4,
       "cor": "#ff0000",
       "girar": true,
       "zoomEsc": true,
       "bloco": "INSTALACAOMT.CHAVE_FUSIVEL_MONOPOLAR.FECHADO"
      }
     }
    ],
    "labels": [
     {
      "on": true,
      "nome": "Tipo e placa",
      "filtro": "",
      "expr": "CASE\n WHEN regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'RELIGAD') THEN 'RL'\n WHEN regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'TRAFO|TRANSFORM')\n      AND regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'A.REO')\n      AND to_real(\"KVA_TOTAL\") > 0 THEN format_number(to_real(\"KVA_TOTAL\"), 0) || ' kVA'\n WHEN regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'CHAVE FUS.VEL')\n      AND regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'MONOPOLAR') THEN 'CFU'\n WHEN regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'SECCIONADOR')\n      AND regexp_match(upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')), 'MONOPOLAR') THEN 'CFA'\n ELSE coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\")\n      || if(to_real(\"KVA_TOTAL\") > 0, ' ' || format_number(to_real(\"KVA_TOTAL\"), 1) || ' kVA', '')\nEND || if(length(coalesce(\"DE_PLACA\",'')) > 0, '\\n' || \"DE_PLACA\", '')",
      "fonte": "Inter Variable",
      "tam": 13,
      "neg": true,
      "ital": false,
      "cor": "#990099",
      "corExpr": "",
      "halo": true,
      "haloCor": "#03080c",
      "haloW": 3,
      "alinh": "dir",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#17303f",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "esq",
      "modo": "horizontal",
      "lado": "acima",
      "ancora": "meio",
      "dist": 12,
      "dx": 0,
      "dy": -3,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 17,
      "maxZ": 22,
      "colisao": true,
      "prior": 1,
      "camada": "TXT_INSTALACOES",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   },
   "kmlp": {
    "base": {
     "forma": "circ",
     "tam": 10,
     "tamh": 7,
     "cor": "#f472b6",
     "borda": "#08141c",
     "bordaW": 1.5,
     "larg": 3,
     "opac": 1,
     "girar": false,
     "angOff": 0,
     "zoomEsc": false,
     "bloco": "",
     "blocoModo": "ajustar",
     "blocoK": 1,
     "atrib": "NOME\nDESCRICAO\nPASTA",
     "corKml": true
    },
    "rules": [],
    "labels": [
     {
      "on": true,
      "nome": "Nome",
      "filtro": "",
      "expr": "\"NOME\"",
      "fonte": "Inter Variable",
      "tam": 11,
      "neg": true,
      "ital": false,
      "cor": "#00e08a",
      "corExpr": "",
      "halo": true,
      "haloCor": "#03080c",
      "haloW": 3,
      "alinh": "esq",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#17303f",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "dir",
      "modo": "horizontal",
      "lado": "acima",
      "ancora": "meio",
      "dist": 9,
      "dx": 0,
      "dy": 0,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 17,
      "maxZ": 22,
      "colisao": true,
      "prior": 0,
      "camada": "TXT_KML",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   },
   "kmll": {
    "base": {
     "cor": "#38bdf8",
     "larg": 2,
     "dash": "",
     "opac": 1,
     "cap": "round",
     "casing": false,
     "casingCor": "#000000",
     "casingW": 1.5,
     "zoomEsc": true,
     "corKml": true
    },
    "rules": [],
    "labels": [
     {
      "on": true,
      "nome": "Nome",
      "filtro": "",
      "expr": "\"NOME\"",
      "fonte": "Inter Variable",
      "tam": 11,
      "neg": true,
      "ital": false,
      "cor": "#ffd9a0",
      "corExpr": "",
      "halo": true,
      "haloCor": "#03080c",
      "haloW": 3,
      "alinh": "cen",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#17303f",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "dir",
      "modo": "alinhado",
      "lado": "acima",
      "ancora": "meio",
      "dist": 1,
      "dx": 0,
      "dy": 0,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 18,
      "maxZ": 22,
      "colisao": true,
      "prior": 2,
      "camada": "TXT_KML",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   },
   "bt": {
    "base": {
     "cor": "#00ff00",
     "larg": 1,
     "dash": "",
     "opac": 1,
     "cap": "round",
     "casing": false,
     "casingCor": "#000000",
     "casingW": 1.5,
     "zoomEsc": true
    },
    "rules": [],
    "labels": [
     {
      "on": true,
      "nome": "Condutor e metragem",
      "filtro": "",
      "expr": "CASE\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = '3XM-70-CA'  THEN 'PB70'\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = '3XM-35-CA'  THEN 'PB35'\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = '3XM-120-CA' THEN 'PB120'\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = 'M-25'  THEN 'RAMA25'\n  ELSE uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")\nEND\n|| if(length(uniq_join('', \"CONDUTOR_N\")) > 0, ' + N ' || \"CONDUTOR_N\", '')\n|| ' ' ||\nformat_number(coalesce(nullif(to_real(\"NU_COMPRIMENTO_REAL\"),0), nullif(to_real(\"SHP_LENGTH\"),0), $length), 0) || ' m'",
      "fonte": "Arial",
      "tam": 11,
      "neg": false,
      "ital": false,
      "cor": "#00ff00",
      "corExpr": "",
      "halo": true,
      "haloCor": "#03080c",
      "haloW": 1,
      "alinh": "cen",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#17303f",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "so",
      "modo": "alinhado",
      "lado": "abaixo",
      "ancora": "meio",
      "dist": 1,
      "dx": 0,
      "dy": 0,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 17,
      "maxZ": 22,
      "colisao": true,
      "prior": 2,
      "camada": "TXT_BT",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   },
   "mt": {
    "base": {
     "cor": "#ff0000",
     "larg": 1,
     "dash": "",
     "opac": 1,
     "cap": "round",
     "casing": false,
     "casingCor": "#000000",
     "casingW": 1.5,
     "zoomEsc": true
    },
    "rules": [],
    "labels": [
     {
      "on": true,
      "nome": "Condutor e metragem",
      "filtro": "",
      "expr": "CASE\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = 'P-18' THEN '3xA185P-13,8kV'\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = 'P-35' THEN '3xA35P-13,8kV'\n  WHEN upper(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")) = 'P-70' THEN '3xA70P-13,8kV'\n  WHEN upper(left(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\"), 2)) = 'C-' THEN\n    '3xC' || substr(uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\"), 3)\n    || if(length(uniq_join('', \"CONDUTOR_N\")) > 0,\n          '(' || regexp_replace(uniq_join('', \"CONDUTOR_N\"), '^[Cc]-', '') || ')',\n          '')\n    || '-13,8kV'\n  ELSE uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")\n    || if(length(uniq_join('', \"CONDUTOR_N\")) > 0, ' + N ' || \"CONDUTOR_N\", '')\nEND\n|| ' ' ||\nformat_number(coalesce(nullif(to_real(\"NU_COMPRIMENTO_REAL\"),0), nullif(to_real(\"SHP_LENGTH\"),0), $length), 0) || ' m'",
      "fonte": "Arial",
      "tam": 11,
      "neg": true,
      "ital": false,
      "cor": "#ff0000",
      "corExpr": "",
      "halo": true,
      "haloCor": "#03080c",
      "haloW": 3,
      "alinh": "cen",
      "esp": 1.1,
      "bal": "nenhum",
      "balFill": "#f7f7f7",
      "balOp": 0.9,
      "balBorda": "#ffffff",
      "balBW": 1,
      "pad": 1,
      "pos": "dir",
      "modo": "alinhado",
      "lado": "acima",
      "ancora": "meio",
      "dist": 1,
      "dx": 0,
      "dy": 0,
      "rot": "nenhuma",
      "rotExpr": "",
      "rotOff": 0,
      "minZ": 17,
      "maxZ": 22,
      "colisao": true,
      "prior": 2,
      "camada": "TXT_MT",
      "dxfH": 1.2,
      "dxfW": 1
     }
    ]
   }
  },
  "dxf": {
   "escala": "1000",
   "origem": "abs",
   "simbBlocos": true,
   "atributos": true,
   "attInvisivel": true,
   "rotulos": true,
   "ruas": true,
   "ruasModo": "pista",
   "ruasAjustar": false,
   "ruasMargem": 0.3,
   "ruasMaxDesl": 8,
   "ruasRaio": 3,
   "ruasEncadear": true,
   "regrasPoste": {},
   "ruasLargMin": 65,
   "ruasFaixa": 3.2,
   "ruasOriginal": false,
   "ruasPrevia": true,
   "ruasEdit": [
    {
     "t": "mv",
     "lat": -7.995270943432742,
     "lon": -34.937247761116566,
     "R": 40,
     "vx": -0.6158843270968646,
     "vy": -0.720872800797224
    },
    {
     "t": "mv",
     "lat": -7.995267234432983,
     "lon": -34.937247761116566,
     "R": 40,
     "vx": 1.6494355028844438,
     "vy": 0.41803162917494774
    },
    {
     "t": "mv",
     "lat": -7.99527187068268,
     "lon": -34.937228104042646,
     "R": 40,
     "vx": 1.648952956078574,
     "vy": 0.5205971766263247
    },
    {
     "t": "mv",
     "lat": -7.995298760929686,
     "lon": -34.93721687142894,
     "R": 40,
     "vx": 0.8242351521621458,
     "vy": 0.31158137507736683
    },
    {
     "t": "bmv",
     "lat": -7.995276538160438,
     "lon": -34.93725046025811,
     "R": 40,
     "vx": -0.7316132637206465,
     "vy": -0.615395076572895
    },
    {
     "t": "bmv",
     "lat": -7.995281103024421,
     "lon": -34.937257650900854,
     "R": 40,
     "vx": 1.1907978992094286,
     "vy": 0.6165676936507225
    },
    {
     "t": "mv",
     "lat": -7.989084194654622,
     "lon": -34.932871659921936,
     "R": 40,
     "vx": 0.38423290802165866,
     "vy": -0.9418046083301306
    },
    {
     "t": "mv",
     "lat": -7.989085900767332,
     "lon": -34.93285788167769,
     "R": 40,
     "vx": 0.19078869454097003,
     "vy": -0.18782648630440235
    },
    {
     "t": "mv",
     "lat": -7.989087606879978,
     "lon": -34.932856159397154,
     "R": 40,
     "vx": 0.00708130223210901,
     "vy": -1.5097376815974712
    },
    {
     "t": "mv",
     "lat": -7.98909272521786,
     "lon": -34.932845825714004,
     "R": 40,
     "vx": 0.37980705476365983,
     "vy": 0.0017814412713050842
    },
    {
     "t": "mv",
     "lat": -7.989092725217875,
     "lon": -34.932842381152945,
     "R": 40,
     "vx": 0.0035406264942139387,
     "vy": -0.7548688370734453
    },
    {
     "t": "mv",
     "lat": -7.989244569214069,
     "lon": -34.93314894708706,
     "R": 40,
     "vx": 0.9512880669208243,
     "vy": -0.3729799631983042
    },
    {
     "t": "mv",
     "lat": -7.989532902040136,
     "lon": -34.93335562075049,
     "R": 40,
     "vx": -0.9521732278517447,
     "vy": 0.5616961698979139
    },
    {
     "t": "mv",
     "lat": -7.989140019613531,
     "lon": -34.933658962066175,
     "R": 40,
     "vx": -49.797405421268195,
     "vy": -4.634402520954609
    },
    {
     "t": "mv",
     "lat": -7.988689251242313,
     "lon": -34.930617079346646,
     "R": 40,
     "vx": -0.2756447541760281,
     "vy": 0.6756520010530949
    },
    {
     "t": "mv",
     "lat": -7.988683131409899,
     "lon": -34.93062202160307,
     "R": 40,
     "vx": -0.4118815279798582,
     "vy": 0.675013767555356
    },
    {
     "t": "mv",
     "lat": -7.988673339677901,
     "lon": -34.930617079346646,
     "R": 40,
     "vx": -0.2775474978843704,
     "vy": 1.0818091295659542
    },
    {
     "t": "mv",
     "lat": -7.988662323979094,
     "lon": -34.930619550474844,
     "R": 40,
     "vx": -0.2750105226878077,
     "vy": 0.5402663387358189
    },
    {
     "t": "mv",
     "lat": -7.988471385153023,
     "lon": -34.930430509166655,
     "R": 40,
     "vx": -0.0012683381792157888,
     "vy": 0.2707715015858412
    },
    {
     "t": "mv",
     "lat": -7.988344274467824,
     "lon": -34.930330496005325,
     "R": 40,
     "vx": -0.5506545523530804,
     "vy": 1.2159196082502604
    },
    {
     "t": "mv",
     "lat": -7.988609875329228,
     "lon": -34.93056154649311,
     "R": 40,
     "vx": 0.6818181194830686,
     "vy": -0.1321946680545807
    },
    {
     "t": "mv",
     "lat": -7.988617219129395,
     "lon": -34.93059243559576,
     "R": 40,
     "vx": 0.26676546479575336,
     "vy": 1.219747880473733
    },
    {
     "t": "bmv",
     "lat": -7.988601034619291,
     "lon": -34.930540133495676,
     "R": 40,
     "vx": 0.6394642219529487,
     "vy": -0.7041393462568521
    },
    {
     "t": "bmv",
     "lat": -7.988779283656695,
     "lon": -34.93066872623664,
     "R": 40,
     "vx": -0.717349800048396,
     "vy": 0.3182803299278021
    },
    {
     "t": "bmv",
     "lat": -7.9884833183995845,
     "lon": -34.93042994326233,
     "R": 40,
     "vx": 0.0622275480418466,
     "vy": 0.8894455544650555
    },
    {
     "t": "bmv",
     "lat": -7.988615321182609,
     "lon": -34.9305512165415,
     "R": 40,
     "vx": 0.43684318353189155,
     "vy": -0.11048564501106739
    },
    {
     "t": "bmv",
     "lat": -8.015635007853671,
     "lon": -34.92012100812442,
     "R": 40,
     "vx": -0.7889631695579737,
     "vy": 0.412250317633152
    },
    {
     "t": "bmv",
     "lat": -8.01586851059764,
     "lon": -34.92027078177328,
     "R": 40,
     "vx": -0.276953985914588,
     "vy": 0.09928668476641178
    },
    {
     "t": "mv",
     "lat": -8.015891354080768,
     "lon": -34.92008295467071,
     "R": 40,
     "vx": -1.2314638807438314,
     "vy": -1.6771649401634932
    },
    {
     "t": "mv",
     "lat": -8.015905669059508,
     "lon": -34.92011025210796,
     "R": 40,
     "vx": -0.4454778094077483,
     "vy": 0.6136992555111647
    },
    {
     "t": "mv",
     "lat": -8.015901692676577,
     "lon": -34.920102223449945,
     "R": 40,
     "vx": -0.6163487670128234,
     "vy": -0.7066321186721325
    },
    {
     "t": "bmv",
     "lat": -8.015877934700876,
     "lon": -34.920098076457194,
     "R": 40,
     "vx": -0.5422397073125467,
     "vy": -0.7432129550725222
    },
    {
     "t": "bmv",
     "lat": -8.015771135231947,
     "lon": -34.92020734170647,
     "R": 40,
     "vx": 0.7570685007958673,
     "vy": -0.6591252218931913
    },
    {
     "t": "bmv",
     "lat": -8.015778751764076,
     "lon": -34.92020144884381,
     "R": 40,
     "vx": 0.010633378871716559,
     "vy": -0.053332988172769547
    },
    {
     "t": "bmv",
     "lat": -8.015631402069815,
     "lon": -34.920123112031874,
     "R": 40,
     "vx": -0.36140428739599884,
     "vy": 0.061950795352458954
    },
    {
     "t": "bmv",
     "lat": -8.016009272354378,
     "lon": -34.91981642874101,
     "R": 40,
     "vx": -0.2983404587721452,
     "vy": -0.4940656963735819
    },
    {
     "t": "mv",
     "lat": -8.016094489636247,
     "lon": -34.919588753427625,
     "R": 40,
     "vx": 1.2442595360334963,
     "vy": -1.2249827329069376
    },
    {
     "t": "mv",
     "lat": -8.016101722156845,
     "lon": -34.91957976691307,
     "R": 40,
     "vx": 0.8718445022241212,
     "vy": -1.0421036053448915
    },
    {
     "t": "mv",
     "lat": -8.016103947547794,
     "lon": -34.91957302702718,
     "R": 40,
     "vx": 0.0020133356447331607,
     "vy": -0.43076994828879833
    },
    {
     "t": "mv",
     "lat": -8.01610450389552,
     "lon": -34.91957190371286,
     "R": 40,
     "vx": 0.18750177876790985,
     "vy": -0.36836310289800167
    },
    {
     "t": "mv",
     "lat": -8.016456175152578,
     "lon": -34.91915302069268,
     "R": 40,
     "vx": -0.7085917118238285,
     "vy": -2.873347630724311
    },
    {
     "t": "mv",
     "lat": -8.016468067249145,
     "lon": -34.91916066061846,
     "R": 40,
     "vx": 0.6106101887999102,
     "vy": -1.910504164174199
    },
    {
     "t": "mv",
     "lat": -8.016483202644249,
     "lon": -34.91914101509501,
     "R": 40,
     "vx": -0.11753982020309195,
     "vy": -0.598473472520709
    },
    {
     "t": "mv",
     "lat": -8.016479959345347,
     "lon": -34.91891509157529,
     "R": 40,
     "vx": -0.4818940669647418,
     "vy": 0.11733321845531464
    },
    {
     "t": "mv",
     "lat": -8.016479959345347,
     "lon": -34.91891509157529,
     "R": 40,
     "vx": -1.2038970613502897,
     "vy": 0.11395970359444618
    },
    {
     "t": "mv",
     "lat": -8.016586798871167,
     "lon": -34.91822772479295,
     "R": 40,
     "vx": 0.0027927266201004386,
     "vy": -0.5979107022285461
    },
    {
     "t": "mv",
     "lat": -8.016592229518015,
     "lon": -34.918207051765194,
     "R": 40,
     "vx": 0.36323540413286537,
     "vy": -0.4766424000263214
    },
    {
     "t": "mv",
     "lat": -8.016605202709888,
     "lon": -34.91808372153463,
     "R": 40,
     "vx": 0.24122597934911028,
     "vy": -0.1184580959379673
    },
    {
     "t": "mv",
     "lat": -8.01660412161058,
     "lon": -34.91824852564802,
     "R": 40,
     "vx": -0.11809953913325444,
     "vy": -0.47889060713350773
    },
    {
     "t": "mv",
     "lat": -8.016743755278094,
     "lon": -34.917818611284076,
     "R": 40,
     "vx": -2.831819318176713,
     "vy": -3.7294885516166687
    },
    {
     "t": "mv",
     "lat": -8.016622167238063,
     "lon": -34.91801727015916,
     "R": 40,
     "vx": 0.7056820472935215,
     "vy": 1.4190160557627678
    },
    {
     "t": "mv",
     "lat": -8.01686694312377,
     "lon": -34.917829917073725,
     "R": 40,
     "vx": -0.709814002388157,
     "vy": -0.5342095699161291
    },
    {
     "t": "mv",
     "lat": -8.016879741858808,
     "lon": -34.91782507173531,
     "R": 40,
     "vx": -0.7073347463738173,
     "vy": -1.0650926902890205
    },
    {
     "t": "mv",
     "lat": -8.017119041713338,
     "lon": -34.91778587870507,
     "R": 40,
     "vx": -1.0474448638851754,
     "vy": -1.1820785328745842
    },
    {
     "t": "mv",
     "lat": -8.017128501531996,
     "lon": -34.91778946000047,
     "R": 40,
     "vx": -1.84142730536405,
     "vy": -0.27019668743014336
    },
    {
     "t": "mv",
     "lat": -8.017137961350398,
     "lon": -34.917804978947196,
     "R": 40,
     "vx": -0.7866525303688832,
     "vy": -0.6576664615422487
    },
    {
     "t": "bmv",
     "lat": -8.017148983611795,
     "lon": -34.91783832269979,
     "R": 40,
     "vx": -0.7952424994437024,
     "vy": -0.7464756350964308
    },
    {
     "t": "bmv",
     "lat": -8.016759545019584,
     "lon": -34.91789537600424,
     "R": 40,
     "vx": -1.0837305246968754,
     "vy": -0.15551463514566422
    },
    {
     "t": "larg",
     "lat": -8.017147659009451,
     "lon": -34.91772890949961,
     "R": 40,
     "d": -1,
     "lado": -1
    },
    {
     "t": "larg",
     "lat": -8.017146827172732,
     "lon": -34.91773709138439,
     "R": 40,
     "d": -1,
     "lado": -1
    },
    {
     "t": "mv",
     "lat": -8.01715223018563,
     "lon": -34.91775246395366,
     "R": 40,
     "vx": -0.4056259060744196,
     "vy": 0.9941871576011181
    },
    {
     "t": "mv",
     "lat": -8.017154031189952,
     "lon": -34.917767091628534,
     "R": 40,
     "vx": -0.7048802962526679,
     "vy": 0.6939651928842068
    },
    {
     "t": "mv",
     "lat": -8.017148628177004,
     "lon": -34.91778163720142,
     "R": 40,
     "vx": -0.7039500073296949,
     "vy": 0.494753235951066
    },
    {
     "t": "mv",
     "lat": -8.016976757913866,
     "lon": -34.91784701646347,
     "R": 40,
     "vx": 1.1138900188961998,
     "vy": 0.8383193500339985
    },
    {
     "t": "mv",
     "lat": -8.017152686863703,
     "lon": -34.91779910684341,
     "R": 40,
     "vx": 0.0018237337935715914,
     "vy": -0.39051350951194763
    },
    {
     "t": "mv",
     "lat": -8.017156217357403,
     "lon": -34.91780053252169,
     "R": 40,
     "vx": 0.0036474726512096822,
     "vy": -0.7810270134359598
    },
    {
     "t": "mv",
     "lat": -8.017163278344748,
     "lon": -34.917804809556515,
     "R": 40,
     "vx": -0.38932051131268963,
     "vy": -0.7828622069209814
    },
    {
     "t": "mv",
     "lat": -8.017020646376904,
     "lon": -34.91763943087665,
     "R": 40,
     "vx": -0.07604064646875486,
     "vy": -0.5470860432833433
    },
    {
     "t": "mv",
     "lat": -8.017014997585095,
     "lon": -34.91762802545046,
     "R": 40,
     "vx": 0.001823540369514376,
     "vy": -0.39051360450685024
    },
    {
     "t": "bmv",
     "lat": -8.01696706789165,
     "lon": -34.91761047016144,
     "R": 40,
     "vx": 0.3424636480631307,
     "vy": -0.5744271706789732
    },
    {
     "t": "bmv",
     "lat": -8.01699162744753,
     "lon": -34.91782376757248,
     "R": 40,
     "vx": 0.9555707681574859,
     "vy": 0.7296675853431225
    },
    {
     "t": "bmv",
     "lat": -8.017102336507584,
     "lon": -34.91777025813118,
     "R": 40,
     "vx": -0.34030901262303814,
     "vy": 0.23099607415497303
    },
    {
     "t": "bmv",
     "lat": -8.01717526739024,
     "lon": -34.9177651568947,
     "R": 40,
     "vx": -0.47319898498244584,
     "vy": 2.091572817414999
    },
    {
     "t": "bmv",
     "lat": -8.017323305420227,
     "lon": -34.91777658971087,
     "R": 40,
     "vx": 0.8813001881353557,
     "vy": 0.3278875909745693
    },
    {
     "t": "bmv",
     "lat": -8.017318362545836,
     "lon": -34.91776918511037,
     "R": 40,
     "vx": -0.8524223057902418,
     "vy": 0.531905910000205
    },
    {
     "t": "blarg",
     "lat": -8.017051763717175,
     "lon": -34.917667025030745,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "blarg",
     "lat": -8.016965595792202,
     "lon": -34.91789521259519,
     "R": 40,
     "f": 0.5,
     "d": -1
    },
    {
     "t": "blarg",
     "lat": -8.016992519038801,
     "lon": -34.91788451596048,
     "R": 40,
     "f": 0.5,
     "d": -1
    },
    {
     "t": "bsua",
     "lat": -8.0170797992264,
     "lon": -34.91785135021427,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.017116141359848,
     "lon": -34.91784662125322,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.017133160311834,
     "lon": -34.917846836771886,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.017146494166033,
     "lon": -34.91784728411415,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.0171451369419,
     "lon": -34.9178484983988,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.01694748304119,
     "lon": -34.91781954245986,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.016933895454883,
     "lon": -34.91781616655278,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bsua",
     "lat": -8.017330908810871,
     "lon": -34.91777102819781,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bmv",
     "lat": -8.017454031407993,
     "lon": -34.91780166572027,
     "R": 40,
     "vx": 1.9112014057463966,
     "vy": -0.022555172443389893
    },
    {
     "t": "mv",
     "lat": -8.01842332424922,
     "lon": -34.917616701222926,
     "R": 40,
     "vx": -0.9682518943445757,
     "vy": -0.9712340198457241
    },
    {
     "t": "mv",
     "lat": -8.018405845232452,
     "lon": -34.91763728813611,
     "R": 40,
     "vx": -1.6175155670498498,
     "vy": -0.8131478074938059
    },
    {
     "t": "sua",
     "lat": -8.01814365989042,
     "lon": -34.917671012300964,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -8.018127637447378,
     "lon": -34.91767993245625,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -8.018132007204612,
     "lon": -34.91767699146866,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "larg",
     "lat": -8.018698839489087,
     "lon": -34.91763857667409,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.018726830901512,
     "lon": -34.91764191138938,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.01875697549726,
     "lon": -34.91765278013005,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "blarg",
     "lat": -8.019437975961676,
     "lon": -34.91772309157796,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "blarg",
     "lat": -8.01944880329302,
     "lon": -34.917716262608614,
     "R": 40,
     "f": 0.5,
     "d": 1
    },
    {
     "t": "bmv",
     "lat": -8.019482520985553,
     "lon": -34.91782026144587,
     "R": 40,
     "vx": 1.5260393614298664,
     "vy": -0.19364303164184093
    },
    {
     "t": "larg",
     "lat": -8.020458163721244,
     "lon": -34.917202074701386,
     "R": 40,
     "d": 1,
     "lado": -1
    },
    {
     "t": "larg",
     "lat": -8.020481899071019,
     "lon": -34.91722729798769,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.020433179141023,
     "lon": -34.91716171744329,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.020424434537567,
     "lon": -34.91714153881424,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.020426932995745,
     "lon": -34.91717054559351,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.02048064984218,
     "lon": -34.91723234264496,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "larg",
     "lat": -8.020536865138927,
     "lon": -34.91727900572464,
     "R": 40,
     "d": 1,
     "lado": 1
    },
    {
     "t": "mv",
     "lat": -8.021116933842643,
     "lon": -34.91757298217553,
     "R": 40,
     "vx": 0.218084009247832,
     "vy": 0.0010188519954681396
    },
    {
     "t": "mv",
     "lat": -8.021108117985497,
     "lon": -34.91757404761248,
     "R": 40,
     "vx": 0.2180588693008758,
     "vy": 0.001018734648823738
    },
    {
     "t": "mv",
     "lat": -8.021108117985476,
     "lon": -34.917572069812536,
     "R": 40,
     "vx": 0.4356115487171337,
     "vy": 0.11038591153919697
    },
    {
     "t": "mv",
     "lat": -7.978359903220841,
     "lon": -34.918725518665305,
     "R": 40,
     "vx": 2.0576297239749692,
     "vy": 0.3882091362029314
    },
    {
     "t": "mv",
     "lat": -7.978357849365405,
     "lon": -34.91870338324038,
     "R": 40,
     "vx": -0.6942100075539201,
     "vy": 1.6627943962812424
    },
    {
     "t": "mv",
     "lat": -7.978346210850904,
     "lon": -34.91870891709659,
     "R": 40,
     "vx": 1.0769870370277204,
     "vy": -1.9639276806265116
    },
    {
     "t": "sua",
     "lat": -7.9783653801687064,
     "lon": -34.918679864351375,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356480128396,
     "lon": -34.91868124781544,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356480128396,
     "lon": -34.91868124781544,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356266937626,
     "lon": -34.91868145133065,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356266937626,
     "lon": -34.91868145133065,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356266937626,
     "lon": -34.91868145133065,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978356266937626,
     "lon": -34.91868145133065,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978353362347354,
     "lon": -34.91870003821016,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "sua",
     "lat": -7.978353362347354,
     "lon": -34.91870003821016,
     "R": 40,
     "f": 0.5
    },
    {
     "t": "larg",
     "lat": -7.978364980708298,
     "lon": -34.91870933164992,
     "R": 40,
     "d": -1,
     "lado": -1
    },
    {
     "t": "mv",
     "lat": -7.982370939594266,
     "lon": -34.916568617070205,
     "R": 40,
     "vx": -2.4484983756556176,
     "vy": -0.3717711213976145
    },
    {
     "t": "mv",
     "lat": -7.982366052412591,
     "lon": -34.91659659912955,
     "R": 40,
     "vx": -2.37533604237251,
     "vy": 3.412694836035371
    },
    {
     "t": "mv",
     "lat": -7.9823416165033505,
     "lon": -34.91661635117145,
     "R": 40,
     "vx": -2.9034904583822936,
     "vy": -0.10359106957912445
    },
    {
     "t": "mv",
     "lat": -7.982366052412593,
     "lon": -34.91661059015922,
     "R": 40,
     "vx": 0.44536211219383404,
     "vy": 1.8040344174951315
    },
    {
     "t": "mv",
     "lat": -7.982363608821742,
     "lon": -34.916606475150516,
     "R": 40,
     "vx": 0.5423895215499215,
     "vy": 0.453011704608798
    },
    {
     "t": "mv",
     "lat": -7.9823668669429075,
     "lon": -34.916600714138276,
     "R": 40,
     "vx": -0.002512091537937522,
     "vy": 0.5405777525156736
    },
    {
     "t": "mv",
     "lat": -7.982386415669218,
     "lon": -34.91659330712254,
     "R": 40,
     "vx": 0.17730748688336462,
     "vy": 0.90180629119277
    },
    {
     "t": "bmv",
     "lat": -7.982474160065439,
     "lon": -34.91648186054447,
     "R": 40,
     "vx": -2.296152170980349,
     "vy": -2.197899505496025
    }
   ],
   "ruasSaida": "pline",
   "mtext": true,
   "projeto": {
    "t": {},
    "s": {},
    "i": {},
    "cam": {},
    "ex": [],
    "seq": 1,
    "fundo": "mapa",
    "e": {},
    "fav": [],
    "areaSig": "-8.066309,-34.878814,-8.064266,-34.875609"
   },
   "ruasLarg": {
    "arterial": 13,
    "principal": 9,
    "residencial": 7,
    "calma": 5,
    "servico": 4.5,
    "pedestre": 2.5,
    "outros": 6
   },
   "ruasNomes": true,
   "ruasH": 1.2,
   "ruasTipos": {
    "principais": true,
    "residenciais": true,
    "servico": true,
    "pedestre": false,
    "outros": false
   },
   "edif": false,
   "camadas": {
    "poste": "POSTES",
    "inst": "INSTALACOES",
    "bt": "REDE_BT",
    "mt": "REDE_MT",
    "kmlp": "KML_PONTOS",
    "kmll": "KML_LINHAS",
    "ruas": "ARRUAMENTO",
    "ruasOrig": "ARRUAMENTO_ORIGINAL",
    "txtRuas": "TXT_RUAS",
    "edif": "EDIFICACOES"
   },
   "fonte": "arial.ttf",
   "estiloLinha": true,
   "ruasCor": "#c0c0c0",
   "edifCor": "#808080",
   "ruasSuav": 10
  },
  "quant": {
   "poste": "coalesce(\"TIPO_PG\",\"CD_TIPO_PG_DESC\") || ' ' || \"NU_ALTURA\" || '/' || \"NU_ESFORCO\"",
   "inst": "coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\")",
   "bt": "uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")",
   "mt": "uniq_join('/', \"CONDUTOR_A\",\"CONDUTOR_B\",\"CONDUTOR_C\")",
   "kmlp": "coalesce(\"GRUPO\",\"NOME\")",
   "kmll": "coalesce(\"GRUPO\",\"NOME\")"
  },
  "lod": {
   "on": true,
   "zRare": 8,
   "zMT": 12,
   "zBT": 13.5,
   "zRot": 14.5,
   "palavras": "RELIGAD,FRONTEIRA,INTERLIG,FRONT",
   "raras": "upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE '%RELIGAD%' OR upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE '%FRONTEIRA%' OR upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE '%INTERLIG%' OR upper(coalesce(\"TIPO_INSTA\",\"TIPO_SIGLA\",\"NU_TIPO_INSTALACAO_MT_ID_DESC\",'')) LIKE '%FRONT%'"
  },
  "kml": {
   "ocultos": {}
  },
  "limites": {
   "est": false,
   "mun": false,
   "estCor": "#ffd166",
   "estW": 3,
   "munCor": "#9aa5ad",
   "munW": 1,
   "munTrac": false,
   "rot": true,
   "rotCor": "#e6eef5"
  },
  "geral": {
   "lembrar": true,
   "perguntarPasta": false,
   "perguntarAbrir": false
  },
  "pacote": {
   "nome": "",
   "cliente": "",
   "responsavel": "",
   "registro": "",
   "observacoes": "",
   "itens": {
    "dxf": true,
    "pdf": false,
    "quant": false,
    "dados": false,
    "geojson": false,
    "projeto": false,
    "resumo": false
   },
   "folha": "A3",
   "orient": "l",
   "ajuste": "escala",
   "pb": false,
   "saida": "pasta"
  }
 },
 "blocos": {
  "pg.Concreto.Duplo_T.nao": {
   "nome": "pg.Concreto.Duplo_T.nao",
   "base": [
    0,
    0
   ],
   "ents": [
    {
     "t": "LINE",
     "a": [
      1.99331,
      -1.625521
     ],
     "b": [
      1.99331,
      1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      1.571799,
      1.625521
     ],
     "b": [
      1.22586,
      0.413099
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.99331,
      1.22586
     ],
     "b": [
      -1.99331,
      -1.22586
     ]
    },
    {
     "t": "LINE",
     "a": [
      1.22586,
      -0.413099
     ],
     "b": [
      1.571799,
      -1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.22586,
      -0.413099
     ],
     "b": [
      1.22586,
      -0.413099
     ]
    },
    {
     "t": "LINE",
     "a": [
      1.22586,
      0.413099
     ],
     "b": [
      -1.22586,
      0.413099
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.99331,
      -1.625521
     ],
     "b": [
      -1.571799,
      -1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.571799,
      1.625521
     ],
     "b": [
      -1.99331,
      1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.571799,
      -1.625521
     ],
     "b": [
      -1.22586,
      -0.413099
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.22586,
      0.413099
     ],
     "b": [
      -1.571799,
      1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      -1.99331,
      -1.625521
     ],
     "b": [
      -1.99331,
      1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      1.571799,
      -1.625521
     ],
     "b": [
      1.99331,
      -1.625521
     ]
    },
    {
     "t": "LINE",
     "a": [
      1.99331,
      1.625521
     ],
     "b": [
      1.571799,
      1.625521
     ]
    }
   ],
   "att": [],
   "un": {},
   "centro": true,
   "origem": "MODELO.dxf",
   "dp": [
    {
     "pts": [
      [
       1.99331,
       -1.625521
      ],
      [
       1.99331,
       1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       1.571799,
       1.625521
      ],
      [
       1.22586,
       0.413099
      ]
     ]
    },
    {
     "pts": [
      [
       -1.99331,
       1.22586
      ],
      [
       -1.99331,
       -1.22586
      ]
     ]
    },
    {
     "pts": [
      [
       1.22586,
       -0.413099
      ],
      [
       1.571799,
       -1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       -1.22586,
       -0.413099
      ],
      [
       1.22586,
       -0.413099
      ]
     ]
    },
    {
     "pts": [
      [
       1.22586,
       0.413099
      ],
      [
       -1.22586,
       0.413099
      ]
     ]
    },
    {
     "pts": [
      [
       -1.99331,
       -1.625521
      ],
      [
       -1.571799,
       -1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       -1.571799,
       1.625521
      ],
      [
       -1.99331,
       1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       -1.571799,
       -1.625521
      ],
      [
       -1.22586,
       -0.413099
      ]
     ]
    },
    {
     "pts": [
      [
       -1.22586,
       0.413099
      ],
      [
       -1.571799,
       1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       -1.99331,
       -1.625521
      ],
      [
       -1.99331,
       1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       1.571799,
       -1.625521
      ],
      [
       1.99331,
       -1.625521
      ]
     ]
    },
    {
     "pts": [
      [
       1.99331,
       1.625521
      ],
      [
       1.571799,
       1.625521
      ]
     ]
    }
   ],
   "bb": [
    -1.99331,
    -1.625521,
    1.99331,
    1.625521
   ],
   "max": 3.98662
  },
  "pg.Concreto.Circular.nao": {
   "nome": "pg.Concreto.Circular.nao",
   "base": [
    0,
    0
   ],
   "ents": [
    {
     "t": "CIRCLE",
     "p": [
      0,
      0
     ],
     "r": 2
    },
    {
     "t": "CIRCLE",
     "p": [
      0,
      0
     ],
     "r": 1.253552505614594
    }
   ],
   "att": [],
   "un": {},
   "centro": false,
   "origem": "MODELO.dxf",
   "dp": [
    {
     "pts": [
      [
       2,
       0,
       0
      ],
      [
       1.9615705608064609,
       0.3901806440322565,
       0
      ],
      [
       1.8477590650225735,
       0.7653668647301796,
       0
      ],
      [
       1.6629392246050905,
       1.1111404660392044,
       0
      ],
      [
       1.4142135623730951,
       1.414213562373095,
       0
      ],
      [
       1.1111404660392046,
       1.6629392246050905,
       0
      ],
      [
       0.7653668647301797,
       1.8477590650225735,
       0
      ],
      [
       0.39018064403225666,
       1.9615705608064609,
       0
      ],
      [
       1.2246467991473532e-16,
       2,
       0
      ],
      [
       -0.3901806440322564,
       1.9615705608064609,
       0
      ],
      [
       -0.7653668647301795,
       1.8477590650225735,
       0
      ],
      [
       -1.1111404660392046,
       1.6629392246050902,
       0
      ],
      [
       -1.414213562373095,
       1.4142135623730951,
       0
      ],
      [
       -1.6629392246050907,
       1.1111404660392044,
       0
      ],
      [
       -1.8477590650225735,
       0.7653668647301798,
       0
      ],
      [
       -1.9615705608064609,
       0.39018064403225633,
       0
      ],
      [
       -2,
       2.4492935982947064e-16,
       0
      ],
      [
       -1.9615705608064609,
       -0.3901806440322567,
       0
      ],
      [
       -1.8477590650225737,
       -0.7653668647301793,
       0
      ],
      [
       -1.6629392246050905,
       -1.1111404660392046,
       0
      ],
      [
       -1.4142135623730954,
       -1.414213562373095,
       0
      ],
      [
       -1.1111404660392044,
       -1.6629392246050905,
       0
      ],
      [
       -0.765366864730179,
       -1.8477590650225737,
       0
      ],
      [
       -0.39018064403225733,
       -1.9615705608064606,
       0
      ],
      [
       -3.6739403974420594e-16,
       -2,
       0
      ],
      [
       0.3901806440322566,
       -1.9615705608064609,
       0
      ],
      [
       0.76536686473018,
       -1.8477590650225733,
       0
      ],
      [
       1.1111404660392037,
       -1.662939224605091,
       0
      ],
      [
       1.4142135623730947,
       -1.4142135623730954,
       0
      ],
      [
       1.6629392246050905,
       -1.1111404660392044,
       0
      ],
      [
       1.8477590650225737,
       -0.7653668647301791,
       0
      ],
      [
       1.9615705608064606,
       -0.39018064403225744,
       0
      ],
      [
       2,
       -4.898587196589413e-16,
       0
      ]
     ],
     "closed": true
    },
    {
     "pts": [
      [
       1.253552505614594,
       0,
       0
      ],
      [
       1.2294658457193817,
       0.24455596198447555,
       0
      ],
      [
       1.1581315028655632,
       0.4797137754984513,
       0
      ],
      [
       1.0422908158442505,
       0.6964364576466061,
       0
      ],
      [
       0.8863954772934671,
       0.886395477293467,
       0
      ],
      [
       0.6964364576466063,
       1.0422908158442505,
       0
      ],
      [
       0.47971377549845134,
       1.1581315028655632,
       0
      ],
      [
       0.24455596198447566,
       1.2294658457193817,
       0
      ],
      [
       7.675795317820285e-17,
       1.253552505614594,
       0
      ],
      [
       -0.2445559619844755,
       1.2294658457193817,
       0
      ],
      [
       -0.47971377549845123,
       1.1581315028655632,
       0
      ],
      [
       -0.6964364576466063,
       1.0422908158442505,
       0
      ],
      [
       -0.886395477293467,
       0.8863954772934671,
       0
      ],
      [
       -1.0422908158442508,
       0.6964364576466061,
       0
      ],
      [
       -1.1581315028655632,
       0.47971377549845146,
       0
      ],
      [
       -1.2294658457193817,
       0.24455596198447543,
       0
      ],
      [
       -1.253552505614594,
       1.535159063564057e-16,
       0
      ],
      [
       -1.2294658457193817,
       -0.24455596198447568,
       0
      ],
      [
       -1.1581315028655634,
       -0.4797137754984512,
       0
      ],
      [
       -1.0422908158442505,
       -0.6964364576466063,
       0
      ],
      [
       -0.8863954772934672,
       -0.886395477293467,
       0
      ],
      [
       -0.6964364576466061,
       -1.0422908158442505,
       0
      ],
      [
       -0.47971377549845096,
       -1.1581315028655634,
       0
      ],
      [
       -0.24455596198447607,
       -1.2294658457193814,
       0
      ],
      [
       -2.3027385953460854e-16,
       -1.253552505614594,
       0
      ],
      [
       0.24455596198447563,
       -1.2294658457193817,
       0
      ],
      [
       0.47971377549845157,
       -1.158131502865563,
       0
      ],
      [
       0.6964364576466057,
       -1.042290815844251,
       0
      ],
      [
       0.8863954772934669,
       -0.8863954772934672,
       0
      ],
      [
       1.0422908158442505,
       -0.6964364576466061,
       0
      ],
      [
       1.1581315028655634,
       -0.479713775498451,
       0
      ],
      [
       1.2294658457193814,
       -0.24455596198447616,
       0
      ],
      [
       1.253552505614594,
       -3.070318127128114e-16,
       0
      ]
     ],
     "closed": true
    }
   ],
   "bb": [
    -2,
    -2,
    2,
    2
   ],
   "max": 4
  },
  "INSTALACAOMT.TRAFO_CIA_AEREO.FECHADO": {
   "nome": "INSTALACAOMT.TRAFO_CIA_AEREO.FECHADO",
   "base": [
    0,
    0
   ],
   "ents": [
    {
     "t": "LINE",
     "a": [
      11.116139,
      3.5
     ],
     "b": [
      5.116139,
      0
     ]
    },
    {
     "t": "LINE",
     "a": [
      5.116139,
      0
     ],
     "b": [
      11.116139,
      -3.5
     ]
    },
    {
     "t": "LINE",
     "a": [
      11.116139,
      -3.5
     ],
     "b": [
      11.116139,
      3.5
     ]
    },
    {
     "t": "LINE",
     "a": [
      5.116139,
      0
     ],
     "b": [
      0,
      0
     ]
    }
   ],
   "att": [],
   "un": {},
   "centro": false,
   "origem": "MODELO.dxf",
   "dp": [
    {
     "pts": [
      [
       11.116139,
       3.5
      ],
      [
       5.116139,
       0
      ]
     ]
    },
    {
     "pts": [
      [
       5.116139,
       0
      ],
      [
       11.116139,
       -3.5
      ]
     ]
    },
    {
     "pts": [
      [
       11.116139,
       -3.5
      ],
      [
       11.116139,
       3.5
      ]
     ]
    },
    {
     "pts": [
      [
       5.116139,
       0
      ],
      [
       0,
       0
      ]
     ]
    }
   ],
   "bb": [
    0,
    -3.5,
    11.116139,
    3.5
   ],
   "max": 11.116139
  },
  "INSTALACAOMT.CHAVE_FUSIVEL_MONOPOLAR.FECHADO": {
   "nome": "INSTALACAOMT.CHAVE_FUSIVEL_MONOPOLAR.FECHADO",
   "base": [
    0,
    0
   ],
   "ents": [
    {
     "t": "ARC",
     "p": [
      5.403954,
      -1.447985
     ],
     "r": 1.227292686595514,
     "a0": 345,
     "a1": 165,
     "c": 1
    },
    {
     "t": "ARC",
     "p": [
      3.033006,
      -0.812692
     ],
     "r": 1.22729268659549,
     "a0": 165,
     "a1": 345,
     "c": 1
    },
    {
     "t": "LINE",
     "a": [
      4.21848,
      -1.130338
     ],
     "b": [
      6.589427,
      -1.765632
     ],
     "c": 1
    },
    {
     "t": "LINE",
     "a": [
      4.21848,
      -1.130338
     ],
     "b": [
      0,
      0
     ],
     "c": 1
    }
   ],
   "att": [],
   "un": {},
   "centro": false,
   "origem": "MODELO.dxf",
   "dp": [
    {
     "pts": [
      [
       6.589427702398302,
       -1.7656317212059582,
       0
      ],
      [
       6.6216390259846785,
       -1.601251160855965,
       0
      ],
      [
       6.631167181485509,
       -1.434015541919939,
       0
      ],
      [
       6.617834677391773,
       -1.267040147556714,
       0
      ],
      [
       6.581889873028675,
       -1.1034354134336994,
       0
      ],
      [
       6.524002352091313,
       -0.9462489861955612,
       0
      ],
      [
       6.445250449567357,
       -0.7984089515736055,
       0
      ],
      [
       6.3471011643965065,
       -0.6626692896887497,
       0
      ],
      [
       6.231382832055914,
       -0.5415585736126065,
       0
      ],
      [
       6.1002510661295934,
       -0.43733286683540085,
       0
      ],
      [
       5.9561486033059206,
       -0.3519336970717786,
       0
      ],
      [
       5.80175979981497,
       -0.28695188927300364,
       0
      ],
      [
       5.639960626950947,
       -0.24359793156806453,
       0
      ],
      [
       5.4737650971685134,
       -0.22267942616016678,
       0
      ],
      [
       5.306269118733499,
       -0.2245860452257269,
       0
      ],
      [
       5.140592824809586,
       -0.2492822720590151,
       0
      ],
      [
       4.979822451280993,
       -0.2963080626811825,
       0
      ],
      [
       4.826952846017325,
       -0.3647874155891522,
       0
      ],
      [
       4.684831680524244,
       -0.4534446900061596,
       0
      ],
      [
       4.556106403211318,
       -0.5606283686558193,
       0
      ],
      [
       4.443174922437304,
       -0.6843418224041995,
       0
      ],
      [
       4.348140938014458,
       -0.8222805036828101,
       0
      ],
      [
       4.272774753261372,
       -0.9718748758494383,
       0
      ],
      [
       4.2184802976016975,
       -1.1303382787940417,
       0
      ]
     ],
     "c": 1
    },
    {
     "pts": [
      [
       1.8475322976017208,
       -0.49504527879404764,
       0
      ],
      [
       1.8153209740153449,
       -0.6594258391440377,
       0
      ],
      [
       1.8057928185145151,
       -0.8266614580800603,
       0
      ],
      [
       1.8191253226082496,
       -0.9936368524432823,
       0
      ],
      [
       1.855070126971348,
       -1.157241586566294,
       0
      ],
      [
       1.9129576479087083,
       -1.3144280138044286,
       0
      ],
      [
       1.9917095504326625,
       -1.462268048426382,
       0
      ],
      [
       2.0898588356035117,
       -1.5980077103112351,
       0
      ],
      [
       2.205577167944101,
       -1.719118426387375,
       0
      ],
      [
       2.336708933870421,
       -1.8233441331645803,
       0
      ],
      [
       2.48081139669409,
       -1.9087433029282,
       0
      ],
      [
       2.6352002001850368,
       -1.9737251107269738,
       0
      ],
      [
       2.796999373049058,
       -2.017079068431912,
       0
      ],
      [
       2.9631949028314875,
       -2.0379975738398093,
       0
      ],
      [
       3.130690881266499,
       -2.0360909547742496,
       0
      ],
      [
       3.2963671751904084,
       -2.0113947279409614,
       0
      ],
      [
       3.4571375487189995,
       -1.9643689373187945,
       0
      ],
      [
       3.610007153982664,
       -1.8958895844108268,
       0
      ],
      [
       3.7521283194757413,
       -1.807232309993821,
       0
      ],
      [
       3.8808535967886657,
       -1.7000486313441625,
       0
      ],
      [
       3.993785077562677,
       -1.5763351775957846,
       0
      ],
      [
       4.088819061985522,
       -1.4383964963171776,
       0
      ],
      [
       4.164185246738606,
       -1.2888021241505523,
       0
      ],
      [
       4.218479702398279,
       -1.130338721205952,
       0
      ]
     ],
     "c": 1
    },
    {
     "pts": [
      [
       4.21848,
       -1.130338
      ],
      [
       6.589427,
       -1.765632
      ]
     ],
     "c": 1
    },
    {
     "pts": [
      [
       4.21848,
       -1.130338
      ],
      [
       0,
       0
      ]
     ],
     "c": 1
    }
   ],
   "bb": [
    0,
    -2.0379975738398093,
    6.631167181485509,
    0
   ],
   "max": 6.631167181485509
  }
 }
};
