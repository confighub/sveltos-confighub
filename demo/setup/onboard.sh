#!/usr/bin/env bash
# Onboards the fleet into ConfigHub with cub sveltos, Angel doing the work:
# one variant per cluster for the shop and the platform, the management
# cluster's record delivered from ConfigHub, continuous health checks, and
# every release waiting for an approval from you or Milton.
#
#   source demo/env.sh && bash $DEMO/setup/onboard.sh            propose, and release what is approved
#   source demo/env.sh && bash $DEMO/setup/onboard.sh --handover hand delivery over to ConfigHub
#
# Run it, approve what it says waits (scenarios/00-onboard.md), run it again,
# until both stages are released; then --handover.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
: "${AI_CHAOS_DIR:?source demo/env.sh first}" "${YOU_ID:?run setup/identities.sh, then source demo/env.sh again}" "${MILTON_ID:?}"
out=$AI_CHAOS_DIR/onboard
mkdir -p "$out" "$AI_CHAOS_DIR/by-name"
for c in staging prod-eu prod-us-1 prod-us-2; do ln -sf "$AI_CHAOS_DIR/chaos-$c.kubeconfig" "$AI_CHAOS_DIR/by-name/$c.kubeconfig"; done
mgmt="kubectl --kubeconfig $AI_CHAOS_DIR/chaos-mgmt.kubeconfig"
if [ ! -f "$out/fleet.yaml" ]; then
  { $mgmt get clusterprofiles,sveltosclusters -A -o yaml; echo "---"; $mgmt -n default get configmap shop -o yaml; } > "$out/fleet.yaml"
fi
approvers=()
for a in ${APPROVERS:-$YOU_ID $MILTON_ID}; do approvers+=(--approver "$a"); done
(cd "$out" && cub sveltos apply fleet.yaml --prefix chaos --class-label env --stage-label env --stages staging,prod \
  --management-release "${approvers[@]}" --out onboard >/dev/null)
cd "$out/onboard"
export KUBECONFIG=$AI_CHAOS_DIR/chaos-mgmt.kubeconfig MGMT_CONTEXT=kind-chaos-mgmt CLUSTER_KUBECONFIGS=$AI_CHAOS_DIR/by-name
if [ "${1:-}" = --handover ]; then
  CUB_CONTEXT=chaos-angel bash handover.sh
else
  CUB_CONTEXT=chaos-angel PROPOSE_ONLY=1 bash apply.sh 2>&1 | tee -a "$AI_CHAOS_DIR/onboard.log" | grep -E "^== |waits|approve|released|Released|Failed|error" || true
fi
