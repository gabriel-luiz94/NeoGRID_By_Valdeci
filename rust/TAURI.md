# App Tauri — arquitetura e operação (oficial desde 2026-10-28)

`neogrid-query` retorna **byte-idêntico** ao antigo `electron/database.js`
(suite de 17 consultas, base 20k e base 5,6M). `neogrid-build` é 1,7× mais
rápido que o conversor Node. O frontend é o mesmo — só o shell mudou.

O Electron permanece em `electron/` como legado (`npm run legacy:*`).

## 1. Arquitetura

```
rust/neogrid-core    parsing determinístico (encoding, delimitador, WKT, UTM)
rust/neogrid-build   conversor CSV → SQLite (lib + CLI)
rust/neogrid-query   leitura do banco (viewport, busca, página, vínculos)
rust/neogrid-app     shell Tauri: commands, janela, servidor do frontend
src/                 frontend (mesmo do Electron) + adapter desktop-tauri.js
```

Fluxo: o frontend chama `window.desktop` (adapter) → `invoke` → command Rust →
`neogrid-query`/`neogrid-build`. Em dev, `serve.rs` serve `src/` do disco; em
produção serve a cópia embutida no exe.

## 2. Mapa IPC → Tauri (inventário completo do Electron)

Consultas (viram `#[tauri::command]`, `Mutex<Manager>` no state, execução em
`spawn_blocking`):

Implementado em `rust/neogrid-app/src/commands.rs` — sem plugins Tauri
(`rfd` para dialogs, `ureq` para HTTP com allowlist, `std` para fs/opener).
Binários em base64, igual ao IPC do Electron.

| Electron | Tauri (feito) |
|---|---|
| `db:open-dialog` | `db_open_dialog` (rfd + mesma validação) |
| `db:open/close/info` | `db_open/db_close/db_info` |
| `db:viewport/rows/row/bounds/hotspots/ids-in-bounds/search/find-by-id/page/distinct/links` | `db_query(channel, json)` genérico — `database-client.js` idêntico |
| `db:build-start/cancel/busy` + `db:build-progress` | `db_build_start` (async + `spawn_blocking`, mesmos eventos) + `db_build_cancel/busy` via `AtomicBool` |
| `db:pick-folder/pick-output` | `db_pick_folder/db_pick_output` (rfd) |
| `project:status/write-autosave/read-autosave/clear-autosave/save-as/open-file` | `project_*` (app-data `projects/`, escrita atômica, meta) |
| `file:save` / `file:reveal` / `app:open-external` | `file_save` (rfd) / `file_reveal` / `app_open_external` (valida http) |
| `net:fetch-text` | `net_fetch_text` (`ureq`, allowlist de 9 hosts, timeout 5–120 s) |
| `app:info` | `app_info` |
| `window:overlay-theme` | `window_overlay_theme` (Overlay; cores do sistema — desvio documentado) |
| `getPathForFile` | `''` (dialogs já devolvem path) |

Pendente (fora da superfície `window.desktop`): window-state, single-instance
(vão no packaging) e protocolo `app://` (desnecessário — Tauri serve `src/`
embutido; CSP já configurada).

## 3. Segurança (ganho real vs Electron)

- Sem plugins com acesso amplo: dialogs via `rfd` (nativo), HTTP só para os
  9 hosts da allowlist (`commands.rs:host_allowed`), fs restrito ao código
  dos commands (app-data `projects/` + caminhos escolhidos em dialogs).
- Validação de extensão/tamanho já existe no core (`Manager::open`,
  limites de 1 GB no snapshot).
- Sem Node no renderer (igual ao `sandbox: true` atual, mas sem o runtime).

## 4. Frontend: 1 adapter, resto intacto

`src/js/core/desktop-tauri.js` (script clássico após `boot.js`, antes de
`main.js`) implementa a **mesma superfície** `window.desktop` (22 invokes)
sobre `window.__TAURI__.core.invoke` / `.event.listen` (ponte injetada pelo
WebView — sem bundler). Só instala com `__TAURI__` presente e sem `desktop`
(o preload do Electron tem precedência). `database-client.js`,
`sqlite-store.js`, `db-build-ui.js`, `persistence.js` **não mudam**.
`platform` via user-agent (só usado para dataset CSS).

Contrato auditado por `rust/parity/contract-check.js` (todo `invoke` existe
no backend, está registrado no handler e os args batem em camelCase via
`rename_all`): **CONTRATO OK**.

## 5. Build/packaging

- `tauri/` com `frontendDist: ../src` (sem bundler — o app é vanilla JS).
- Ícones: reutilizar `build/`.
- Empacotamento atual é ZIP portátil (`scripts/package.js`); Tauri 2 **não tem
  alvo portátil** — decidir entre NSIS instalador vs pasta + exe (spike).
- WebView2: presente no Win10/11; documentar fallback como hoje no SmartScreen.

## 6. Toolchain — resultado do spike
- `tauri-build` exige `icons/icon.ico` (copiado de `build/`).
- Sem MSVC, o `tauri-build` gera `out/resource.lib` em formato `.res`, que o
  GNU ld rejeita (`file format not recognized`). Workaround reprodutível em
  `rust/scripts/fix-tauri-res.ps1`: reconverte `resource.rc` com o `windres`
  do w64devkit para COFF e sobrescreve o `.lib` (o build-script não roda de
  novo, então persiste). **Produção: instalar MSVC Build Tools.**
- Com o workaround, `neogrid-app` (Tauri 2.7 + `wry`/WebView2) **compila e
  linka no alvo `x86_64-pc-windows-gnu`**, e `--smoke` abre a base via
  `neogrid-query` (rows + viewport OK). `--window-smoke` **confirmado**: a
  janela real abriu, gravou o marker e saiu sozinha (o aviso
  `Chrome_WidgetWin_0` no stderr é benigno, do shutdown do Chromium).
