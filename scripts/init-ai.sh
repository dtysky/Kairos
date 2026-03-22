#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IDES=(".cursor")
DIRS=("rules" "skills")

echo "Initializing AI tools integration..."
echo "  Platform: $(uname -s)"
echo "  Root:     $ROOT"
echo ""

mkdir -p .ai/rules .ai/skills

for ide in "${IDES[@]}"; do
  mkdir -p "$ide"
  for dir in "${DIRS[@]}"; do
    link="$ide/$dir"
    target="../.ai/$dir"

    if [ -L "$link" ]; then
      current="$(readlink "$link")"
      if [ "$current" = "$target" ]; then
        echo "  ✓ $link (already correct)"
        continue
      fi
      rm "$link"
    elif [ -d "$link" ]; then
      echo "  ⚠ $link is a real directory, removing..."
      rm -rf "$link"
    fi

    ln -s "$target" "$link"
    echo "  ✓ $link → .ai/$dir"
  done
done

echo ""
echo "Done!"
