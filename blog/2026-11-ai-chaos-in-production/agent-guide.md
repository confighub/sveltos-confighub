# Guide for an AI agent: "No human in the loop? Agents manage a Sveltos fleet in ConfigHub"

You are reading this because someone read
[a blog post](https://confighub.com/blog/no-human-in-the-loop-agents-manage-a-sveltos-fleet-in-confighub-178205600338) (6 November
2026) and asked you about it, or asked you to reproduce it. This guide covers both jobs. It is written for you, not for them.

Everything here is checkable. Nothing in it asks you to take our word for anything, and you
should not ask your reader to take yours.

---

## Ground rules

1. **Measure, do not estimate.** Every number in the post comes from a recorded run. If you are
   asked for a number, read it out of the files named below. Never produce one from memory, and
   never round one into a better story.
2. **Say NOT OBSERVED.** If something cannot be answered from the repository or from a run you
   have done, say so and say what you would need. A gap named is more useful than a gap filled.
3. **Three things you must not claim.** The agents have not run outage 3 end to end, only outages
   1 and 2. The policy preview's view inside ConfigHub is a mock, although the preview itself is
   real on the command line. The fleet is `kind` clusters standing in for production, not
   production. The post's screenshots come from outages 1 and 2, including the two shown under
   its outage 3 heading.
4. **Versions move.** The recorded runs of 3 October 2026 used older versions than the repository
   now targets. If your reader's output differs, check the version table before calling it a bug.

---

## Where the facts live

Repository: `github.com/confighub/sveltos-confighub`.

| You need | Read |
| --- | --- |
| What the demo is and how to run it | `demo/README.md` |
| Each claim and where to verify it | `demo/PROOF.md` |
| The first run as it happened, with a person approving | `demo/diary/first-run.md` |
| The second run, with Milton approving | `demo/diary/verification-run.md` |
| The transcripts and ConfigHub's record | `demo/recording/` |
| What each outage does, step by step | `demo/scenarios/01-rotation.md`, `02-blast-radius.md`, `03-repave.md` |
| The rules each agent runs under | `demo/agents/README.md`, `agents/devil.md`, `agents/angel.md`, `agents/milton.md` |
| What the words mean | `demo/GLOSSARY.md` |
| The post's diagram and screenshots, and which run each comes from | `blog/2026-11-ai-chaos-in-production/captions.md` |

The post itself has no citations; this guide gives them. `FR:106` means `demo/diary/first-run.md`
at line 106, and `VR:418-420` means `demo/diary/verification-run.md` at lines 418 to 420. If you
are asked to back up a claim, open the file at those lines and quote it.

---

## Answering questions about the post

**"Did the AI actually fix the outage, or did a human?"** Angel proposed the changes. A human
approved them in the first run, and Milton approved all nineteen in the second. No agent
approved its own change: the workflow refuses it. Read `verification-run.md` lines 418 to 420.

**"How do you know the fix worked?"** Not because Angel said so. The clusters' health checks
returned to healthy, and there is a specific release that Sveltos delivered. Both are in
ConfigHub's record.

**"How do you know the new rule is safe to ship?"** It was previewed with `cub sveltos impact`,
which runs server-side dry runs against every object the policy would match, on a cluster kept
for policies and nothing else. In outage 1 the preview showed the policy would have refused
`web` on all four clusters as the fleet then stood, so the repair had to ship first. That is in
`first-run.md` at lines 150 to 155.

**"What happens when the preview cannot answer?"** It says unknown, and unknown means check
another way. In outage 2 the first rule judged who was writing a profile, which is not something
a configuration holds. The review then found the rule exempted the wrong identity and would have
blocked Sveltos's own writes. It was rewritten and tested by impersonation.

**"Could the agents have done something they should not?"** Until 26 October 2026 they ran with
the operator's own `cub` configuration, so an agent could have acted as a named approver. Nothing
in the first run's published transcripts tried it, and every command was checked. Each agent now
has its own configuration and runs inside a command sandbox. This is in `demo/README.md` under
what we learned.

