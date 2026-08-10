# The fleet delivery machinery works on this machine

This rehearsal exists so the governed chapters do not meet their cluster
machinery for the first time on patch day. It built the full reference fleet
and drove the shared delivery path end to end with no ConfigHub involved.

Boundary: no review, approval, or promotion is claimed. The registry stands
in for the ConfigHub OCI gateway, the profiles come straight from the
reviewed example files instead of an approved ConfigHub revision, and the
chapter matrices are untouched. When this receipt was recorded
(2026-08-10), the governed lanes were still
blocked by confighubai/confighub#4975.

The delivery path: each wave of fleet profiles was published as one
raw-YAML OCI image, and Sveltos v1.13.0
on the management cluster fetched it from the registry and sent it to every
managed cluster.

What ran: a five-cluster kind fleet (one management cluster, four workload
clusters registered by environment label), Kyverno
3.8.1 converged on all four clusters
from the fetched profile set, a values change landed on the
pilot alone, a chart version bump to
3.8.2 landed on the pilot alone with the
values intact, the other three clusters held their state through both, and
injected drift was repaired. The demo application rode the same rails:
podinfo 6.14.1 converged on all four
clusters with per-environment replica counts.

| Phase | Duration |
| --- | --- |
| temporary TLS OCI registry ready | 1.3s |
| management cluster ready | 24.5s |
| four workload clusters ready | 103.8s |
| Sveltos controllers converged | 86.3s |
| four workload clusters registered | 1s |
| management cluster enrolled for remote fetch | 0.2s |
| baseline delivered to all four clusters | 155.1s |
| application delivered to all four clusters | 58.8s |
| values change delivered to the pilot only | 78.5s |
| version bump delivered to the pilot only | 132.7s |
| injected drift repaired on the pilot | 9.2s |
| Total measured | 651s |

| Check | Result |
| --- | --- |
| Clusters converged at baseline | 4/4 |
| Application clusters converged | 4/4, replicas per environment |
| Selective values change | pilot only |
| Selective version bump | pilot only, values intact |
| Distinct wave digests fetched | 4 |
| Drift repaired | pass |
| Cleanup | Pass |

## Limits

- No ConfigHub organization, review, approval, or release was involved; this is not a governance proof.
- The profile artifacts used a temporary TLS registry standing in for the ConfigHub OCI gateway; they are not permanent public packages.
- The layer contract is the one recorded by the remote fetch probe: a single raw-YAML layer. Gzipped and tar layers are refused before publication.
- The rehearsal used five local kind clusters on one machine. It measures this machine, not a production fleet.
- The chapter matrices are untouched; only the governed lanes may fill their observed cells.

- [Committed receipt](../../runs/sveltos-fleet-rehearsal/receipt.yaml)
- [Rehearsal source lock](../../examples/sveltos/fleet-rehearsal/source-lock.yaml)
