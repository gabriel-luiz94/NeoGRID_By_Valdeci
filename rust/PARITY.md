# PoC neogrid-core + neogrid-build — relatório

Data: 2026-10-27.

## neogrid-core (só std, zero deps)

| Módulo | Espelha JS | Testes |
|---|---|---|
| `encoding.rs` | `electron/db-build.js: detectEncoding` | 5 ok |
| `delimiter.rs` | `sniffDelimiter` (db-build + csv-worker) | 4 ok |
| `header.rs` | `normalizeHeader/uniqueHeaders` | 2 ok |
| `number.rs` | `toNumber` | 2 ok |
| `wkt.rs` | `scanWkt` + `geometry.js: wktFirstPoint` | 5 ok |
| `classify.rs` | `classifyFileByName/classifyByHeaders` | 2 ok |
| `utm.rs` | `dxf/utm.js` | 2 ok |

`cargo test`: **22 passed, 0 failed**. Binário `neogrid-parity` classifica os
4 CSVs reais da REGIONAL_2 igual ao JS.

## neogrid-build (CLI, paridade com `electron/db-build.js`)

Mesmo schema `neogrid-sqlite v2`, mesmo manifesto `neogrid-build-manifest
v1`, mesmos argumentos do `scripts/build-sqlite.js`. Deps: `csv`,
`encoding_rs`, `rusqlite(bundled)`, `flate2`, `serde_json`, `indexmap`.
Target: `x86_64-pc-windows-gnu` (toolchain em `C:\Users\ORION\w64devkit`;
config em `rust/.cargo/config.toml` + alias `libgcc_eh` em `rust/.libfix`).

### Paridade verificada (`parity/compare-dbs.js`)

Compara schema, todas as linhas decodificadas, rtree, links e rejects entre
o banco JS e o banco Rust:

- Amostra 20k linhas: **TUDO IGUAL**.
- REGIONAL_2 completa: **TUDO IGUAL**.
- Base completa (5.602.772 registros): contagens idênticas por camada
  (poste 2.487.524, bt 1.651.615, mt 1.161.618, inst 302.015), 0 rejeitos nos
  dois; `D:\neogrid-bench-tmp\full-rs.sqlite` (2.860.904.448 bytes — 4 KB de
  diferença para o banco JS de referência).
- Smoke test (`parity/smoke-reader.js`): o próprio `electron/database.js`
  abre o banco Rust — viewport, search, page, row+geom, links OK.

### Benchmark (REGIONAL_2, ~150 MB CSV → ~201 MB sqlite)

| Run | Rust release | Node |
|---|---|---|
| 1 | 21,3 s (versão inicial) | 16,7 s |
| 2 | **10,4 s** (zero-clone) | — |
| 3 | **9,9 s** | 16,6 s |

Versão inicial perdeu (21,3 s > 16,7 s): clones de String por célula
(3-4× por linha) + `indexOf` O(n²) na fase A. Após borrow + mapa inverso +
buffers reutilizados: **~1,7× mais rápido que o Node**, com pico de RAM
menor (sem objetos por linha, sem transcode em temp).

Base completa: **265 s** (4,4 min) para 5,6M registros no Rust.

### Desvio documentado (Rust correto, JS com bug latente)

`lengthMeters`/`totalLength`: o JS soma a linha JÁ codificada em dicionário,
então quando a coluna de comprimento é elegível a dicionário (bases pequenas)
ele soma os CÓDIGOS (ex.: 519.474 em vez de 34.665,93 — provado em
`parity/length-proof.js`). O Rust soma os valores decodificados. Nas bases
reais a coluna é TEXT e os dois concordam. Mesmo caso para `_id`/vínculos
(protegido por decodificação no Rust).

## Reprodutibilidade

```powershell
$env:PATH = "C:\Users\ORION\w64devkit\w64devkit\bin;" + $env:PATH
cargo build --release --target x86_64-pc-windows-gnu --bin neogrid-build
.\target\x86_64-pc-windows-gnu\release\neogrid-build.exe <pasta_csv> <saida.sqlite> [--manifesto-base a.json] [--manifesto-out m.json]
node parity\compare-dbs.js <js.sqlite> <rs.sqlite>
```

Amostra de teste em `rust/testdata/` (5.000 linhas por camada da REGIONAL_2).
