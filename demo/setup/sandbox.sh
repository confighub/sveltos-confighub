#!/usr/bin/env bash
# The policy sandbox: a disposable kind cluster that holds admission policies
# and nothing else, where cub sveltos impact and check judge each object with a
# server-side dry run. It gets Sveltos's resource types (CRDs only, no
# controllers), so policies on ClusterProfiles can be judged too.
#
#   source demo/env.sh && bash $DEMO/setup/sandbox.sh            build it
#   source demo/env.sh && bash $DEMO/setup/sandbox.sh --reset    empty it again
#
# Name it every time: --sandbox-kubeconfig "$AI_CHAOS_DIR/sandbox.kubeconfig".
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
if [ "${1:-}" = --reset ]; then
  # Back to empty: no admission policies, no test-* grants made for
  # impersonation, and no namespace but Kubernetes' own.
  k="kubectl --kubeconfig ${AI_CHAOS_DIR}/sandbox.kubeconfig"
  $k delete validatingadmissionpolicybindings,validatingadmissionpolicies --all >/dev/null
  for b in $($k get clusterrolebindings -o name | grep '/test-' || true); do
    $k delete "$b" >/dev/null && echo "deleted $b"
  done
  for ns in $($k get ns -o jsonpath='{.items[*].metadata.name}'); do
    case $ns in default|kube-*|local-path-storage) ;; *) $k delete namespace "$ns" --wait=false >/dev/null && echo "deleted namespace $ns" ;; esac
  done
  echo "sandbox reset"; exit 0
fi
dir=${AI_CHAOS_DIR:-$HOME/ai-chaos}
sveltos=${SVELTOS_VERSION:-v1.15.0}
mkdir -p "$dir"
kind get clusters 2>/dev/null | grep -q '^chaos-policy-sandbox$' ||
  kind create cluster --name chaos-policy-sandbox --kubeconfig "$dir/sandbox.kubeconfig" --wait 180s
manifest=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/projectsveltos/sveltos/$sveltos/manifest/manifest.yaml" -o "$manifest"
python3 - "$manifest" <<'PY' | kubectl --kubeconfig "$dir/sandbox.kubeconfig" apply --server-side -f - >/dev/null
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "CustomResourceDefinition"]
yaml.safe_dump_all(docs, sys.stdout)
PY
rm -f "$manifest"
echo "sandbox ready: $dir/sandbox.kubeconfig ($(kubectl --kubeconfig "$dir/sandbox.kubeconfig" get crd -o name | grep -c projectsveltos) Sveltos CRDs)"