- `frontendDist` é **embutido no binário em tempo de compilação**: após mudar
  qualquer arquivo do frontend, rebuild antes de testar (binário velho serve
  página velha — causou um TIMEOUT falso no e2e).
- O CSP (`tauri.conf.json` + `src/index.html`) bloqueia `<script>` inline;
  páginas de teste precisam de `.js` externo (o app real já usa só externos).

## 7. Rollout

1. ~~Query core + paridade~~ (feito, byte-idêntico).
2. ~~Extrair `lib` de `neogrid-build` + cancel/progress no `Options`~~ (feito + testes).
3. ~~Adapter frontend + commands completos~~ (feito; `contract-check.js` OK).
4. ~~Spike shell Tauri~~ (feito: link gnu + janela WebView2 confirmada).
5. ~~E2E na janela~~ (**PASS 29/29** via `parity/e2e-app.js`, que dirige o app
   real pelo CDP sobre `window.desktop` — sem página de teste).
6. ~~QA A/B contra o Electron~~ (`parity/qa-ab.js` via CDP nos dois shells):
   **summaries idênticos** na base 20k e na base completa 5,6M (única
   diferença: `lastImportAt`), DOM igual, **0 erros de console**. PNGs em
   `bench/qa*/` para revisão humana.
7. ~~Servidor embutido~~ (`serve.rs`: `include_dir!` + `tiny_http`) com
   **porta efêmera** (127.0.0.1:0) — sem conflito com outras ferramentas; a
   janela usa a porta escolhida em runtime. Em dev (`NEOGRID_SRC_DIR`) serve
   `src/` do disco; em produção, a cópia embutida.
8. ~~ACL de produção~~ (`AppManifest::commands` no `build.rs` + 22
   `allow-*` na capability + `remote.urls http://localhost:*/`; sem isso,
   `"<cmd> not allowed. Plugin not found"` — o modo dev relaxa e esconde o
   problema; `contract-check.js` audita as 3 listas).
9. ~~Instalador NSIS final~~ (`NeoGrid_2.0.0_x64-setup.exe`, 7,0 MB,
   por usuário, sem admin): instala em `%LOCALAPPDATA%\NeoGrid` (exe 31,8 MB
   + uninstall + WebView2Loader). **E2E 29/29 PASS no app instalado**, sem
   servidor externo — frontend vem do `serve.rs` embutido.
10. ~~QA de produção na base completa~~: app instalado abrindo os 5.602.772
    registros (mapa com rótulos, 4 camadas, 70.309 km), 0 erros de console,
    screenshots em `bench/qa-prod-full/`.
11. ~~Script de build~~: `rust/scripts/build-app.ps1` (encapsula build + fix
    de `resource.lib` + bundle + install) exposto como
    `npm run app:build|app:install|app:exe`.
12. ~~Branding/config~~: `productName NeoGrid`, versão 2.0.0, identificador
    `br.com.neogrid.desktop`, `frontendDist` relativo (`../../src`), CSP
    explícita, NSIS pt-BR currentUser.

## 8. Fluxo dev (aprendizados do e2e)

- Dev ágil: `npm start` (ou `rust/scripts/run-app.ps1`) compila em debug e
  abre; com `NEOGRID_SRC_DIR` apontando para `src/`, o app serve o frontend
  **do disco**, então editar HTML/CSS/JS e recarregar (`Ctrl+R`) basta. Em
  produção serve a cópia embutida.
- Rebuild do app: `npm run app:build` (já trata o `resource.lib`); para debug,
  `cargo build -p neogrid-app` + `scripts/fix-tauri-res.ps1 -Profile debug`
  quando o link falhar. Não tocar no `tauri.conf.json` à toa — cada touch
  força rerun do build-script.
- Nunca rodar dois builds/apps em paralelo sobre o mesmo `target/` (os error 32).
- CDP: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=PORT`
  + `parity/cdp-probe.js` mostra URL/título/JS da janela headless. O Electron
  aceita `--remote-debugging-port` direto (headless com `--headless
  --disable-gpu --no-sandbox`).

## 9. Release portátil (estado real)

Validado:
- `cargo build --release -p neogrid-app` → **exe único de ~31 MB**, abre a
  janela no WebView2.
- A janela é criada em código apontando para `http://localhost:<porta>`, onde
  `<porta>` é escolhida em runtime pelo `serve.rs` (porta efêmera). Não
  depende de `devUrl` nem de servidor externo.
- Dev: `npm start` compila em debug e serve `src/` do disco.

## 9. Distribuição (estado final)

- `NeoGrid_2.0.0_x64-setup.exe` — **6,8 MB**, instala por usuário (sem admin)
  em `%LOCALAPPDATA%\NeoGrid` (exe 31,1 MB + `uninstall.exe` +
  `WebView2Loader.dll`), atalho no Menu Iniciar e desinstalador; instalador em
  português do Brasil.
- O exe **não depende de servidor externo**: `serve.rs` embute `src/` com
  `include_dir!` e sobe um servidor em `127.0.0.1:0` (porta efêmera). A janela
  é criada em código apontando para `http://localhost:<porta>`, então dev e
  produção usam o mesmo caminho (sem cair em `file://`) e não há conflito de
  porta com outras ferramentas.
- Dependência de runtime: **WebView2** (já presente no Windows 10/11). Para
  embarcar o runtime offline: `bundle.windows.webviewInstallMode =
  offlineInstaller` (+~120 MB).
- Build reprodutível: `npm run app:build` / `app:install` (ver `CUTOVER.md`);
  o script roda o `windres` automaticamente quando falta MSVC.
