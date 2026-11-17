#Requires -Version 5.1
<#
  Publica uma versão do NeoGrid no GitHub Releases.

  O atualizador embutido (`rust/neogrid-app/src/updater.rs`) consulta
  `releases/latest` e baixa o `*setup.exe` anexado. Este script faz o ciclo:

    1. atualiza a versão em package.json, Cargo.toml e tauri.conf.json
    2. gera o instalador NSIS (build-app.ps1 -Bundle nsis)
    3. commita, cria a tag vX.Y.Z e envia para o GitHub
    4. publica a release com o instalador anexado

  Publicação: usa o GitHub CLI (`gh`) se estiver no PATH; senão usa
  `GITHUB_TOKEN` na API REST. Sem nenhum dos dois, o commit/tag são enviados
  e o script mostra como anexar o instalador pelo navegador.

  Exemplos:
    .\release.ps1 -Version 3.0.1
    .\release.ps1 -Version 3.0.1 -Notes "Corrige rotulos por camada"
    .\release.ps1 -Version 3.0.1 -SkipBuild      # usa o instalador já gerado
    .\release.ps1 -Version 3.0.1 -NoPush         # só atualiza versão e compila
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  [switch]$SkipBuild,
  [switch]$NoPush,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Versão inválida: '$Version'. Use o formato MAJOR.MINOR.PATCH (ex.: 3.0.1)."
}

$rust = Split-Path $PSScriptRoot          # rust/
$root = Split-Path $rust                  # raiz do repositório
$repo = 'gabriel-luiz94/NeoGRID_By_Valdeci'
$tag = "v$Version"
$installer = Join-Path $rust "target\x86_64-pc-windows-gnu\release\bundle\nsis\NeoGrid_${Version}_x64-setup.exe"

Set-Location $root

# --- 1. Estado do repositório ------------------------------------------------
$dirty = @(git status --porcelain)
if ($dirty.Count -and -not $Force) {
  throw "Há alterações não commitadas. Faça commit (ou use -Force para incluir tudo)."
}
if (@(git tag --list $tag).Count -and -not $Force) {
  throw "A tag $tag já existe."
}

function Set-TextVersion {
  param([string]$Path, [string]$Pattern, [string]$Replacement)
  $text = [System.IO.File]::ReadAllText($Path)
  $regex = [regex]::new($Pattern)
  if (-not $regex.IsMatch($text)) { throw "Não encontrei a versão em $Path" }
  $updated = $regex.Replace($text, $Replacement, 1)
  [System.IO.File]::WriteAllText($Path, $updated, [System.Text.UTF8Encoding]::new($false))
  Write-Host "versão -> $Version em $Path" -ForegroundColor DarkGray
}

Write-Host "== versão $Version" -ForegroundColor Cyan
Set-TextVersion (Join-Path $root 'package.json') '"version"\s*:\s*"[^"]+"' "`"version`": `"$Version`""
Set-TextVersion (Join-Path $root 'rust\neogrid-app\tauri.conf.json') '"version"\s*:\s*"[^"]+"' "`"version`": `"$Version`""
Set-TextVersion (Join-Path $root 'rust\neogrid-app\Cargo.toml') '(?m)^version\s*=\s*"[^"]+"' "version = `"$Version`""

# --- 2. Instalador -----------------------------------------------------------
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot 'build-app.ps1') -Bundle nsis
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "build do instalador falhou" }
}
if (-not (Test-Path $installer)) {
  throw "Instalador não encontrado: $installer"
}
$size = '{0:N1} MB' -f ((Get-Item $installer).Length / 1MB)
Write-Host "OK instalador: $installer ($size)" -ForegroundColor Green

if ($NoPush) {
  Write-Host "(-NoPush) versão atualizada e instalador gerado; nada foi enviado." -ForegroundColor Yellow
  return
}

# --- 3. Commit, tag e push ---------------------------------------------------
git add package.json rust/neogrid-app/Cargo.toml rust/neogrid-app/tauri.conf.json rust/Cargo.lock
git commit -m "Release $Version" | Out-Host
git tag $tag
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
git push origin $branch
git push origin $tag
Write-Host "OK tag $tag enviada para origin/$branch" -ForegroundColor Green

# --- 4. Release com o instalador anexado -------------------------------------
$releaseNotes = if ($Notes) { $Notes } else { "NeoGrid $Version" }
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  $notesFile = Join-Path $env:TEMP "neogrid-notes-$Version.md"
  [System.IO.File]::WriteAllText($notesFile, $releaseNotes, [System.Text.UTF8Encoding]::new($false))
  & gh release create $tag $installer --title "NeoGrid $Version" --notes-file $notesFile
  if ($LASTEXITCODE -ne 0) { throw "gh release create falhou" }
  Write-Host "OK release $tag publicada com o instalador" -ForegroundColor Green
} elseif ($env:GITHUB_TOKEN) {
  $headers = @{
    Authorization = "Bearer $($env:GITHUB_TOKEN)"
    Accept        = 'application/vnd.github+json'
    'User-Agent'  = 'NeoGrid-release'
  }
  $payload = @{
    tag_name   = $tag
    name       = "NeoGrid $Version"
    body       = $releaseNotes
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" `
    -Headers $headers -ContentType 'application/json' -Body $payload
  $name = [uri]::EscapeDataString((Split-Path $installer -Leaf))
  $upload = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$name"
  Invoke-RestMethod -Method Post -Uri $upload -Headers $headers `
    -ContentType 'application/octet-stream' -InFile $installer | Out-Null
  Write-Host "OK release $tag publicada com o instalador" -ForegroundColor Green
} else {
  Write-Host "Sem 'gh' e sem GITHUB_TOKEN: anexe o instalador manualmente." -ForegroundColor Yellow
  Write-Host "  https://github.com/$repo/releases/new?tag=$tag" -ForegroundColor Yellow
  Write-Host "  arquivo: $installer" -ForegroundColor Yellow
}
