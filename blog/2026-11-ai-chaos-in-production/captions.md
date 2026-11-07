# The post's images

The post has four images: the diagram, then three screenshots. This page takes them in the
post's order, says where each comes from, and what it shows. The screenshots are real captures
from the first recorded run, 3 October 2026. They are copied into [`images/`](images/) so this
pack is self-contained: the folder can be handed to anyone and nothing it needs sits outside
it. The originals stay in [`demo/diary/images/`](../../demo/diary/images/), where the run that
produced them keeps them.

The screenshots come from the agents' runs of outages 1 and 2. Outage 3 was run by hand, on
26 October 2026.

## The diagram

![No human in the loop: Devil Agent breaks something, Sveltos sees it break, Angel Agent proposes a fix and a policy, Milton approves or refuses, ConfigHub releases it to the fleet](diagram.png)

[`diagram.png`](diagram.png), with its source [`diagram.svg`](diagram.svg). In the post, under
"How the AI works".

The loop the demo runs for each outage. Three of its lines, and what stands behind them:

- **"Milton: approves, or refuses."** In the second run Milton made all 19 approvals and
  refused one change ([diary](../../demo/diary/verification-run.md), lines 23 to 27). In the
  first run a person approved. The demo lets you name who may approve: you, Milton, or both
  (`demo/setup/gates.sh`).
- **"Same fault, tried again. Refused."** In outage 2 the Devil Agent applied the same lockdown
  again, and it was refused. In outage 1 the repeat rotation did no harm, because Reloader
  picked it up, and the Devil Agent's next attempt, the old manifest copied into a new
  Deployment, was refused (screenshot 3).
- **"A person writes the rules once, and names who may approve. The agents cannot change
  them."** The person creates the workflows (`demo/setup/gates.sh`) and outage 3's repave gate
  (`demo/setup/repave-gate.sh`). What keeps the agents from changing them is the agent runner,
  which refuses any agent a command that changes a workflow or a trigger, and Claude Code's
  command sandbox, which keeps each agent from every credential but its own
  ([`demo/agents/README.md`](../../demo/agents/README.md)). Until 26 October 2026 the agents
  ran with the operator's own `cub` configuration; [`agent-guide.md`](agent-guide.md) says
  what that meant.

## 1. Half the fleet, and the fleet knows which half

![Half the fleet degraded](images/01-half-the-fleet-degraded.jpg)

`images/01-half-the-fleet-degraded.jpg`, from `demo/diary/images/r1-21-outage2-half-degraded.jpg`.
In the post, under "The fleet".

ConfigHub's component graph during outage 2. `prod-eu` and `staging` are Live. `prod-us-1` and
`prod-us-2` are Degraded. All four read Synced, at the same release.

What to notice: every cluster has exactly the configuration that was asked for, and two of them
are down. The two that broke are the two labelled `region=us`, which is what the hand-applied
profile selected. Their nodes are up: what is down is the shop on them, blocked by the
NetworkPolicy that profile delivered.

## 2. The fix, waiting

![The fix waiting at the gate](images/02-fix-waiting-at-the-gate.jpg)

`images/02-fix-waiting-at-the-gate.jpg`, from `demo/diary/images/r1-12-outage1-fix-waiting.jpg`.
In the post, under "When a repave goes wrong".

The change order `web-reload-on-token-rotation`, opened by the Angel Agent in outage 1. The
promotion path reads source, bases, staging, prod, with prod gated. The whole change is two
annotations. The post shows it as an example of how an agent's repair travels; it is outage 1's
repair, not a repave's.

What to notice: an agent's repair is a named change with two fields in it, moving through the
same stages as any other change, and stopped at a gate. The header still reads Degraded, because
nothing has shipped yet.

## 3. Refused, in the Devil Agent's own words

![Refused, in the Devil Agent's own words](images/03-refused-in-devils-own-words.png)

`images/03-refused-in-devils-own-words.png`, from `demo/diary/images/r1-o1-again.png`.
In the post, under "When a repave goes wrong", and described under "What we learnt".

The Devil Agent's transcript from outage 1, labelled "AI generated, as it ran". It rotates the
token a second time and the shop survives. It then copies the old manifest into a new
Deployment, and the cluster refuses it: `ValidatingAdmissionPolicy 'secret-env-needs-reload' ...
denied request`. The commands here are `kubectl`, run against the staging cluster; the policy
that refuses them reached the cluster through ConfigHub. The agents' `cub` commands are in the
other transcripts, in [`demo/recording/runs/`](../../demo/recording/runs/).

What to notice: the prevention is reported by the thing that tried to get past it.

## Notes

- The images from the retired outage 3, the prod-only memory cut, are not used. That outage was
  replaced by the nightly repave on 26 October 2026.
- No screenshot of the policy preview is used. The preview runs on the command line; its view
  inside ConfigHub is still a mock.
- Run 1 was on ConfigHub v0.8.1. These images show what they claim, and a reader opening their
  own ConfigHub today will not see an identical screen.
