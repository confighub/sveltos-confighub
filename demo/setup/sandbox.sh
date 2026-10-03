#!/usr/bin/env bash
# The policy sandbox: a disposable kind cluster that holds admission policies
# and nothing else, where cub sveltos impact and check judge each object with a
# server-side dry run. It gets Sveltos's resource types (CRDs only, no
# controllers), so policies on ClusterProfiles can be judged too.
#
#   source demo/env.sh && bash $DEMO/setup/sandbox.sh
#
# Name it every time: --sandbox-kubeconfig "$AI_CHAOS_DIR/sandbox.kubeconfig".
set -euo pipefail
dir=${AI_CHAOS_DIR:-${TMPDIR:-/tmp}/sveltos-ai-chaos}
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
