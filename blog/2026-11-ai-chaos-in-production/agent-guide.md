# Guide for an AI agent: "AI chaos in production"

You are reading this because someone read a blog post and asked you about it, or asked you to
reproduce it. This guide covers both jobs. It is written for you, not for them.

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
   production.
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
| What the words mean | the glossary in `demo/README.md` |

Citations in the post look like `(FR:89-110)` and `(VR:418-420)`. FR is `diary/first-run.md`,
VR is `diary/verification-run.md`, and the numbers are line ranges. If you are asked to back up
a claim, open the file at those lines and quote it.

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

**"Is this just a demo?"** The fleet is `kind` clusters, said plainly. The failures are real
ones, the rules are ordinary Kubernetes admission policies and ConfigHub checks, and the whole
thing runs on one machine so your reader can check it themselves.

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