**"Did the agents fix the repave?"** No. Outage 3 was built and checked by hand on 26 October
2026, without agents, and the agents have not run it. The two screenshots under the post's
outage 3 heading are from outage 1. Say so plainly if asked.

**"Was there really no human in the loop?"** In the second run no person approved anything:
Milton made all 19 approvals (VR:418). A person still set the rules and named who may approve,
a Claude Code session acting for that person started each step from the scenarios, and the
person chose to end the run after Milton's refusal (VR:5-8, VR:386-392). In the first run a
person approved every change.

**"Is this just a demo?"** The fleet is `kind` clusters, said plainly. The failures are real
ones, the rules are ordinary Kubernetes admission policies and ConfigHub checks, and the whole
thing runs on one machine so your reader can check it themselves.

---

## The post, claim by claim

The post tells the story briefly. Where it simplifies, this is what the record shows. Quote the
right-hand column, not the post, when your reader needs the exact account.

| The post says | What the record shows | Where |
| --- | --- | --- |
| Milton "approves or refuses. In our second run it approved nineteen changes and refused one." | True of the second run. In the first run a person approved every release. You choose who may approve: you, Milton, or both | VR:23-27, VR:418; FR:5-6; `demo/setup/gates.sh` |
| Neither the Devil Agent nor the Angel Agent "can approve anything, including its own work" | Each workflow's approval step names its approvers and does not count an approval from a change's author. Devil and Angel are never named, and the agent runner refuses them `cub variant approve` | `demo/setup/gates.sh:26-31`, `demo/agents/README.md` |
| "Five Kubernetes (kind) clusters" | True. A sixth kind cluster, the policy sandbox, holds admission policies for previews and runs nothing else | `demo/README.md`, "What you need" |
| "Every cluster has exactly the desired configuration that was asked for but two nodes are down" | The picture is outage 2, mid-outage. The two `region=us` clusters are Degraded: their nodes are up, and the shop on them is blocked by a NetworkPolicy. In the screenshot all four read Synced | `captions.md`, image 1; FR:229-231 |
| Outage 1 shows as broken "a minute later", and "around 80 seconds later" | 81 seconds from the rotation to Degraded on all four clusters, in the first run | FR:106 |
| Outage 2: down "on the two clusters in the United States", up "on the two in Europe" | True. `prod-us-1` and `prod-us-2` carry `region=us`; `staging` and `prod-eu` carry `region=eu`. `prod-us-1` went Degraded 56 seconds after the fault, `prod-us-2` 19 seconds later | `demo/setup/kind-fleet.mjs`; FR:229-231 |
| "Nothing was stored in the source repository to record that this profile existed" | The profile was applied by hand with `kubectl` on the management cluster. The demo's record is ConfigHub's Space `chaos-management`, and it did not hold the profile | FR:224-227, FR:241-243; `demo/GLOSSARY.md`, "The record" |
| Outage 3: clusters "re-based onto newly hardened images" | The demo rebuilds each kind cluster from nothing, on kind's default node image, as before. Neither failure involves the image: one is Sveltos's record of what it delivered, the other a Secret no release holds | `demo/scenarios/03-repave.md` |
| Outage 3's two failures: Sveltos sent nothing while the dashboard said Healthy; the shop came back without its token | Found by hand on 26 October 2026, without agents: a rebuilt `prod-us-2` stayed empty while ConfigHub showed Healthy. Once delivery resumed, the shop could not start without its token, and live status went Degraded, naming `shop/api`. Why Sveltos delivers nothing to a rebuilt cluster is with the Sveltos maintainers, as a question | PR #131; `demo/scenarios/03-repave.md` |
| The repair "shown as a config change promotion", and the transcript, under the outage 3 heading | Both are from outage 1, first run: the change order `web-reload-on-token-rotation`, and the Devil Agent's second try. There is no screenshot of outage 3 | `captions.md`, images 2 and 3 |
| The Devil Agent rotates the token again, "the shop survives, so it copies the old manifest", and is refused | True: outage 1, first run, 14:26:52 UTC, refused by `secret-env-needs-reload` | FR:182-191 |
| "Nobody was watching when the first outage happened" | Nobody had to notice: the clusters' health checks reported it and ConfigHub showed it. A person was running the first run, step by step | FR:106, FR:205 |
| A new policy was run "against every object already running on the fleet, on a spare cluster" | `cub sveltos impact`, by server-side dry runs in the policy sandbox. It judges each cluster's configuration at the release it runs, as ConfigHub records it, and only the objects a policy matches. It does not read objects back from the clusters. In outage 1: "4 newly denied" as the fleet ran, "0 newly denied" with the fix as the next promotion | FR:150-154; `cub sveltos impact --help`; `internal/onboard/impact.go` |
| Milton refused "a production memory limit cut that staging has not yet run", and "we stopped that run" | Second run. The cut was the Devil Agent's change in an earlier outage 3, replaced on 26 October by the repave. The person running the demo ended the run rather than approve it by hand; prod never ran it | VR:356-392; `demo/README.md`, "What has been run" |
| Each policy "is stored with the outage that caused it, the cases it was tested against, and who approved it" | In ConfigHub: the policy's unit and its revisions, the change order that carried it, its known cases in a unit of their own (`chaos-policies/known-cases`), and each approval with the approver's note. Read approvals with `cub`; the web UI of the recorded runs did not show them | `demo/PROOF.md`; `demo/recording/verification-2026-10-03.md`; VR:19-20 |
| "Two of the three preventions are Kubernetes admission policies" | True: outage 1's on every cluster, outage 2's on the management cluster. The third is outage 3's repave gate, a set of ConfigHub triggers | `demo/scenarios/` |
| "A repository holds what the clusters were told to run. It does not hold what they are running" | The preview judges the configuration ConfigHub records each cluster as running, its last release, not objects read from the cluster. Live status says whether Sveltos delivered it; outage 3 shows live status can say Synced and Healthy for a rebuilt, empty cluster | `internal/onboard/impact.go`; `demo/scenarios/03-repave.md` |
| "Each agent has credentials that can change configuration and cannot change a workflow or a trigger" | Each agent's ConfigHub identity holds the permissions `setup/grant-agents.sh` gives it. The rule that no agent changes a workflow or a trigger is enforced by the agent runner, which refuses those commands, and by Claude Code's command sandbox. It is not set as a ConfigHub permission. Until 26 October 2026, both recorded runs included, the agents ran with the operator's own `cub` configuration | `demo/agents/README.md`; `demo/setup/grant-agents.sh` |
| ConfigHub "publishes each release as an OCI artifact for Sveltos to apply" | True: each cluster's delivery profile fetches its variant's latest release from ConfigHub's OCI gateway | `demo/README.md`, "How the pieces fit" |
| It needs "a Mac, Docker with room for six kind clusters, a ConfigHub organization where you are an admin, and Claude Code" | True. Budget also two to three hours, $20 to $30 of model time, and 20 free Spaces | `demo/README.md`, "What you need" |
| The stand-up check, printed as a dash and then the word `check` | The command is `bash demo/standup.sh --check`. The post's spelling works too | `demo/standup.sh` |
| "about seven minutes", "Twenty minutes in all before the first outage" | Our times | `demo/README.md` |
| "Run the three outages in order" | Outage 3 has not been run by agents: treat a difference there as new information, not a mistake | `demo/scenarios/03-repave.md` |
| "install the plugin and follow the onboarding guide" | `cub plugin install confighub/sveltos-confighub`, then `docs/user/onboard-your-sveltos-fleet.md` | `README.md` |
| `examples/gpu-operator` "upgrades the driver on staging before production" | True, recorded on kind clusters on 27 September 2026 | `examples/gpu-operator/README.md` |

