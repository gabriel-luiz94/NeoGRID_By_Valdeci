#Requires -Version 5.1
<#
  Build do app Tauri (NeoGrid) em um comando.

  Encapsula o ciclo que seria manual:
    1. `cargo build --release`
    2. se o link falhar no `resource.lib` (sem MSVC), roda o conversor
       `windres` e tenta de novo
    3. opcional: `cargo tauri build --bundles <nsis|msi>` (instalador)

  Requisitos: w64devkit em C:\Users\ORION\w64devkit (ou -W64Devkit <path>),
  NSIS em C:\Users\ORION\nsis\nsis-3.11 para o instalador.
  Com MSVC Build Tools instalado, o passo 2 nunca dispara.

  Exemplos:
    .\build-app.ps1                      # exe release
    .\build-app.ps1 -Bundle nsis         # exe + instalador NSIS
    .\build-app.ps1 -Bundle nsis -Install  # instala por cima (currentUser)
#>
param(
  [ValidateSet('none', 'nsis', 'msi')]
  [string]$Bundle = 'nsis',
  [string]$Target = 'x86_64-pc-windows-gnu',
  [string]$W64Devkit = 'C:\Users\ORION\w64devkit\w64devkit\bin',
  [string]$Nsis = 'C:\Users\ORION\nsis\nsis-3.11',
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot           # rust/
$app = Join-Path $root 'neogrid-app'
$env:PATH = "$W64Devkit;$Nsis;$env:PATH"

# Executa um comando nativo capturando stdout+stderr em log, sem deixar o
# stderr do cargo virar exceção do PowerShell.
function Invoke-Cargo {
  param([string]$CargoArgs, [string]$Log)
  $argv = $CargoArgs -split '\s+'
  Write-Host "== cargo $CargoArgs" -ForegroundColor Cyan
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cargo @argv 2>&1 | Out-File -FilePath $Log -Encoding utf8
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Build-WithResFix {
  param([string]$CargoArgs, [string]$Profile = 'release')
  $log = Join-Path $env:TEMP ("neogrid-build-" + [guid]::NewGuid().ToString('N') + ".log")
  $code = Invoke-Cargo -CargoArgs $CargoArgs -Log $log
  if ($code -eq 0) { return 0 }

  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  # Sem MSVC o link falha porque `resource.lib` vem em formato `.res`.
  # Detecta por "not recognized" ou por falha de link com collect2.
  $linkFailure = ($text -match 'resource\.lib' -and $text -match 'not recognized') -or
    ($text -match 'linking with' -and $text -match 'collect2\.exe: error')
  if (-not $linkFailure) {
    Get-Content $log | Select-Object -Last 25
    Write-Host "Build falhou por outro motivo (log: $log)" -ForegroundColor Red
    return $code
  }

  Write-Host "resource.lib em formato .res -> convertendo com windres e repetindo" -ForegroundColor Yellow
  foreach ($p in @('release', 'debug')) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fix-tauri-res.ps1') -Target $Target -Profile $p
  }
  $code = Invoke-Cargo -CargoArgs $CargoArgs -Log $log
  if ($code -ne 0) { Get-Content $log | Select-Object -Last 25 }
  return $code
}

Push-Location $app
try {
  $exe = Join-Path $root "target\$Target\release\neogrid-app.exe"
  if ((Build-WithResFix -CargoArgs "build --release --target $Target -p neogrid-app" -Profile release) -ne 0) {
    throw "build do executável falhou"
  }
  if (-not (Test-Path $exe)) { throw "executável não encontrado: $exe" }
  $size = '{0:N1} MB' -f ((Get-Item $exe).Length / 1MB)
  Write-Host "OK exe: $exe ($size)" -ForegroundColor Green

  if ($Bundle -ne 'none') {
    if ((Build-WithResFix -CargoArgs "tauri build --target $Target --bundles $Bundle" -Profile release) -ne 0) {
      throw "empacotamento ($Bundle) falhou"
    }
    $bundleDir = Join-Path $root "target\$Target\release\bundle\$Bundle"
    Get-ChildItem $bundleDir -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host ("OK instalador: {0} ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB)) -ForegroundColor Green
      if ($Install) {
        Write-Host "instalando (currentUser, silencioso)..." -ForegroundColor Cyan
        Start-Process -FilePath $_.FullName -ArgumentList '/S' -Wait
        Write-Host "instalado em $env:LOCALAPPDATA\NeoGrid" -ForegroundColor Green
      }
    }
  }
} finally {
  Pop-Location
}
