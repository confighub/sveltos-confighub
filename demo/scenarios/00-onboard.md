# Onboarding: the fleet into ConfigHub

[The demo](../README.md) · Onboarding · next: [Outage 1](01-rotation.md)

`setup/onboard.sh` onboards the running fleet with `cub sveltos`, signed in as
Angel. It is a script, not the AI agent.
It creates:
- **The shop and the platform:** one variant per cluster each, cloned from a
  class base (staging or prod), cloned from a base.
- **The management cluster's record:** its delivery profiles, delivered from
  ConfigHub.
- **Health:** continuous health checks on every cluster.

The first releases are what the clusters already run: each variant's first
release is its onboarding baseline, and the handover publishes the record's
first release. Every release after those waits for an approval from you or
Milton.

```bash
source demo/env.sh
bash $DEMO/setup/onboard.sh
```

It runs `cub sveltos apply`, which writes `apply.sh`, then runs `apply.sh`.
`apply.sh`'s first step reports that facts could not be collected from the management cluster
(`mgmt/mgmt: not collected`). That is expected on kind, where the cluster's
in-cluster address isn't reachable from your machine, and nothing depends on
it.

**Why a baseline.** ConfigHub refuses a variant's first release through the
onboarding change order: the order counts a variant just cloned from its base
as released already ([confighubai/confighub#5794](https://github.com/confighubai/confighub/issues/5794),
open). `apply.sh` names each variant it refused. `onboard.sh` then publishes
each one's first release at head, annotated
`sveltos.confighub.com/first-release=baseline`, and runs `apply.sh` once more,
which ends with:

```
platform: every variant in this plan is released
shop: every variant in this plan is released
```

A baseline skips the approval for that one release. What it releases is what
the cluster already runs: what the profiles you applied hold. See it with
`cub release list --space chaos-shop-staging`.

Then hand delivery over from the profiles you applied to ConfigHub's releases.
Nothing is reinstalled; the pods keep running.

```bash
bash $DEMO/setup/onboard.sh --handover
```

It checks that your profiles still hold what was onboarded, and that for each
chart ConfigHub releases what Helm installed on the cluster. Then it steps your
profiles aside and applies the delivery profiles. Each reports Provisioned
within a minute: `kubectl --context kind-chaos-mgmt get clustersummaries -A`.

Then the agents' permissions, the gates and live status:

```bash
bash $DEMO/setup/grant-agents.sh     # Devil, the reporter and Milton on every chaos-* Space
bash $DEMO/setup/gates.sh            # rollouts required; the record gated
bash $DEMO/setup/reporter.sh start   # live status into ConfigHub every 15 s
```

Check: `cub sveltos status --kube-context kind-chaos-mgmt` shows every Space
Synced and Healthy. In the web UI, Components shows the base, two class
bases and four deployments for `chaos-shop` (the UI's name for a variant), each Live and Synced (see
[PROOF.md](../PROOF.md)).

Next: [Outage 1, a rotation nobody picked up](01-rotation.md). Back to [the demo](../README.md).
