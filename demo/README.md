# AI chaos in production: run it yourself

Three outages on a Sveltos fleet, each caused on purpose, fixed through
ConfigHub, and then prevented, by AI agents with their own ConfigHub
identities:

- **Devil** causes each outage the way it happens in real life.
- **Angel** finds the cause, fixes it through ConfigHub, and proposes what
  stops it recurring.
- **Milton** reviews and approves, if you let it.
- **You** approve by hand at any step, or leave it to Milton.

Neither Devil nor Angel can approve. Kind clusters stand in for production.

| Outage | What breaks | What prevents it |
| --- | --- | --- |
| [1. A rotation nobody picked up](scenarios/01-rotation.md) | A Secret rotated outside ConfigHub; `web` keeps the old token on every cluster | Admission policy: a workload that takes a Secret from its environment must say how it picks up a rotation |
| [2. Half the fleet at once](scenarios/02-blast-radius.md) | A ClusterProfile applied by hand blocks the shop on the two `region=us` clusters | Admission policy on the management cluster: profiles come only from the record |
| [3. Staging said yes, prod said no](scenarios/03-parity.md) | A prod-only memory limit, then a cache that passes staging, so prod is OOMKilled | Prod's release requires a parity check; differences from staging must be declared |

[PROOF.md](PROOF.md) lists each claim and where to check it, in the CLI and
the web UI. We ran it twice, and [diary/](diary/README.md) tells each run as it
happened, with screenshots and the agents' own commands:
- [the first run](diary/first-run.md), with a person approving;
- [the verification run](diary/verification-run.md), made from this README with
  Milton approving everything. There Milton refused the change behind outage 3.

[recording/](recording/README.md) has the first run's transcripts, and
ConfigHub's record of both runs.

## The words used here

| Word | What it means here |
| --- | --- |
| **Space** | A ConfigHub folder of configuration, one per base, class base or cluster. The demo's are named `chaos-*` |
| **Base, class base, variant** | The shop's configuration in `chaos-shop-base`, cloned into a class base for staging and one for prod, then into one variant per cluster (`chaos-shop-staging`, `chaos-shop-prod-eu`, ...). The web UI shows each variant as a deployment |
| **Change order** | One named change, followed through a workflow. Written `<base Space>/<name>`, for example `chaos-shop-base/web-reload-on-token-rotation` |
| **Workflow, stage** | The path a change order takes: `bases`, then `staging`, then `prod`. Each stage may need approvals before its release |
| **Release** | What ConfigHub publishes for a variant, and what Sveltos fetches and applies to that cluster |
| **Attestation** | A recorded verdict on a change: an Approval by you or Milton, or a ParityCheck by Angel |
| **The record** | The management cluster's Space, `chaos-management`. Its releases deliver every Sveltos delivery profile, so profiles come from ConfigHub, not by hand |
| **Guard** | A note on a field of a unit. A guard `departure=<why>` declares that prod may differ from staging there |
| **Live status** | What each cluster reports, written into ConfigHub every 15 seconds: Synced or not, Healthy or Degraded. The web UI shows Healthy as Live |

## Versions

Tested together on 2026-10-03. On 2026-10-04 the server moved to v0.8.3; stand-up,
onboarding, the gates and the parity gate were rechecked on it
([the check](recording/check-2026-10-04.md)).


| Product | Version |
| --- | --- |
| ConfigHub (hub.confighub.com) | server v0.8.1, and rechecked on v0.8.3. The hosted server moves on: you get the version it runs |
| `cub` | v0.8.1 |
| `cub sveltos` (this repository) | v0.13.0 |
| `cub helm` | v0.1.1 |
| Sveltos | v1.15.0 (installed by the fleet script) |
| kind | v0.31.0, Kubernetes v1.35.0 nodes |
| Stakater Reloader (Helm chart) | 2.2.18 |
| Claude Code | 2.1.285, model `claude-opus-5-5` |
| Also used | kubectl v1.36, Docker 29.4, Node.js 25, Python 3 with PyYAML |

kind before v0.31 does not enforce NetworkPolicy by default, and outage 2
needs it.

Each agent signs in to ConfigHub as a worker (`setup/identities.sh`).
ConfigHub plans to replace that with service accounts, so later versions of
`cub` may need a different setup.

