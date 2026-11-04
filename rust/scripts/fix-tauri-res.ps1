#Requires -Version 5.1
<#
  Workaround reprodutivel: o `tauri-build` gera `out/resource.lib` em formato
  `.res` (só o `link.exe` do MSVC entende). Sem MSVC, converte o `resource.rc`
  com o `windres` do w64devkit para COFF e sobrescreve o `.lib` — o GNU ld
  aceita o objeto COFF mesmo com extensao `.lib`.
  Uso: apos `cargo build -p neogrid-app` falhar no link, rode este script e
  repita o build (o build-script nao roda de novo, entao o .lib convertido
  persiste). Producao: instalar MSVC Build Tools elimina o workaround.
#>
param(
  [string]$Target = "x86_64-pc-windows-gnu",
  [string]$Profile = "debug"
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'env.ps1')
$Workspace = Split-Path $PSScriptRoot
if (-not $script:W64Bin) { throw "w64devkit nao encontrado (defina NEOGRID_W64DEVKIT)" }
$windres = Join-Path $script:W64Bin 'windres.exe'
$buildDir = "$Workspace\target\$Target\$Profile\build"
if (-not (Test-Path $buildDir)) { Write-Output "sem build em $Profile"; return }
$outs = Get-ChildItem $buildDir -Directory -Filter "neogrid-app-*" |
  ForEach-Object { Join-Path $_.FullName "out\resource.rc" } |
  Where-Object { Test-Path $_ }
if (-not $outs) { Write-Output "resource.rc nao encontrado em $Profile"; return }
foreach ($rc in $outs) {
  $lib = Join-Path (Split-Path $rc) "resource.lib"
  & $windres $rc -O coff -o $lib
  if ($LASTEXITCODE -ne 0) { throw "windres falhou para $rc" }
  Write-Output "convertido: $lib"
}
