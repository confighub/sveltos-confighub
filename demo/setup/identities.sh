#!/usr/bin/env bash
# Gives each agent its own ConfigHub identity: a server worker in the Space
# chaos-agents, and a cub context signed in as that worker.
#   devil     causes the outages (org role editor)
#   angel     fixes them and writes what prevents them (org role editor)
#   reporter  writes live status (org role editor)
#   milton    reviews and approves, when you let it (org role viewer;
#             setup/grant-agents.sh gives it ApproveChildren on the demo's Spaces)
# Then writes $AI_CHAOS_DIR/ids.env with your user ID and Milton's, which the
# workflows name as the approvers.
#
#   source demo/env.sh && bash $DEMO/setup/identities.sh
#
# A worker's ID and secret go from cub into one subshell's environment only,
# never to disk or output. The active cub context is not changed.
set -euo pipefail
: "${AI_CHAOS_DIR:?source demo/env.sh first}"
server=${CONFIGHUB_URL:-https://hub.confighub.com}
cub space create chaos-agents --label Purpose=ai-chaos --allow-exists --quiet
for a in devil angel reporter milton; do
  role=editor; [ "$a" = milton ] && role=viewer
  cub worker create --space chaos-agents "$a" --is-server-worker --org-role "$role" --allow-exists --quiet
  cub context create "chaos-$a" --server="$server" >/dev/null 2>&1 || true
  (
    eval "$(cub worker get-envs --space chaos-agents "$a" 2>/dev/null)"
    [ -n "${CONFIGHUB_WORKER_ID:-}" ] && [ -n "${CONFIGHUB_WORKER_SECRET:-}" ] || { echo "no credentials for $a" >&2; exit 1; }
    cub --context "chaos-$a" auth login --as-worker >/dev/null 2>&1
  )
  echo "chaos-$a: signed in as $(cub --context "chaos-$a" auth status 2>/dev/null | awk '/^User/ {print $2}')"
done

me=$(cub auth status | awk '/^User/ {print $2}')
you=$(cub user list -o json | python3 -c "import json,sys; print(next((u.get('User',u)['UserID'] for u in json.load(sys.stdin) if u.get('User',u).get('Username')==sys.argv[1]), ''))" "$me")
milton=$(cub worker get --space chaos-agents milton -o jq=.BridgeWorker.UserID | tr -d '"\n')
[ -n "$you" ] && [ -n "$milton" ] || { echo "could not read the user IDs" >&2; exit 1; }
printf 'export YOU_ID=%s\nexport MILTON_ID=%s\n' "$you" "$milton" > "$AI_CHAOS_DIR/ids.env"
echo "approvers: you ($me) $you, milton $milton; written to $AI_CHAOS_DIR/ids.env"