## What you need

- **A machine** with Docker and room for six kind clusters. We used 18 cores
  and 48 GB. On Linux, raise the inotify limits first, as kind's docs say for
  many clusters.
- **A ConfigHub organization** with 20 free Spaces, and a user with the admin
  role there. Setup creates Spaces, workers with org roles and components; it
  sets permissions on Spaces and edits workflows. The scripts act through your current
  `cub` context. If it points at another organization, run
  `export CUB_CONTEXT=<your context>` in each terminal, setup and teardown
  included.
- **Claude Code**, signed in. The agents' runs cost about $20 to $30 in all,
  and the whole demo takes two to three hours.
- **`cub` and the plugins**, at the versions above. ConfigHub's installer
  takes a version, and puts `cub` in `~/.confighub/bin`:

  ```bash
  curl -fsSL https://hub.confighub.com/cub/install.sh | VERSION=v0.8.1 bash
  export PATH=$HOME/.confighub/bin:$PATH
  cub auth login
  cub plugin install confighub/sveltos-confighub@v0.13.0
  cub plugin install confighub/cub-helm@v0.1.1
  ```

## Stand it up

`demo/env.sh` sets three paths, which every step uses:
- `$DEMO`, the demo directory;
- `$AI_CHAOS_DIR` (default `~/ai-chaos`), for the kubeconfigs, the onboarding
  output and the agents' runs;
- `$CHAOS_RUNS` (default `$AI_CHAOS_DIR/runs`), where each agent run is kept.

```bash
git clone https://github.com/confighub/sveltos-confighub && cd sveltos-confighub
bash demo/standup.sh                        # checks what it needs, then builds everything
source demo/env.sh                          # in every terminal you use
```

`bash demo/standup.sh --check` only checks for the tools, the sign-in and the
plugins. The full run takes about eight minutes. Running it again is safe: it
keeps the clusters and identities it finds, brings the rest up to date, and
skips the shop once the fleet is onboarded. In order, it runs:

```bash
node $DEMO/setup/kind-fleet.mjs             # chaos-mgmt and four workload clusters, Sveltos v1.15.0
bash $DEMO/setup/sandbox.sh                 # the policy sandbox: a kind cluster with Sveltos's CRDs and nothing running
bash $DEMO/setup/setup-shop.sh              # the shop and Reloader, delivered by plain Sveltos
bash $DEMO/setup/identities.sh              # devil, angel, reporter, milton; writes your user ID and Milton's
```

Then onboard the fleet into ConfigHub, with a script signed in as Angel doing
the work and you or Milton approving: [scenarios/00-onboard.md](scenarios/00-onboard.md).
Onboarding ends by granting the agents their permissions, gating the
workflows, and starting live status.

## Approvals: by hand or by Milton

Every release waits for one approval, from you or Milton, and never from the
change's author. The one exception is onboarding's handover: it publishes the
record's first release before the gates go on. Each approval step offers both:

```bash
bash $DEMO/approve.sh me     chaos-shop-base/<order> staging "<why, in your words>"
bash $DEMO/approve.sh milton chaos-shop-base/<order> staging <run-name> [requester]
```

`me` records your approval with your note. `milton` has Milton review the
order against what the requester wrote in that run. The requester is `angel`
unless you name another; outage 3 names `devil`. Milton reads:
- the change order;
- every Space's diff, head against last release;
- the evidence the request cites.

It then approves with a note saying what it checked, or says why not. To allow
only one of you, set `APPROVERS=$YOU_ID` or `APPROVERS=$MILTON_ID` before
running `setup/onboard.sh` and `setup/gates.sh`.

Milton is meant to catch things, and it may. In our verification run it
refused Devil's prod-only memory cut in outage 3: staging never ran it, and
nothing showed it was safe. To stage the outage anyway, approve that step by
hand.

## Run the outages

Each scenario is a table of steps. Each step runs an agent with a prompt file
from `prompts/`, or approves. Run them in order: 1, 2, 3.

```bash
bash $DEMO/agents/run-agent.sh <devil|angel|milton> <run-name> <prompt-file>
```

