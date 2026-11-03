#Requires -Version 5.1
<#
  Roda o NeoGrid (Tauri) em modo desenvolvimento.

  - Servidor do frontend: com `NEOGRID_SRC_DIR` setado, o próprio app serve
    `src/` direto do disco, então editar HTML/CSS/JS e recarregar (Ctrl+R)
    basta — sem rebuild.
  - Build: incremental; se o link falhar no `resource.lib` (sem MSVC), roda o
    `windres` e tenta de novo automaticamente.

  Exemplos:
    .\run-app.ps1                 # debug, frontend ao vivo
    .\run-app.ps1 -NoBuild        # só abre o binário já compilado
    .\run-app.ps1 -Profile release  # roda o release (frontend embutido)
#>
param(
  [ValidateSet('debug', 'release')]
  [string]$Profile = 'debug',
  [switch]$NoBuild,
  [string]$Target = 'x86_64-pc-windows-gnu',
  [string]$W64Devkit = 'C:\Users\ORION\w64devkit\w64devkit\bin'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot                 # rust/
$repo = Split-Path $root                         # raiz do projeto
$app = Join-Path $root 'neogrid-app'
$exe = Join-Path $root "target\$Target\$Profile\neogrid-app.exe"
$env:PATH = "$W64Devkit;$env:PATH"

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

if (-not $NoBuild) {
  $argsBuild = if ($Profile -eq 'release') {
    "build --release --target $Target -p neogrid-app"
  } else {
    "build --target $Target -p neogrid-app"
  }
  $log = Join-Path $env:TEMP ("neogrid-run-" + [guid]::NewGuid().ToString('N') + ".log")
  Push-Location $app
  try {
    $code = Invoke-Cargo -CargoArgs $argsBuild -Log $log
    if ($code -ne 0) {
      $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($text -match 'resource\.lib' -and $text -match 'not recognized') {
        Write-Host "resource.lib em formato .res -> convertendo com windres e repetindo" -ForegroundColor Yellow
        & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fix-tauri-res.ps1') -Target $Target -Profile $Profile
        $code = Invoke-Cargo -CargoArgs $argsBuild -Log $log
      }
    }
    if ($code -ne 0) {
      Get-Content $log | Select-Object -Last 25
      throw "build falhou (log: $log)"
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $exe)) { throw "executável não encontrado: $exe" }

# Em debug, o app serve o `src/` do disco (edits aparecem no próximo reload).
if ($Profile -eq 'debug') {
  $env:NEOGRID_SRC_DIR = Join-Path $repo 'src'
  Write-Host "frontend ao vivo: $env:NEOGRID_SRC_DIR" -ForegroundColor DarkGray
}

Write-Host "abrindo $exe" -ForegroundColor Green
& $exe
