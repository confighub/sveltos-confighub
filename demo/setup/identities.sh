#!/usr/bin/env bash
# Gives each agent its own ConfigHub identity: a service account with a key,
# and a cub context signed in with that key.
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
# ConfigHub keeps only the public half of each key. The private half is in
# $AI_CHAOS_DIR/keys, readable by you alone, and teardown.sh --confighub
# deletes it with the service accounts. A service account's role cannot be
# above yours; the demo needs you to be an admin. The active cub context is
# not changed. Safe to run again: a key that no longer signs in is replaced.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
: "${AI_CHAOS_DIR:?source demo/env.sh first}"
server=${CONFIGHUB_URL:-https://hub.confighub.com}
keys="$AI_CHAOS_DIR/keys"
umask 077
mkdir -p "$keys"
for a in devil angel reporter milton; do
  role=editor; [ "$a" = milton ] && role=viewer
  cub serviceaccount create "chaos-$a" --org-role "$role" --label Purpose=ai-chaos --allow-exists --quiet
  cub context create "chaos-$a" --server="$server" >/dev/null 2>&1 || true
  key="$keys/chaos-$a.jwk"
  if ! { [ -s "$key" ] && cub --context "chaos-$a" auth login --private-key="$key" >/dev/null 2>&1; }; then
    mv -f "$key" "$key.old" 2>/dev/null || true
    cub serviceaccount key add "chaos-$a" --generate "$key" --description "AI chaos demo: $a, on $(hostname -s)" >/dev/null
    cub --context "chaos-$a" auth login --private-key="$key" >/dev/null 2>&1 || { echo "could not sign in as chaos-$a" >&2; exit 1; }
    rm -f "$key.old"
  fi
  echo "chaos-$a: signed in as $(cub --context "chaos-$a" auth status 2>/dev/null | awk '/^User/ {print $2}')"
done

me=$(cub auth status | awk '/^User/ {print $2}')
you=$(cub user list -o json | python3 -c "import json,sys; print(next((u.get('User',u)['UserID'] for u in json.load(sys.stdin) if u.get('User',u).get('Username')==sys.argv[1]), ''))" "$me")
milton=$(cub serviceaccount get chaos-milton -o jq=.ServiceAccount.UserID | tr -d '"\n')
[ -n "$you" ] && [ -n "$milton" ] && [ "$milton" != null ] || { echo "could not read the user IDs" >&2; exit 1; }
printf 'export YOU_ID=%s\nexport MILTON_ID=%s\n' "$you" "$milton" > "$AI_CHAOS_DIR/ids.env"
echo "approvers: you ($me) $you, milton $milton; written to $AI_CHAOS_DIR/ids.env"