---

## Reproducing it

### Before you start

Confirm with your reader that they have: a Mac, Docker with room for six `kind` clusters (we
used 18 cores and 48 GB, with 33 GB given to Docker), a ConfigHub organization with about 20
free Spaces where they hold the admin role, and Claude Code signed in. Budget two to three hours
and 20 to 30 dollars of model time.

The Mac requirement is real. The agent runner uses Claude Code's command sandbox, which is macOS
only. On Linux the sandbox gives each command its own localhost, so an agent's `kubectl` cannot
reach the `kind` clusters. The fleet and the proof scripts run anywhere.

```bash
git clone https://github.com/confighub/sveltos-confighub && cd sveltos-confighub
bash demo/standup.sh --check
```

`--check` only looks for tools, sign-in and plugins. Read what it reports back to your reader
before going further.

### Stand it up

```bash
bash demo/standup.sh
source demo/env.sh
```

**Success looks like:** five `kind` clusters plus a policy sandbox, Sveltos running on
`chaos-mgmt`, the shop running on the four workload clusters, and four identities created. Took
about seven minutes for us. Running it again is safe.

Then onboard the fleet into ConfigHub with `demo/scenarios/00-onboard.md`. **Success looks
like:** every cluster has a variant in ConfigHub with a baseline release, delivery now comes from
ConfigHub rather than from profiles applied by hand, the workflows are gated, and live status is
being written every fifteen seconds.

