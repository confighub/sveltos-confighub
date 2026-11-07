# No human in the loop? Agents manage a Sveltos fleet in ConfigHub

**Post:** [on the ConfigHub blog](https://confighub.com/blog/no-human-in-the-loop-agents-manage-a-sveltos-fleet-in-confighub-178205600338),
published 6 November 2026.
**Demo:** [`demo/`](../../demo/README.md) in this repository. Everything in the post can be run.

Three outages on a Kubernetes fleet, caused on purpose by one AI agent and repaired by another.
Each repair comes in two parts: a fix for what broke, and a policy that stops it happening
again. Nothing takes effect until somebody who did not write it approves: a person, or a third
agent, Milton.

Sveltos and ConfigHub do three jobs here at once: **fleets**, **compliance** and **agentic
operations**. Sveltos delivers each cluster's configuration and reports its health. ConfigHub
holds the configuration, the policies, and the record of every change and approval.

**The workloads** are a small web application, `api` and `web`, plus one platform component.
Nothing depends on the workload being an application: the same pattern carries platform
components and GPU stacks, as
[`examples/gpu-operator`](../../examples/gpu-operator/README.md) shows.

**Outage 3 is a repaving example.** The prod clusters are rebuilt from nothing overnight, which
is the repave of the three Rs. Everything should come back from the source of truth. Two things
do not. The first is silent: ConfigHub says Healthy while prod is empty.

## What has been run

| | Run by | When | Approved by |
| --- | --- | --- | --- |
| Onboarding, outages 1 and 2 | The agents, end to end | 3 October 2026, first run | A person |
| The same again | The agents, end to end | 3 October 2026, second run | Milton: all 19 approvals, and one refusal |
| Outage 3, the nightly repave | By hand, piece by piece, without agents | 26 October 2026 | Not part of the hand checks |

The agents have not run outage 3. The screenshots in the post come from outages 1 and 2:
[`captions.md`](captions.md) says which. Milton's refusal was of a change in an earlier outage 3,
which the repave replaced on 26 October.

## What is in this folder

| File | What it is |
| --- | --- |
| [`intro.md`](intro.md) | The whole story at a walking pace, for a reader who has read nothing else of ours |
| [`agent-guide.md`](agent-guide.md) | For a reader's own AI agent: how to answer questions about the post, and how to reproduce it. It takes the post claim by claim |
| [`captions.md`](captions.md) | The post's diagram and three screenshots, where each comes from, and what to notice |
| [`diagram.svg`](diagram.svg), [`diagram.png`](diagram.png) | The diagram at the top of the post |

![No human in the loop: Devil Agent breaks something, Sveltos sees it break, Angel Agent proposes a fix and a policy, Milton approves or refuses, ConfigHub releases it to the fleet](diagram.png)

## Where to start

Read [`intro.md`](intro.md). To run it, go to [`demo/README.md`](../../demo/README.md). The
words are in [`demo/GLOSSARY.md`](../../demo/GLOSSARY.md).
