#!/usr/bin/env bash
# Stands the demo up, ready to onboard: checks what it needs, then builds the
# kind fleet, the policy sandbox, the shop and Reloader (delivered by plain
# Sveltos), and the agents' ConfigHub identities. Running it again is safe: it
# keeps the clusters and identities it finds, brings the rest up to date, and
# leaves the shop alone once the fleet is onboarded into ConfigHub.
#
#   bash demo/standup.sh            stand it up
#   bash demo/standup.sh --check    only check what it needs
#
# Onboarding comes next and is not done here, because it waits for approvals:
# scenarios/00-onboard.md. demo/teardown.sh takes everything down again.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in
  ""|--check) ;;
  *) echo "usage: bash demo/standup.sh [--check]" >&2; exit 2 ;;
esac

missing=0
need() { # need <what> <command...>: run the check quietly, report a failure
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  ok      $what"; else echo "  MISSING $what"; missing=1; fi
}
echo "== what the demo needs"
need "Docker, running"                       docker info
need "kind v0.31 or later (outage 2 needs NetworkPolicy)" \
     sh -c 'v=$(kind version | awk "{print \$2}" | tr -d v); [ "$(printf "%s\n0.31.0\n" "$v" | sort -V | head -1)" = 0.31.0 ]'
need "kubectl"                               kubectl version --client
need "Node.js"                               node --version
need "curl and openssl"                      sh -c 'command -v curl && command -v openssl'
need "Python 3 with PyYAML"                  python3 -c "import yaml"
need "cub"                                   cub version
need "cub signed in"                         cub auth status
need "the cub sveltos plugin, v0.14.0 or later" \
     sh -c 'v=$(cub sveltos version | awk "{print \$3}" | tr -d v); [ "$(printf "%s\n0.14.0\n" "$v" | sort -V | head -1)" = 0.14.0 ]'
need "the cub helm plugin"                   cub helm --help
need "Claude Code, signed in (for the agents)" sh -c 'claude auth status | grep -Eq "\"loggedIn\": *true"'
if [ "$missing" = 1 ]; then
  echo "Install or sign in to what is missing; demo/README.md lists the versions we used." >&2
  exit 1
fi
org=$(cub auth status 2>/dev/null | awk -F'  +' '/^Organization Name/ {print $2}' || true)
echo "  ConfigHub organization: ${org:-unknown}${CUB_CONTEXT:+ (context $CUB_CONTEXT)}"
[ "${1:-}" = --check ] && exit 0

. "$here/env.sh"

echo "== the fleet: chaos-mgmt and four workload clusters, Sveltos v1.15.0"
node "$here/setup/kind-fleet.mjs"
. "$here/env.sh"    # again, so the fleet's kubeconfig is built

echo "== the policy sandbox"
bash "$here/setup/sandbox.sh"

echo "== the shop and Reloader, by plain Sveltos"
if kubectl --kubeconfig "$AI_CHAOS_DIR/chaos-mgmt.kubeconfig" get clusterprofile chaos-management >/dev/null 2>&1; then
  echo "  the fleet is onboarded: ConfigHub delivers the shop now, so it is left alone"
else
  bash "$here/setup/setup-shop.sh"
fi

echo "== the agents' ConfigHub identities"
bash "$here/setup/identities.sh"

cat <<EOF

The demo is up. In each terminal you use:

  source demo/env.sh

Then onboard the fleet into ConfigHub: demo/scenarios/00-onboard.md.
To take it all down again: bash demo/teardown.sh --confighub
EOF
