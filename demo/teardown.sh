#!/usr/bin/env bash
# Removes everything the demo made. Without --confighub: the reporter, the
# kind clusters (the fleet and the policy sandbox) and the files in
# $AI_CHAOS_DIR other than your agent runs. With --confighub: also every
# ConfigHub Space whose slug starts with chaos- (the agents' workers live in
# chaos-agents), the demo's three components, and the agents' cub contexts.
# Deleting a Space deletes its units, revisions, releases and attestations for
# good, so it lists them and asks first. Run proof/evidence.sh before, if you
# want to keep the record.
#
#   source demo/env.sh && bash $DEMO/teardown.sh
#   source demo/env.sh && bash $DEMO/teardown.sh --confighub
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${AI_CHAOS_DIR:?source demo/env.sh first}"

bash "$here/setup/reporter.sh" stop || true
AI_CHAOS_DIR=$AI_CHAOS_DIR node "$here/setup/kind-fleet.mjs" --delete
kind delete cluster --name chaos-policy-sandbox 2>/dev/null || true
rm -rf "$AI_CHAOS_DIR"/chaos-*.kubeconfig "$AI_CHAOS_DIR/sandbox.kubeconfig" "$AI_CHAOS_DIR/fleet.kubeconfig" \
  "$AI_CHAOS_DIR/by-name" "$AI_CHAOS_DIR/onboard" "$AI_CHAOS_DIR/onboard.log" "$AI_CHAOS_DIR/status-watch.log"
echo "kind: $(kind get clusters 2>/dev/null | grep -c '^chaos-' || true) chaos-* clusters left; your agent runs are still in $CHAOS_RUNS"

[ "${1:-}" = "--confighub" ] || exit 0
list() { cub space list --where "Slug LIKE 'chaos-%'" -o 'jq=.[].Space.Slug' | tr -d '"'; }
spaces=$(list)
if [ -n "$spaces" ]; then
  echo "These ConfigHub Spaces will be deleted, with everything in them:"
  echo "$spaces" | sed 's/^/  /'
  read -r -p "Type delete to go on: " answer
  [ "$answer" = delete ] || { echo "nothing deleted in ConfigHub"; exit 1; }
  # Variants before class bases before bases; a Space something still depends
  # on is retried on the next pass.
  for pass in 1 2 3; do
    for s in $spaces; do cub space delete "$s" --recursive --quiet 2>/dev/null && echo "deleted $s" || true; done
    spaces=$(list)
    [ -n "$spaces" ] || break
  done
fi
for c in chaos-shop chaos-platform chaos-management; do cub component delete "$c" --quiet 2>/dev/null && echo "deleted component $c" || true; done
for a in devil angel reporter milton; do cub context delete "chaos-$a" >/dev/null 2>&1 || true; done
rm -f "$AI_CHAOS_DIR/ids.env"
spaces=$(list)
[ -z "$spaces" ] && echo "ConfigHub: no chaos-* Spaces left" || { echo "still there (delete gates, or something depends on them):"; echo "$spaces" | sed 's/^/  /'; }