The prompts name the change orders an earlier step created as `${VARIABLES}`.
Set them on the command line, without the order's Space, for example
`FIX_ORDER=web-reload-on-token-rotation bash ...`. Each agent's report names
its change orders, and so does `cub changeorder list --space <base space>`.

Each run:
- **Identity:** acts as that agent's ConfigHub identity.
- **Isolation:** starts in an empty directory, outside any repository, with
  nothing on stdin and no MCP servers or connectors.
- **Tools:** may use only the tools its role allows (`agents/run-agent.sh`):
  - Devil changes things with kubectl and cub;
  - Angel reads the clusters and works through ConfigHub;
  - Milton reads, tests in the sandbox, and approves.
  - None of them may delete a Space or namespace, change a workflow, or
    manage workers or logins.
  - Only Milton may approve.
- **Output:** written to `$CHAOS_RUNS/<run-name>/`: the full event stream
  (`.jsonl`), a readable transcript (`.md`), and the prompt in `runs.log`.

The agents' standing instructions are `agents/devil.md`, `agents/angel.md` and
`agents/milton.md`. Each run writes a note before every command, saying what
it sees and why it acts, so the transcripts can be read as a record.

**With your own AI.** The agents run on Claude Code. [agents/README.md](agents/README.md)
is the contract any runtime has to meet, and the changes to swap Claude Code
out.

**If a step goes wrong.** Read the run's transcript (`.md`), fix the cause, and
run the step again. Milton reviews every request in the run, the failed ones
too. To give it only the latest, set it yourself:
`REQUEST="$(bash $DEMO/agents/last-request.sh <run-name> angel)" bash $DEMO/approve.sh milton ...`.
Sveltos's tokens to the workload clusters last 30 days. For a fleet older than
that, `node $DEMO/setup/kind-fleet.mjs --refresh` renews them.

**Check the kit itself.** `bash demo/verify.sh` checks offline that every
script parses, every prompt is used by a step, and every `${VARIABLE}` is
explained where it is used. After onboarding, `bash $DEMO/proof/parity-gate-check.sh`
checks outage 3's prevention against your ConfigHub without any agent. It takes
off again any gate it puts on, so outage 3 can still be staged: see
[PROOF.md](PROOF.md). The plugin's own tests are `go test ./...` at the
repository root.

## Tear it down

```bash
bash $DEMO/teardown.sh               # the kind clusters, the reporter, and the files in $AI_CHAOS_DIR other than your runs
bash $DEMO/teardown.sh --confighub   # and every chaos-* Space, the components and the agents' contexts, after listing them and asking
```

Run `bash $DEMO/proof/evidence.sh > evidence.txt` first, to keep ConfigHub's
record. Deleting the Spaces deletes it.

## What we learned running it

- **Give each agent nothing but its task.** Our first run started inside the
  repository, and the agent read private notes. Runs now start from an empty
  directory, with no connectors.
- **An agent reads whatever a command prints.** One `--debug` printed a
  worker's token into a transcript. The agents' instructions now forbid it.
- **Name the sandbox every time.** One preview, run without a sandbox, put its
  policy on the management cluster, and Sveltos was refused its own writes.
  `cub sveltos impact` and `check` now refuse a cluster that runs workloads,
  and refuse to run with no sandbox named.
- **"Unknown" from a preview means: check another way.** In outage 2 the review
  found Angel had exempted the wrong identity. Read the identity Sveltos really
  uses (`proof/token-subject.sh`), and test the policy by impersonation.
- **Diff each Space before approving.** A change order can carry an edit made
  before it was opened.
- **Only the approver changes a gate.** A workflow is edited in place, so
  create the workflows yourself (`setup/gates.sh`), and don't let the agents
  change them.
- **Grant before you ask anyone to approve.** An approver needs ApproveChildren
  (a Space has no Approve permission) and UseChildren, because approving a
  change order needs Use on it. Opening a change order needs View and Use on
  the component. `setup/grant-agents.sh` grants all of these.
- **Keep the sandbox empty.** Apply only admission policies there; dry-run
  everything else. `setup/sandbox.sh --reset` empties it.
- **Never edit a script while a run is using it.** Bash reads a script as it
  goes. One edit mid-run lost an agent's transcript.
- **Design a fault to fail after the rollout.** The health check reports a
  rollout that never finishes as Progressing, not Degraded.
