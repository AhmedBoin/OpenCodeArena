param(
  [string]$ConfigDir = (Join-Path $env:USERPROFILE ".config\opencode")
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Write-Host "Arena repo: $repo"

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
  Write-Host "Bun is not on PATH. Install it from https://bun.sh and run this script again." -ForegroundColor Yellow
  exit 1
}

$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencode) {
  Write-Host "OpenCode is not on PATH. Arena is a plugin and needs an OpenCode 2.2+ host." -ForegroundColor Yellow
}

Push-Location $repo
try {
  Write-Host "Installing dependencies..."
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed" }

  Write-Host "Building the Arena tab..."
  bun run build:gui
  if ($LASTEXITCODE -ne 0) { throw "bun run build:gui failed" }
} finally {
  Pop-Location
}

$config = $ConfigDir
$plugins = Join-Path $config "plugins"
$skills = Join-Path $config "skills"
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
New-Item -ItemType Directory -Force -Path $skills | Out-Null

$link = Join-Path $plugins "arena-field"
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
    Remove-Item -LiteralPath $link -Force
  } else {
    Write-Host "$link already exists and is not a link. Rename or remove it, then run this script again." -ForegroundColor Yellow
    exit 1
  }
}
New-Item -ItemType Junction -Path $link -Target $repo | Out-Null

Copy-Item -Path (Join-Path $repo "skills\arena") -Destination $skills -Recurse -Force

Write-Host ""
Write-Host "Plugin linked at: $link"
Write-Host "Skill copied to:  $(Join-Path $skills 'arena')"
Write-Host ""
Write-Host "Add this entry to $config\opencode.json:" -ForegroundColor Cyan
Write-Host '  "plugins": ["./plugins/arena-field"]'
Write-Host ""
Write-Host "Restart OpenCode. The arena tools and the Arena tab will load with the host."
