#!/usr/bin/env bash
# Gives each agent its own ConfigHub identity: a service account with a key,
# and a cub configuration of its own, signed in with that key.
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
# Each agent's cub configuration is the directory $AI_CHAOS_DIR/cub/<agent>
# (CUB_CONFIG), holding one context, chaos-<agent>, and a link to your cub
# plugins. The scripts that act as an agent use it (setup/onboard.sh,
# setup/reporter.sh, proof/parity-gate-check.sh); an agent's own run gets a
# new one each time (agents/run-agent.sh), and cannot read these. Your own cub
# configuration is not touched. ConfigHub keeps only the public half of each
# key; the private half is in $AI_CHAOS_DIR/keys, which no agent can read. teardown.sh --confighub deletes both with
# the service accounts. A service account's role cannot be above yours; the
# demo needs you to be an admin. Safe to run again: a key that no longer signs
# in is replaced.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
: "${AI_CHAOS_DIR:?source demo/env.sh first}"
server=${CONFIGHUB_URL:-https://hub.confighub.com}
keys="$AI_CHAOS_DIR/keys"
plugins="${CUB_CONFIG:-$HOME/.confighub}/plugins"
umask 077
mkdir -p "$keys"
for a in devil angel reporter milton; do
  role=editor; [ "$a" = milton ] && role=viewer
  cub serviceaccount create "chaos-$a" --org-role "$role" --label Purpose=ai-chaos --allow-exists --quiet
  cfg="$AI_CHAOS_DIR/cub/$a"
  mkdir -p "$cfg"
  if [ -d "$cfg/plugins" ] && [ ! -L "$cfg/plugins" ]; then echo "$cfg/plugins should link to your plugins, but is a directory" >&2; exit 1; fi
  ln -sfn "$plugins" "$cfg/plugins"
  # CUB_CONTEXT is set as well as CUB_CONFIG: cub refuses a CUB_CONTEXT, set
  # in your shell, that its configuration does not have.
  as() { CUB_CONFIG="$cfg" CUB_CONTEXT="chaos-$a" cub "$@"; }
  if ! CUB_CONFIG="$cfg" CUB_CONTEXT= cub context list -o name 2>/dev/null | grep -qx "chaos-$a"; then
    CUB_CONFIG="$cfg" CUB_CONTEXT= cub context create "chaos-$a" --server="$server" >/dev/null
  fi
  key="$keys/chaos-$a.jwk"
  if ! { [ -s "$key" ] && as auth login --private-key="$key" >/dev/null 2>&1; }; then
    mv -f "$key" "$key.old" 2>/dev/null || true
    cub serviceaccount key add "chaos-$a" --generate "$key" --description "AI chaos demo: $a" >/dev/null
    as auth login --private-key="$key" >/dev/null 2>&1 || { echo "could not sign in as chaos-$a" >&2; exit 1; }
    rm -f "$key.old"
    # Any key it replaces is still registered: delete every other key of this
    # account, matched by its public half, so only the one in $key signs in.
    # (A second machine running the demo with these accounts loses its key.)
    x=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("x", ""))' "$key")
    mine=$(cub serviceaccount key list "chaos-$a" -o "jq=[.[] | (.UserKey // .) | select(.PublicJWK.x == \"$x\")] | length")
    if [ -z "$x" ] || [ "$mine" != 1 ]; then
      echo "chaos-$a: the new key is not listed once, so no other key was deleted; see cub serviceaccount key list chaos-$a" >&2
    else
      for kid in $(cub serviceaccount key list "chaos-$a" -o "jq=[.[] | (.UserKey // .) | select(.PublicJWK.x != \"$x\") | .Kid] | join(\" \")" | tr -d '"'); do
        if cub serviceaccount key delete "chaos-$a" "$kid" >/dev/null; then echo "chaos-$a: deleted the key it replaced, $kid"
        else echo "chaos-$a: could not delete the key it replaced, $kid" >&2; fi
      done
    fi
  fi
  echo "chaos-$a: signed in as $(as auth status 2>/dev/null | awk '/^User/ {print $2}')"
done

me=$(cub auth status | awk '/^User/ {print $2}')
you=$(cub user list -o json | python3 -c "import json,sys; print(next((u.get('User',u)['UserID'] for u in json.load(sys.stdin) if u.get('User',u).get('Username')==sys.argv[1]), ''))" "$me")
milton=$(cub serviceaccount get chaos-milton -o jq=.ServiceAccount.UserID | tr -d '"\n')
[ -n "$you" ] && [ -n "$milton" ] && [ "$milton" != null ] || { echo "could not read the user IDs" >&2; exit 1; }
printf 'export YOU_ID=%s\nexport MILTON_ID=%s\n' "$you" "$milton" > "$AI_CHAOS_DIR/ids.env"
echo "approvers: you ($me) $you, milton $milton; written to $AI_CHAOS_DIR/ids.env"
