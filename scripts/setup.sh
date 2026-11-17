#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Arena repo: $repo"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is not on PATH. Install it from https://bun.sh and run this script again." >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "OpenCode is not on PATH. Arena is a plugin and needs an OpenCode 2.2+ host." >&2
fi

cd "$repo"
echo "Installing dependencies..."
bun install
echo "Building the Arena tab..."
bun run build:gui

config="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
plugins="$config/plugins"
skills="$config/skills"
mkdir -p "$plugins" "$skills"

link="$plugins/arena-field"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "$link already exists and is not a link. Rename or remove it, then run this script again." >&2
  exit 1
fi
ln -sfn "$repo" "$link"

cp -R "$repo/skills/arena" "$skills/"

echo
echo "Plugin linked at: $link"
echo "Skill copied to:  $skills/arena"
echo
echo "Add this entry to $config/opencode.json:"
echo '  "plugins": ["./plugins/arena-field"]'
echo
echo "Restart OpenCode. The arena tools and the Arena tab will load with the host."
