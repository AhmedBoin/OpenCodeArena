param(
  [string]$ConfigDir = (Join-Path $env:USERPROFILE ".config\opencode")
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Write-Host "Arena source: $repo"

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
  Write-Host "Bun is not on PATH. Install it from https://bun.sh and run this script again." -ForegroundColor Yellow
  exit 1
}

$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencode) {
  Write-Host "OpenCode is not on PATH. Arena is a plugin and needs an OpenCode 2.2+ host." -ForegroundColor Yellow
}

$config = $ConfigDir
$plugins = Join-Path $config "plugins"
$skills = Join-Path $config "skills"
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
New-Item -ItemType Directory -Force -Path $skills | Out-Null

$install = Join-Path $plugins "arena-field"
if (Test-Path -LiteralPath $install) {
  $item = Get-Item -LiteralPath $install -Force
  if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
    cmd /c rmdir "$install"
  } else {
    Remove-Item -LiteralPath $install -Recurse -Force -Confirm:$false
  }
  if (Test-Path -LiteralPath $install) {
    $backups = Join-Path $config "arena-install-backups"
    New-Item -ItemType Directory -Force -Path $backups | Out-Null
    $backup = Join-Path $backups ("arena-field-" + (Get-Date -Format "yyyyMMddHHmmss"))
    Move-Item -LiteralPath $install -Destination $backup -Force
    Write-Host "The old install could not be removed and was moved to $backup" -ForegroundColor Yellow
  }
}

New-Item -ItemType Directory -Force -Path $install | Out-Null

$runtime = @(
  "src",
  "skills",
  "package.json",
  "bun.lock",
  "vite.config.ts",
  "tsconfig.json"
)
foreach ($name in $runtime) {
  $source = Join-Path $repo $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $install -Recurse -Force
  }
}

Push-Location $install
try {
  Write-Host "Installing dependencies in the OpenCode copy..."
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed in $install" }

  Write-Host "Building the Arena tab in the OpenCode copy..."
  bun run build:gui
  if ($LASTEXITCODE -ne 0) { throw "bun run build:gui failed in $install" }
} finally {
  Pop-Location
}

Copy-Item -Path (Join-Path $install "skills\arena") -Destination $skills -Recurse -Force

Write-Host ""
Write-Host "Plugin installed at: $install" -ForegroundColor Green
Write-Host "Source repo:        $repo (not used at runtime)"
Write-Host "This is a real copy, not a link to the Desktop folder."
Write-Host "To update: git pull in the source, then run this script again."
Write-Host ""
Write-Host "Add this entry to $config\opencode.json:" -ForegroundColor Cyan
Write-Host '  "plugins": ["./plugins/arena-field"]'
Write-Host ""
Write-Host "Restart OpenCode. The arena tools and the Arena tab will load from the OpenCode copy."