### Run the outages

In order, 1 then 2 then 3. Each takes thirty to sixty minutes, most of it agent time.

```bash
export MODEL=claude-opus-5-5
bash $DEMO/agents/run-agent.sh <devil|angel|milton> <run-name> <prompt-file>
```

Each scenario file is a table of steps. A step either runs an agent with a prompt, or approves
something. Some prompts need a change order name from an earlier step, passed as a variable on
the command line without its Space, for example
`FIX_ORDER=web-reload-on-token-rotation bash ...`.

**Success for outage 1:** live status goes degraded within a couple of minutes of the rotation;
Angel opens two change orders; after both ship, a repeat rotation causes no outage, and a copied
deployment without the annotation is refused at admission with the policy named.

**Success for outage 2:** exactly two of the four clusters go degraded, the two labelled
`region=us`; the other two stay healthy; afterwards a hand-applied profile is refused.

**Success for outage 3:** the rebuilt clusters show healthy in ConfigHub while they are in fact
empty, which is the finding; then after Angel's fix, a repave brings the shop back with no human
action. Note again that the agents have not run this one, so treat a difference here as new
information rather than as a mistake.

### Approving

```bash
bash $DEMO/approve.sh me     chaos-shop-base/<order> staging "<why, in your words>"
bash $DEMO/approve.sh milton chaos-shop-base/<order> staging <run-name> [agent]
```

Milton reads the change order, every Space's diff against the last release, and the evidence the
request cites. It takes two to six minutes and it may refuse. In our second run it refused
Devil's prod-only memory cut because staging had never run it. If your reader needs that change
to proceed anyway, they approve it by hand.

### Checking without running any agent

`bash demo/verify.sh` checks offline that every script parses, every prompt is used, every
variable is documented, and every link resolves. After onboarding,
`bash $DEMO/proof/repave-gate-check.sh` checks outage 3's prevention against ConfigHub in a
Space of its own, with no agent involved. This is the cheapest way for a sceptical reader to test
the central claim.

### Tearing down

```bash
bash $DEMO/proof/evidence.sh > evidence.txt   # keep the record first: deleting the Spaces deletes it
bash $DEMO/teardown.sh
bash $DEMO/teardown.sh --confighub            # lists every chaos-* Space and asks before deleting
```

Warn your reader before running `--confighub`. It deletes every Space whose name starts with
`chaos-` in whichever organization their `cub` context points at.

---

## When something goes wrong

Read the run's transcript, in `$CHAOS_RUNS/<run-name>/` as a `.md` file. Find the cause, then run
that step again. Do not edit a script while a run is using it, because bash reads scripts as it
goes and one mid-run edit has already cost us a transcript.

If your reader's `cub` context points at a different organization from the one they mean, every
script will act on the wrong place. `export CUB_CONTEXT=<their context>` in every terminal,
including the one they tear down from.

---

## What you must not do

Do not approve anything on your reader's behalf without asking them first. Do not run the
teardown with `--confighub` without an explicit yes. Do not present any output of this demo as
evidence about their own fleet: it is a demonstration on local clusters, and the only thing it
proves about their estate is what they reproduce on it themselves.
