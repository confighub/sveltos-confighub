#!/usr/bin/env bash
# Stands the demo up, ready to onboard: checks what it needs, then builds the
# kind fleet, the policy sandbox, the shop and Reloader (delivered by plain
# Sveltos), and the agents' ConfigHub identities. Each step skips what already
# exists, so running it again is safe.
#
#   bash demo/standup.sh            stand it up
#   bash demo/standup.sh --check    only check what it needs
#
# Onboarding comes next and is not done here, because it waits for approvals:
# scenarios/00-onboard.md. demo/teardown.sh takes everything down again.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"

missing=0
need() { # need <what> <command...>: run the check quietly, report a failure
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  ok      $what"; else echo "  MISSING $what"; missing=1; fi
}
echo "== what the demo needs"
need "Docker, running"                       docker info
need "kind"                                  kind version
need "kubectl"                               kubectl version --client
need "Node.js"                               node --version
need "Python 3 with PyYAML"                  python3 -c "import yaml"
need "cub"                                   cub version
need "cub signed in"                         cub auth status
need "the cub sveltos plugin"                cub sveltos --help
need "the cub helm plugin"                   cub helm --help
need "Claude Code (for the agents)"          claude --version
if [ "$missing" = 1 ]; then
  echo "Install or sign in to what is missing; demo/README.md lists the versions we used." >&2
  exit 1
fi
org=$(cub auth status 2>/dev/null | awk -F'  +' '/^Organization Name/ {print $2}')
echo "  ConfigHub organization: ${org:-unknown}${CUB_CONTEXT:+ (context $CUB_CONTEXT)}"
[ "${1:-}" = --check ] && exit 0

echo "== the fleet: chaos-mgmt and four workload clusters, Sveltos v1.15.0"
node "$DEMO/setup/kind-fleet.mjs"
. "$DEMO/env.sh"    # again, so the fleet's kubeconfig is built

echo "== the policy sandbox"
bash "$DEMO/setup/sandbox.sh"

echo "== the shop and Reloader, by plain Sveltos"
bash "$DEMO/setup/setup-shop.sh"

echo "== the agents' ConfigHub identities"
bash "$DEMO/setup/identities.sh"

cat <<EOF

The demo is up. In each terminal you use:

  source demo/env.sh

Then onboard the fleet into ConfigHub: demo/scenarios/00-onboard.md.
To take it all down again: bash demo/teardown.sh --confighub
EOF
