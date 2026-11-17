#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Arena source: $repo"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is not on PATH. Install it from https://bun.sh and run this script again." >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "OpenCode is not on PATH. Arena is a plugin and needs an OpenCode 2.2+ host." >&2
fi

config="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
plugins="$config/plugins"
skills="$config/skills"
mkdir -p "$plugins" "$skills"

install="$plugins/arena-field"
if [ -L "$install" ]; then
  rm "$install"
elif [ -e "$install" ]; then
  rm -rf "$install"
fi
if [ -e "$install" ]; then
  mkdir -p "$config/arena-install-backups"
  backup="$config/arena-install-backups/arena-field-$(date +%Y%m%d%H%M%S)"
  mv "$install" "$backup"
  echo "The old install could not be removed and was moved to $backup" >&2
fi

mkdir -p "$install"
for name in src skills package.json bun.lock vite.config.ts tsconfig.json; do
  if [ -e "$repo/$name" ]; then
    cp -R "$repo/$name" "$install/"
  fi
done

cd "$install"
echo "Installing dependencies in the OpenCode copy..."
bun install
echo "Building the Arena tab in the OpenCode copy..."
bun run build:gui

cp -R "$install/skills/arena" "$skills/"

echo
echo "Plugin installed at: $install"
echo "Source repo:        $repo (not used at runtime)"
echo "This is a real copy, not a link to the source folder."
echo "To update: git pull in the source, then run this script again."
echo
echo "Add this entry to $config/opencode.json:"
echo '  "plugins": ["./plugins/arena-field"]'
echo
echo "Restart OpenCode. The arena tools and the Arena tab will load from the OpenCode copy."
