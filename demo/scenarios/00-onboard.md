# Onboarding: the fleet into ConfigHub

Angel onboards the running fleet with `cub sveltos`:
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

Approve staging for both, by hand or by Milton:

```bash
bash $DEMO/approve.sh me chaos-shop-base/onboard-<id> staging "first release of the shop to staging"
bash $DEMO/approve.sh me chaos-platform-base/onboard-<id> staging "first release of the platform to staging"
# or
export REQUEST="Onboarding: the first release of this component, from the profiles Sveltos runs today. Nothing should change on the clusters."
bash $DEMO/approve.sh milton chaos-shop-base/onboard-<id> staging 00-onboard
bash $DEMO/approve.sh milton chaos-platform-base/onboard-<id> staging 00-onboard
unset REQUEST
```

Then run `onboard.sh` again: it releases staging and stops at prod. Approve
prod the same way, with `prod` in place of `staging`, and run `onboard.sh` once
more. Then hand delivery over from the profiles you applied to ConfigHub's
releases. Nothing is reinstalled; the pods keep running.

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
