#!/usr/bin/env bash
# Runs one agent once, headless, as its own ConfigHub identity, and keeps
# everything it says and does.
#
#   source demo/env.sh
#   bash $DEMO/agents/run-agent.sh <devil|angel|milton> <run-name> <prompt-file>
#
# The prompt file may name ${VARIABLES}; each is filled from the environment,
# and a missing one stops the run before the agent starts (for example
# FIX_ORDER=web-reload bash run-agent.sh angel 01-rotation prompts/01-rotation/4-angel-release-staging.txt).
# The full event stream goes to $CHAOS_RUNS/<run-name>/<agent>-<UTC>.jsonl,
# with a readable transcript beside it (.md).
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
agent=$1 run=$2 prompt_file=$3
here=$(cd "$(dirname "$0")" && pwd)
: "${AI_CHAOS_DIR:?source demo/env.sh first}" "${CHAOS_RUNS:?source demo/env.sh first}" "${DEMO:?source demo/env.sh first}"
task=$(python3 - "$prompt_file" <<'PY'
import os, re, sys
text = open(sys.argv[1]).read().strip()
missing = sorted({m for m in re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", text) if not os.environ.get(m)})
if missing:
    sys.exit("set " + ", ".join(missing) + " for this prompt")
print(re.sub(r"\$\{([A-Z_][A-Z0-9_]*)\}", lambda m: os.environ[m.group(1)], text))
PY
)
out="$CHAOS_RUNS/$run"; mkdir -p "$out"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
log="$out/$agent-$stamp.jsonl"


# What each agent may run. Anything not allowed is refused, and the agent is
# told so; it cannot ask. No agent sees MCP servers or connectors.
never=("Bash(cub variant approve:*)" "Bash(cub attestation create:*)" "Bash(cub attestation revoke:*)"
       "Bash(cub space delete:*)" "Bash(cub changeworkflow create:*)" "Bash(cub changeworkflow update:*)"
       "Bash(cub changeworkflow edit:*)" "Bash(cub changeworkflow delete:*)" "Bash(cub component update:*)"
       "Bash(cub worker:*)" "Bash(cub auth:*)" "Bash(cub context:*)" "Bash(cub serviceaccount:*)"
       "Bash(kubectl delete namespace:*)" "Bash(kubectl delete ns:*)")
# Every agent: no cub command that names a context or prints credentials, and
# no command that sets cub's context or configuration; no reading your cub
# configuration, the keys, the agents' cub configurations or these guards.
# The Read rules also refuse Edit and Write there, and cat, head and the like.
# Paths as the sandbox sees them, symlinks resolved.
chaos=$(cd "$AI_CHAOS_DIR" && pwd -P)
cubconfig=$(cd "${CUB_CONFIG:-$HOME/.confighub}" && pwd -P)
home=$(cd "$HOME" && pwd -P)
guard=("Bash(cub *--context*)" "Bash(cub *--debug*)" "Bash(*CUB_CONTEXT*)" "Bash(*CUB_CONFIG*)"
       "Read(/$cubconfig/**)" "Read(/$chaos/keys/**)" "Read(/$chaos/cub/**)" "Read(/$chaos/guards/**)"
       "Edit(./.claude/**)")
case $agent in
  devil)
    tools=Bash
    allowed=("Bash(kubectl:*)" "Bash(cub:*)" "Bash(date:*)" "Bash(openssl rand:*)")
    # It rotates shop-token on the workload clusters; the management cluster's
    # Secrets hold the delivery account's token.
    denied=("${never[@]}" "Bash(kubectl *kind-chaos-mgmt*secret*)" "Bash(kubectl *secret*kind-chaos-mgmt*)") ;;
  angel)
    tools=Bash,Read,Write,Edit
    allowed=("Bash(kubectl get:*)" "Bash(kubectl describe:*)" "Bash(kubectl logs:*)" "Bash(cub:*)" "Bash(date:*)" "Read(./**)" "Edit(./**)")
    denied=("${never[@]}" "Bash(kubectl *secret*)") ;;
  milton)
    # Milton reads and approves; it changes nothing else. In the sandbox it may
    # apply a policy and impersonate identities, to test what it approves.
    tools=Bash
    allowed=("Bash(cub variant approve:*)" "Bash(cub changeorder get:*)" "Bash(cub changeorder list:*)"
             "Bash(cub unit get:*)" "Bash(cub unit list:*)" "Bash(cub unit data:*)" "Bash(cub unit diff:*)"
             "Bash(cub revision:*)" "Bash(cub variant diff:*)" "Bash(cub space get:*)" "Bash(cub space list:*)"
             "Bash(cub attestation list:*)" "Bash(cub release list:*)" "Bash(cub release get:*)"
             "Bash(cub changeworkflow get:*)" "Bash(cub target get:*)" "Bash(cub target list:*)"
             "Bash(cub sveltos impact:*)" "Bash(cub sveltos status:*)"
             "Bash(kubectl get:*)" "Bash(kubectl describe:*)" "Bash(kubectl auth can-i:*)"
             "Bash(kubectl --kubeconfig $AI_CHAOS_DIR/sandbox.kubeconfig:*)"
             "Bash(bash $DEMO/proof/token-subject.sh:*)" "Bash(date:*)")
    denied=("Bash(cub attestation create:*)" "Bash(cub attestation revoke:*)" "Bash(cub worker:*)"
            "Bash(cub auth:*)" "Bash(cub context:*)" "Bash(cub serviceaccount:*)"
            "Bash(kubectl *secret*)" "Bash(kubectl *--kubeconfig*--kubeconfig*)") ;;
  *) echo "agent is devil, angel or milton" >&2; exit 2 ;;
