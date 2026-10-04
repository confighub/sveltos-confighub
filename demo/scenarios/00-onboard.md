# Onboarding: the fleet into ConfigHub

`setup/onboard.sh` onboards the running fleet with `cub sveltos`, signed in as
Angel. It is a script, not the AI agent. The only agent here is Milton, if it
approves for you.
It creates:
- **The shop and the platform:** one variant per cluster each, cloned from a
  class base (staging or prod), cloned from a base.
- **The management cluster's record:** its delivery profiles, delivered from
  ConfigHub.
- **Health:** continuous health checks on every cluster.

Every release waits for an approval from you or Milton.

```bash
source demo/env.sh
bash $DEMO/setup/onboard.sh
```

It runs `cub sveltos apply`, which writes `apply.sh`, then runs `apply.sh`, and
stops at the first approval.
Step 1 reports that facts could not be collected from the management cluster
(`mgmt/mgmt: not collected`). That is expected on kind, where the cluster's
in-cluster address isn't reachable from your machine, and nothing depends on
it.

It stops at staging. Give Devil, the reporter and Milton their permissions on
the Spaces Angel just created; Milton cannot review what it cannot read:

```bash
bash $DEMO/setup/grant-agents.sh
```

`onboard.sh` names two change orders, one per component: `chaos-shop-base/onboard-<id>` and
`chaos-platform-base/onboard-<id>`. See them with:

```bash
cub changeorder list --space chaos-shop-base
cub changeorder list --space chaos-platform-base
```

Approve staging for both, by hand or by Milton. There is no agent request in
onboarding, so Milton is given one in `REQUEST`:

```bash
bash $DEMO/approve.sh me chaos-shop-base/onboard-<id> staging "first release of the shop to staging"
bash $DEMO/approve.sh me chaos-platform-base/onboard-<id> staging "first release of the platform to staging"
# or
export REQUEST="Onboarding: the first release of this component to staging, made from the Sveltos profiles the fleet runs today. Nothing should change on the clusters."
bash $DEMO/approve.sh milton chaos-shop-base/onboard-<id> staging 00-onboard
bash $DEMO/approve.sh milton chaos-platform-base/onboard-<id> staging 00-onboard
```

Each Milton review takes two to four minutes and ends with "Approved", or
"Not approved" and why. Then run `onboard.sh` again: it releases staging and
stops at prod.

```bash
bash $DEMO/setup/onboard.sh
```

Approve prod for both:

```bash
bash $DEMO/approve.sh me chaos-shop-base/onboard-<id> prod "first release of the shop to prod; staging ran it"
bash $DEMO/approve.sh me chaos-platform-base/onboard-<id> prod "first release of the platform to prod; staging ran it"
# or
export REQUEST="Onboarding: the first release of this component to prod, made from the Sveltos profiles the fleet runs today; staging has run it. Nothing should change on the clusters."
bash $DEMO/approve.sh milton chaos-shop-base/onboard-<id> prod 00-onboard
bash $DEMO/approve.sh milton chaos-platform-base/onboard-<id> prod 00-onboard
unset REQUEST
```

Run `onboard.sh` once more: it releases prod. Then hand delivery over from the
profiles you applied to ConfigHub's releases. Nothing is reinstalled; the pods
keep running.

```bash
bash $DEMO/setup/onboard.sh
```

```bash
bash $DEMO/setup/onboard.sh --handover
```

Then the permissions again (the handover adds Spaces), the gates and live
status:

```bash
bash $DEMO/setup/grant-agents.sh     # Devil, the reporter and Milton on every chaos-* Space
bash $DEMO/setup/gates.sh            # rollouts required; the record gated
bash $DEMO/setup/reporter.sh start   # live status into ConfigHub every 15 s
```

Check: `cub sveltos status --context kind-chaos-mgmt` shows every Space
Synced and Healthy. In the web UI, Components shows the base, two class
bases and four deployments for `chaos-shop`, each Live and Synced (see
[PROOF.md](../PROOF.md)).
