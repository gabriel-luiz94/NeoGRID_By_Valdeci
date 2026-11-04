#Requires -Version 5.1
<#
  Configura o ambiente de build sem caminho fixo de máquina.
  Procura, nesta ordem: variável de ambiente, %LOCALAPPDATA%\neogrid-tools e o PATH atual.
    NEOGRID_W64DEVKIT  pasta bin do w64devkit (gcc, ar, windres)
    NEOGRID_NSIS       pasta do NSIS (makensis)
    NEOGRID_NODE       pasta do Node.js
#>
$tools = Join-Path $env:LOCALAPPDATA 'neogrid-tools'

function Resolve-ToolDir {
  param([string]$Override, [string]$Default, [string]$Probe)
  if ($Override -and (Test-Path (Join-Path $Override $Probe))) { return $Override }
  if (Test-Path (Join-Path $Default $Probe)) { return $Default }
  return $null
}

$script:W64Bin = Resolve-ToolDir $env:NEOGRID_W64DEVKIT (Join-Path $tools 'w64devkit\bin') 'windres.exe'
$script:NsisDir = Resolve-ToolDir $env:NEOGRID_NSIS (Join-Path $tools 'nsis') 'makensis.exe'
$script:NodeDir = Resolve-ToolDir $env:NEOGRID_NODE (Join-Path $tools 'node') 'node.exe'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

foreach ($dir in @($script:NsisDir, $script:NodeDir, $cargoBin, $script:W64Bin)) {
  if ($dir -and (Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}

# O w64devkit não traz libgcc_eh, que o rustc pede no alvo GNU. O gcc procura
# em LIBRARY_PATH, então isso vale também para os build scripts do cargo.
$libfix = Join-Path (Split-Path $PSScriptRoot) '.libfix'
if (Test-Path $libfix) { $env:LIBRARY_PATH = $libfix }
