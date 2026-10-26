#!/usr/bin/env bash
# The nightly repave: rebuilds clusters from nothing, as a platform that
# rotates, repaves and repairs does. It stands in for the platform's scheduled
# job, run on a pre-approved change: nobody is asked, and nobody is told.
# Each cluster is deleted and created again, empty, and registered with Sveltos
# again. Everything it runs afterwards is what Sveltos delivers from ConfigHub.
#
#   source demo/env.sh && bash $DEMO/setup/repave.sh prod                the three prod clusters
#   source demo/env.sh && bash $DEMO/setup/repave.sh prod-us-2           one cluster
#   source demo/env.sh && bash $DEMO/setup/repave.sh --redeliver prod    and ask Sveltos to deliver again
#
# Without --redeliver, Sveltos v1.16.0 does not know a cluster is new: it keeps
# its record that every profile was delivered, and delivers nothing. With it,
# the job registers each rebuilt cluster as a new one (its SveltosCluster made
# again), so that record fails and Sveltos delivers everything again. It writes
# no delivery profile, so a policy on profiles, such as outage 2's, does not
# stand in its way.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
redeliver=
[ "${1:-}" = --redeliver ] && { redeliver=1; shift; }
clusters=()
for c in "$@"; do
  case $c in
    prod) clusters+=(prod-eu prod-us-1 prod-us-2) ;;
    staging|prod-eu|prod-us-1|prod-us-2) clusters+=("$c") ;;
    *) echo "repave which clusters? prod, or staging, prod-eu, prod-us-1, prod-us-2" >&2; exit 2 ;;
  esac
done
[ ${#clusters[@]} -gt 0 ] || { echo "usage: bash repave.sh [--redeliver] prod | <cluster>..." >&2; exit 2; }

echo "== the repave: ${clusters[*]}, rebuilt from nothing${redeliver:+, and registered as new clusters}"
AI_CHAOS_DIR=$AI_CHAOS_DIR node "$DEMO/setup/kind-fleet.mjs" --repave ${redeliver:+--as-new} "${clusters[@]}"
. "$DEMO/env.sh"    # again, so the fleet's kubeconfig names the new clusters
echo "Done. What each cluster runs now is what Sveltos delivers to it."
