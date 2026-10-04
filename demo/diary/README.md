# Diaries of the two runs

## The demo

"AI chaos in production" puts a Sveltos fleet under ConfigHub. AI agents then
break it, fix it, and stop the same failure from coming back. Kind clusters
stand in for production:
- a management cluster, where Sveltos runs;
- four workload clusters running a small shop: `staging`, `prod-eu`,
  `prod-us-1` and `prod-us-2`.

Sveltos delivers what each cluster runs. ConfigHub holds that configuration,
one variant per cluster. A change reaches a cluster only as a release, through
a workflow that needs a named approval and never the author's own.

Three agents work in the fleet, each with its own ConfigHub identity:
- **Devil** causes each outage, the way it happens in real life.
- **Angel** finds the cause, fixes it through ConfigHub, and proposes a policy
  that stops it happening again.
- **Milton** reviews each request and approves or refuses it. A person can
  approve instead.

| Outage | What breaks | What prevents it |
| --- | --- | --- |
| 1. A rotation nobody picked up | A Secret rotated outside ConfigHub; `web` keeps the old token on every cluster | An admission policy: a workload that takes a Secret from its environment must say how it picks up a rotation |
| 2. Half the fleet at once | A ClusterProfile applied by hand on the management cluster blocks the shop on the two `region=us` clusters | An admission policy on the management cluster: profiles come only from ConfigHub's record |
| 3. Staging said yes, prod said no | A prod-only memory limit, then a cache that passes staging, so prod is OOMKilled | Prod's release requires a parity check against staging; differences must be declared |

[The demo's README](../README.md) has the full description, the versions it
was tested with, and every step to run it yourself. Standing it up and tearing
it down are one command each:

```bash
bash demo/standup.sh                  # checks what it needs, then builds the fleet, the sandbox, the shop and the agents' identities
bash demo/teardown.sh --confighub     # removes all of it: the kind clusters, then the ConfigHub Spaces, once you confirm
```

## The diaries

Each diary tells one run as it happened, hour by hour. It covers the three
outages, how each was found, fixed and prevented, the agents' own commands and
words, and what the run left to do.

- [The first run](first-run.md), 3 October 2026: a person approved every
  release.
- [The verification run](verification-run.md), the same evening: made from the
  README, with Milton approving or refusing everything.

The first run's transcripts, ConfigHub's record of both runs, and a
[check of the setup and the parity gate on ConfigHub's newer server](../recording/check-2026-10-04.md)
are in [recording/](../recording/README.md).
