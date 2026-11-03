# Cutover — Tauri oficial

Estado em **2026-10-28**: o corte foi feito. `npm start` e `npm run package`
apontam para o app Tauri; o Electron ficou como legado (`npm run legacy:*`) e
referência de paridade.

## Pronto e provado

| Item | Evidência |
|---|---|
| Paridade do conversor CSV→SQLite | base 5.602.772 registros idêntica (`PARITY.md`) |
| Paridade das consultas | 17 consultas byte-idênticas a `database.js` |
| Adapter `window.desktop` | 22 commands; `parity/contract-check.js` audita contrato + ACL |
| E2E no app instalado | 29/29 PASS (`parity/e2e-app.js`), inclui build, DXF, CSV e prancha |
| QA A/B vs Electron | summaries idênticos, 0 erros de console |
| Frontend offline | `serve.rs` embute `src/`; em dev serve do disco (`NEOGRID_SRC_DIR`) |
| Instalador por usuário | NSIS `currentUser`, sem admin, pt-BR |
| Base completa no app instalado | 5.602.772 registros, 0 erros de console |
| Instância única + estado da janela | `plugin-single-instance` + `plugin-window-state` |
| Migração do app antigo | copia `%APPDATA%\NeoGrid\projects\autosave.neogrid` na 1ª execução |

## Pendências pós-cutover

1. **MSVC Build Tools**: elimina `scripts/fix-tauri-res.ps1` e permite MSI.
   Sem isso, todo rebuild limpo exige o retry do script (já automatizado em
   `build-app.ps1`).
2. **Assinatura de código**: hoje o exe não é assinado → SmartScreen. Precisa
   de certificado (EV ou OV) e `signtool` no pipeline.
3. ~~Teste manual de fluxos com diálogo~~ (automatizado via CDP): **DXF**
   (coleta por área + `generateDxf`, checa camadas/SECTION/EOF), **CSV**
   (`buildCsv`, BOM + linhas) e **compositor de prancha** (Ctrl+P abre,
   seletor A3 presente). O clique no botão “Salvar” continua nativo — o
   diálogo é do Windows e não é automatizável.
4. **Auto-update (opcional)**: `tauri-plugin-updater` exige servidor de
   releases; decidir se entra agora ou depois.
5. **Remover o Electron** quando não houver mais uso de fallback: apagar
   `electron/`, `scripts/package.js`, `npm run legacy:*` e as devDependencies
   `electron`/`rcedit`. `src/js/core/desktop-tauri.js` é o único acoplamento
   novo no frontend.

## Comandos

```powershell
npm run app:build       # exe + instalador NSIS
npm run app:install     # build + instala por cima (currentUser)
npm run app:exe         # só o executável
npm run core:test       # testes Rust (core + build + app)
npm run core:parity     # contrato adapter x commands x ACL
```

O script `rust/scripts/build-app.ps1` já faz o ciclo completo: build →
detecta falha de `resource.lib` → converte com `windres` → repete → empacota.
Também aceita `-Bundle none|nsis|msi` e `-Install`.

E2E contra um app em execução (CDP):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
& "$env:LOCALAPPDATA\NeoGrid\neogrid-app.exe"
node rust/parity/e2e-app.js --port 9222 --db <base.sqlite> --out <dir> `
  --marker <marker> --rows 5602772 --poste 2487524 --no-build
```

## Riscos residuais

- **WebView2 ausente** em Windows antigo/servidor: o instalador NSIS pode
  embutir o runtime (`webviewInstallMode: offlineInstaller`), ao custo de
  ~120 MB. Decidir conforme o parque de máquinas.
- **Porta do frontend**: efêmera por padrão (`127.0.0.1:0`), escolhida em
  runtime e liberada na capability por `http://localhost:*/` (URLPattern).
  `NEOGRID_FRONTEND_PORT` força uma porta fixa (útil para depurar com CDP).
- **Build a partir da raiz**: rode comandos Rust com `cd rust` (ou use os
  scripts npm). O `.cargo/config.toml` com linker/rustflags mora em `rust/`;
  invocar `cargo --manifest-path rust/Cargo.toml` de fora ignora essa config
  e quebra o link no alvo GNU.