esac

echo "$(date -u +%FT%TZ) $agent ($prompt_file): $task" >> "$out/runs.log"
# The agent starts in an empty directory outside any repository, so it has no
# settings, memory or instructions from wherever this script is run, and it
# reads nothing on stdin. The directory goes when the run ends.
work=$(mktemp -d "${TMPDIR:-/tmp}/ai-chaos-$agent-XXXXXX"); work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
cd "$work"

# A cub configuration made for this run, in its directory: one context,
# signed in afresh with the agent's key, and the one plugin it uses. Only this
# run reads it, so nothing the agent writes there reaches any other script.
server=${CONFIGHUB_URL:-https://hub.confighub.com}
cfg="$work/.cub"
# cub passes over a plugin that is a symbolic link, so the plugin is copied.
mkdir -p "$cfg/plugins"
cp -R "$cubconfig/plugins/sveltos-confighub" "$cfg/plugins/"
CUB_CONFIG="$cfg" CUB_CONTEXT= cub context create "chaos-$agent" --server="$server" >/dev/null
CUB_CONFIG="$cfg" CUB_CONTEXT="chaos-$agent" cub auth login --private-key="$chaos/keys/chaos-$agent.jwk" >/dev/null 2>&1 ||
  { echo "could not sign in as chaos-$agent: run setup/identities.sh" >&2; exit 1; }

# A kubeconfig with a context per cluster and no current one, so every
# command names its cluster.
kubeconfig="$work/.kubeconfig"
(umask 077; KUBECONFIG=$(find "$chaos" -maxdepth 1 -name 'chaos-*.kubeconfig' | sort | paste -sd: -) kubectl config view --flatten > "$kubeconfig")
KUBECONFIG="$kubeconfig" kubectl config unset current-context >/dev/null

# The sandbox every command the agent runs is held in (macOS Seatbelt). It
# reads nothing in your home folder but what the agent's tools need: cub, the
# policy sandbox's kubeconfig, Python's packages and, for Milton,
# proof/token-subject.sh. So not your cub configuration, the keys,
# the other agents' configurations, your notes or other credentials, whichever
# program asks (kubectl --from-file included). It writes only its own
# directory, never its .claude settings. It reaches ConfigHub, and local ports
# (the kind clusters). Commands cannot leave the sandbox. Go programs such as
# cub check TLS through macOS's trust service, which the sandbox reaches only
# with enableWeakerNetworkIsolation.
host=${server#*://}; host=${host%%/*}; host=${host%%:*}
mkdir -p "$chaos/guards"
settings="$chaos/guards/$agent.json"
python3 - "$settings" "$work" "$host" "$home" "$chaos" "$cubconfig" "$(dirname "$(command -v cub)")" \
  "$chaos/sandbox.kubeconfig" "$home/Library/Python" \
  "$(cd "$DEMO" && pwd -P)/proof/token-subject.sh" <<'PY'
import json, sys
out, work, host, home, chaos, cubconfig, *readable = sys.argv[1:]
json.dump({"sandbox": {
    "enabled": True, "failIfUnavailable": True,
    "allowUnsandboxedCommands": False, "autoAllowBashIfSandboxed": False,
    "enableWeakerNetworkIsolation": True,
    "filesystem": {"denyRead": [home, chaos, cubconfig], "allowRead": readable,
                   "allowWrite": [work], "denyWrite": [work + "/.claude"]},
    "network": {"allowedDomains": [host, "*." + host], "allowLocalBinding": True}}},
    open(out, "w"), indent=2)
PY

model=()
[ -n "${MODEL:-}" ] && model=(--model "$MODEL")
env -u CUB_TOKEN -u CUB_SERVER -u GITHUB_TOKEN \
  CUB_CONFIG="$cfg" CUB_CONTEXT="chaos-$agent" KUBECONFIG="$kubeconfig" KUBECACHEDIR="$work/.kube-cache" AI_CHAOS_DIR="$AI_CHAOS_DIR" \
  claude -p "$task" ${model[@]+"${model[@]}"} --setting-sources project --settings "$settings" --permission-mode dontAsk \
    --append-system-prompt "$(sed -e "s|\$AI_CHAOS_DIR|$AI_CHAOS_DIR|g" -e "s|\$DEMO|$DEMO|g" "$here/$agent.md")" \
    --tools "$tools" --strict-mcp-config \
    --output-format stream-json --verbose \
    --allowedTools "${allowed[@]}" --disallowedTools "${denied[@]}" "${guard[@]}" \
    --no-session-persistence \
  < /dev/null > "$log"
python3 "$here/render.py" "$log" > "${log%.jsonl}.md"
echo "$agent: ${log%.jsonl}.md"
