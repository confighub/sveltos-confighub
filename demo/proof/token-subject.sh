#!/usr/bin/env bash
# Prints who a kubeconfig in a Secret authenticates as: the subject of each
# token in it, never the token itself. For checking which identity Sveltos
# writes to a cluster as (outage 2's review).
#
#   bash $DEMO/proof/token-subject.sh <kubectl context> <namespace> <secret> <key>
#   bash $DEMO/proof/token-subject.sh kind-chaos-mgmt mgmt mgmt-sveltos-kubeconfig re-kubeconfig
set -euo pipefail
ctx=$1 ns=$2 secret=$3 key=$4
kubectl --context "$ctx" -n "$ns" get secret "$secret" -o "jsonpath={.data.$key}" | python3 -c '
import base64, json, sys, yaml
config = yaml.safe_load(base64.b64decode(sys.stdin.read()))
for u in config.get("users", []):
    token = (u.get("user") or {}).get("token")
    if not token:
        print(u.get("name"), "(no token)"); continue
    part = token.split(".")[1]; part += "=" * (-len(part) % 4)
    print(u.get("name"), json.loads(base64.urlsafe_b64decode(part)).get("sub"))
'
