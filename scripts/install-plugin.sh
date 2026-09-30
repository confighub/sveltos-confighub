#!/usr/bin/env bash
# Optional UI installation is explicit; no interactive prompts in scripts/CI.
set -euo pipefail
source_repo=confighub/sveltos-confighub
ui_version=
while (($#)); do
  case "$1" in
    --with-ui)
      [[ $# -ge 2 && -n "$2" ]] || { echo '--with-ui requires a pinned release tag' >&2; exit 2; }
      ui_version=$2; shift 2 ;;
    --source)
      [[ $# -ge 2 && -n "$2" ]] || { echo '--source requires a plugin source' >&2; exit 2; }
      source_repo=$2; shift 2 ;;
    --help|-h)
      echo 'Usage: install-plugin.sh [--source repo-or-path] [--with-ui plugin-ui-vX.Y.Z]'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$ui_version" && ! "$ui_version" =~ ^plugin-ui-v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo '--with-ui requires a pinned plugin-ui-vX.Y.Z release tag' >&2; exit 2
fi
cub plugin install "$source_repo"
if [[ -n "$ui_version" ]]; then
  cub sveltos ui install --version "$ui_version"
  echo 'UI installed. Start it with: cub sveltos ui'
else
  echo 'CLI installed. The optional UI can be added later with: cub sveltos ui install --version plugin-ui-vX.Y.Z'
fi
