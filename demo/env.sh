# Source this in every terminal you use for the demo:
#
#   source demo/env.sh
#
# It sets where the demo keeps its files, points kubectl at the fleet, and
# loads the identities' user IDs once setup/identities.sh has written them.
# Override any of these before sourcing.
export DEMO=${DEMO:-$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)}
export AI_CHAOS_DIR=${AI_CHAOS_DIR:-$HOME/ai-chaos}       # kubeconfigs, onboarding output, logs
export CHAOS_RUNS=${CHAOS_RUNS:-$AI_CHAOS_DIR/runs}       # where agent runs are written
export CONFIGHUB_URL=${CONFIGHUB_URL:-https://hub.confighub.com}
mkdir -p "$AI_CHAOS_DIR" "$CHAOS_RUNS"

# One kubeconfig with a context per cluster (kind-chaos-mgmt, kind-chaos-staging, ...).
_demo_kc=$(find "$AI_CHAOS_DIR" -maxdepth 1 -name 'chaos-*.kubeconfig' 2>/dev/null | sort | paste -sd: -)
if [ -n "$_demo_kc" ]; then
  KUBECONFIG=$_demo_kc kubectl config view --flatten > "$AI_CHAOS_DIR/fleet.kubeconfig"
  export KUBECONFIG=$AI_CHAOS_DIR/fleet.kubeconfig
fi
unset _demo_kc

# YOU_ID and MILTON_ID, written by setup/identities.sh.
[ -f "$AI_CHAOS_DIR/ids.env" ] && . "$AI_CHAOS_DIR/ids.env"
true
