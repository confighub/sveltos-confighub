#!/usr/bin/env bash
# Checks outage 3's prevention without any AI agent, in about two minutes and
# for nothing: the parity gate, and `cub sveltos check --parity-with staging`.
# Run it after onboarding, when no outage is in progress. It acts as you, and
# as Devil and Angel through their cub contexts:
#   1. as Angel: the check passes the onboarding order, where prod matches staging;
#   2. as you:   the parity gate on chaos-shop-base/rollout (outage 3's step 10),
#                skipped when it is already there;
#   3. as Devil: a prod-only cut (api memory 128Mi to 96Mi, undeclared) in a
#                change order promoted to prod;
#   4. as Devil: its release to prod-eu, which must be refused for approval and parity;
#   5. as Angel: the check, which must fail and name the field;
#   6. as Devil: the cut withdrawn, the units back where they were; and, as you,
#                the gate taken off again if this check put it on, so outage 3
#                can still be staged.
# It ends by saying whether each expectation held, and exits non-zero if one did not.
#
#   source demo/env.sh && bash $DEMO/proof/parity-gate-check.sh
set -uo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
order=parity-gate-check-$(date -u +%H%M%S)
failed=0 added=0
expect() { # expect <what> <text> <pattern>: report whether the text shows it
  if printf '%s' "$2" | grep -Eq "$3"; then echo "  ok      $1"; else echo "  NOT MET $1"; failed=1; fi
}
devil() { CUB_CONTEXT=chaos-devil "$@"; }
angel() { CUB_CONTEXT=chaos-angel "$@"; }

echo "== 1. the check passes where prod matches staging"
onboard=$(cub changeorder list --space chaos-shop-base -o jq='.[].ChangeOrder.Slug' | tr -d '"' | grep '^onboard-' | head -1)
out=$(angel cub sveltos check --change-order "chaos-shop-base/$onboard" --stage prod --parity-with staging 2>&1); echo "$out"
expect "the check passes chaos-shop-base/$onboard in prod" "$out" "passed .*recorded a Pass"

echo "== 2. the parity gate"
if cub changeworkflow get rollout --space chaos-shop-base -o yaml | grep -q "Type: ParityCheck"; then
  echo "  already there"
else
  angel_id=$(cub worker get --space chaos-agents angel -o jq=.BridgeWorker.UserID | tr -d '"')
  cub changeworkflow update rollout --space chaos-shop-base \
    --attestation-prerequisite approval --attestation-prerequisite parity \
    --attestation-prerequisite-type parity=ParityCheck --attestation-prerequisite-count parity=1 \
    --attestation-prerequisite-allow-authors parity=true --attestation-prerequisite-from-user-ids "parity=$angel_id" \
    --stage-release-prerequisites 'prod=approval;parity' >/dev/null && added=1 && echo "  added: prod needs an approval and Angel's ParityCheck"
fi

echo "== 3. a prod-only cut, as Devil"
before=$(devil cub unit get shop --space chaos-shop-class-prod -o jq=.Unit.HeadRevisionNum)
devil cub function set --space chaos-shop-class-prod --unit shop --where-resource "metadata.name = 'api'" \
  --change-desc "api: memory limit 128Mi -> 96Mi in prod only (parity gate check)" \
  set-string-path apps/v1/Deployment "spec.template.spec.containers.?name=api.resources.limits.memory" 96Mi >/dev/null
devil cub changeorder create --space chaos-shop-base "$order" --change-workflow chaos-shop-base/rollout \
  --description "Prod only: api memory limit 96Mi, undeclared (parity gate check)" >/dev/null
for stage in bases staging prod; do
  devil cub variant promote --change-order "chaos-shop-base/$order" --target-stage "$stage" --change-desc "parity gate check" >/dev/null
done
echo "  chaos-shop-base/$order promoted to prod"

echo "== 4. its release, as Devil"
out=$(devil cub release publish chaos-shop-prod-eu --revision "ChangeOrder:chaos-shop-base/$order" 2>&1); echo "$out" | tail -2
expect "the release is refused for approval and parity" "$out" "requires approval.*requires parity"

echo "== 5. the check, as Angel"
out=$(angel cub sveltos check --change-order "chaos-shop-base/$order" --stage prod --parity-with staging 2>&1); echo "$out" | head -2
expect "the check fails, naming the field" "$out" 'limits\.memory is "96Mi" here and "128Mi" in chaos-shop-staging'

echo "== 6. the cut withdrawn, as Devil"
devil cub changeorder update --space chaos-shop-base "$order" --aborted-reason "Parity gate check: refused at the prod release; withdrawn" >/dev/null
devil cub unit update shop --space chaos-shop-class-prod --restore "$before" --change-desc "Withdraw the parity gate check cut" >/dev/null
for s in chaos-shop-prod-eu chaos-shop-prod-us-1 chaos-shop-prod-us-2; do
  devil cub unit update shop --space "$s" --restore LastReleasedRevisionNum --change-desc "Withdraw the parity gate check cut" >/dev/null
done
for s in chaos-shop-class-prod chaos-shop-prod-eu chaos-shop-prod-us-1 chaos-shop-prod-us-2; do
  expect "$s is back at 128Mi" "$(cub unit data --space "$s" shop)" "limits: \{memory: 128Mi\}"
done

if [ "$added" = 1 ]; then
  cub changeworkflow update rollout --space chaos-shop-base --attestation-prerequisite approval \
    --stage-release-prerequisites 'prod=approval' >/dev/null && echo "  the gate is off again: prod needs an approval only"
fi

echo
if [ "$failed" = 0 ]; then echo "The parity gate works."; else echo "An expectation was not met: read the output above."; exit 1; fi
