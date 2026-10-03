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
the web UI. [recording/](recording/README.md) has our two runs:
- the first, with a person approving, and every transcript;
- [the verification run](recording/verification-2026-10-03.md), made from this
  README with Milton approving everything. There Milton refused the change
  behind outage 3.

## Versions

Tested together on 2026-10-03:

| Product | Version |
| --- | --- |
| ConfigHub (hub.confighub.com) | server v0.8.1 |
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
  and 48 GB.
- **A ConfigHub organization** with 20 free Spaces, and a user who may create
  Spaces, workers and components there.
- **Claude Code**, signed in. The agents' runs cost about $30 to $50 in all,
  and the whole demo takes two to three hours.
- **The plugins:**

  ```bash
  cub plugin install confighub/sveltos-confighub@v0.13.0
  cub plugin install confighub/cub-helm
  ```

## Set it up

```bash
git clone https://github.com/confighub/sveltos-confighub && cd sveltos-confighub
source demo/env.sh                          # in every terminal you use
node $DEMO/setup/kind-fleet.mjs             # chaos-mgmt and four workload clusters, Sveltos v1.15.0
source demo/env.sh                          # again, now that the clusters exist
bash $DEMO/setup/sandbox.sh                 # the policy sandbox: a kind cluster with Sveltos's CRDs and nothing running
bash $DEMO/setup/setup-shop.sh              # the shop and Reloader, delivered by plain Sveltos
bash $DEMO/setup/identities.sh              # devil, angel, reporter, milton; writes your user ID and Milton's
source demo/env.sh                          # again, to load the user IDs
```

Then onboard the fleet into ConfigHub, with Angel doing the work and you or
Milton approving: [scenarios/00-onboard.md](scenarios/00-onboard.md). Onboarding ends by
granting the agents their permissions, gating the workflows, and starting live
status.

`$DEMO` is the demo directory. `$AI_CHAOS_DIR` (default `~/ai-chaos`) holds
the kubeconfigs, the onboarding output and the agents' runs.

## Approvals: by hand or by Milton

Every release waits for one approval, from you or Milton, and never from the
change's author. Each approval step offers both:

```bash
bash $DEMO/approve.sh me     chaos-shop-base/<order> staging "<why, in your words>"
bash $DEMO/approve.sh milton chaos-shop-base/<order> staging <run-name>
```

`me` records your approval with your note. `milton` has Milton review the
order against what the requester wrote in that run:
- the change order;
- every Space's diff, head against last release;
- the evidence the request cites.

It then approves with a note saying what it checked, or says why not. To allow
only one of you, set `APPROVERS=$YOU_ID` or `APPROVERS=$MILTON_ID` before
running `setup/gates.sh` and `setup/onboard.sh`.

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
Set them on the command line, for example `FIX_ORDER=<order> bash ...`. Each
agent's report names its change orders, and so does `cub changeorder list
--space <base space>`.

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

## Clean up

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
  goes. One edit mid-run truncated an agent's transcript.
- **Design a fault to fail after the rollout.** The health check reports a
  rollout that never finishes as Progressing, not Degraded.
