# Proof points: what to check, and where

Everything the demo claims can be checked in ConfigHub, from the CLI or the
web UI, or on the clusters. `bash $DEMO/proof/evidence.sh` prints ConfigHub's
own record in one go:
- the gates;
- every change order and how it ended;
- every approval and check, with who recorded it and why;
- every release, with who published it.

**In the web UI** (hub.confighub.com, your organization):

| Page | What it shows |
| --- | --- |
| Workers (`/bridge-workers`) | `devil`, `angel`, `reporter` and `milton`, each its own identity |
| Components (`/components?app=chaos-shop`, `chaos-platform`, `chaos-management`) | The base, the class bases and one deployment per cluster. Each shows Live and Synced, its release number, and Degraded while an outage lasts |
| Rollouts (`/rollouts`) | Every change order: its stages, what it waits for, Complete, and Aborted with the reason. `/rollouts/<order>` shows one order's path |
| Units (`/units`) | Each unit's revisions, with their change descriptions and diffs |

Approvals and checks (attestations) are not shown in the web UI yet; read them
with `cub attestation list --space <space>`, or `evidence.sh`.

## Setup

| Claim | How to check |
| --- | --- |
| Each agent has its own identity, and none can approve | Workers page. `cub space get chaos-shop-prod-eu -o yaml`: under Permissions, ApproveChildren names only `milton`. Approving also needs Use on the change order (UseChildren on its base Space) |
| Only you or Milton may approve, never a change's author | `evidence.sh`, Gates: `approval = 1 Approval from <you>, milton; authors counted: False` |
| A component takes changes only through its workflow | `cub component get chaos-shop -o yaml`: `ChangeWorkflowRequired: true` |
| The management record can't be published directly | `cub release publish chaos-management` is refused: "requires a ChangeWorkflow" |
| Live status reaches ConfigHub | Components: each deployment Live and Synced. `cub sveltos status --context kind-chaos-mgmt` |

## Outage 1: a rotation nobody picked up

| Claim | How to check |
| --- | --- |
| The outage was seen in ConfigHub | Components: every shop deployment Degraded. `cub sveltos status` names `shop/web` |
| The fix went through the gates | Rollouts: Angel's fix order, staging then prod. `evidence.sh`: an Approval by you or `milton` with its note, before each release |
| Angel published, and someone else approved | `evidence.sh`, Releases: `by angel`; Approvals: never `by angel` |
| The policy is configuration too | Units: `chaos-platform-base/guardrails` and its revisions. `chaos-policies/known-cases` holds the cases it was previewed against |
| The policy refuses the fault | Devil's repeat transcript: `web-copy` refused, naming `secret-env-needs-reload` (or the name Angel gave it). `kubectl get validatingadmissionpolicies --context kind-chaos-staging` |

## Outage 2: half the fleet at once

| Claim | How to check |
| --- | --- |
| Two clusters of four went down together | Components: prod-us-1 and prod-us-2 Degraded, staging and prod-eu Live |
| The fix, the policy and the clean-up each went through the record's workflow | Rollouts: `chaos-management` orders, each Complete. Any order sent back shows Aborted with its reason |
| The review checked who Sveltos writes as | `bash $DEMO/proof/token-subject.sh kind-chaos-mgmt mgmt mgmt-sveltos-kubeconfig re-kubeconfig` |
| The policy is on the management cluster, delivered by the record | `kubectl get validatingadmissionpolicies,validatingadmissionpolicybindings --context kind-chaos-mgmt -o wide`. The binding's field managers include `application/apply-patch` (Sveltos) |
| The repeat is refused | Devil's transcript: both writes Forbidden, "profiles on the management cluster come only from the record" |

## Outage 3: staging said yes, prod said no

| Claim | How to check |
| --- | --- |
| A change order can carry an edit its own summary doesn't show | `cub changeorder get chaos-shop-base <the cut>` against `cub unit diff --space chaos-shop-prod-eu shop` before its release |
| Staging ran the cache; prod was OOMKilled | Devil's staging transcript (about 46 MiB under 128Mi). `kubectl get pods -n shop --context kind-chaos-prod-eu`: restarts, last state OOMKilled |
| The fix makes prod match staging | `evidence.sh`: a ParityCheck Pass by `angel` in each prod Space, "parity with chaos-shop-staging/shop@N passed" |
| Prod's release now needs the check | `evidence.sh`, Gates: `stage prod releases need approval, parity`; `parity = 1 ParityCheck from angel` |
| The repeat is refused before release | Devil's transcript: "requires approval ... requires parity". `evidence.sh`: a ParityCheck Fail in each prod Space, naming `limits.memory "96Mi" here and "128Mi" in chaos-shop-staging` |

## Every outage

| Claim | How to check |
| --- | --- |
| What each agent saw, decided and ran | `$CHAOS_RUNS/<outage>/<agent>-<time>.md`, with the full event stream beside it (`.jsonl`) |
| What each agent was asked | `$CHAOS_RUNS/<outage>/runs.log` |
| The images for a write-up | `python3 $DEMO/agents/panel.py <run>.jsonl --pick <regex> --out panel.html` draws a run as a terminal panel; `timeline.py` draws a timeline from a `timeline.tsv` |
