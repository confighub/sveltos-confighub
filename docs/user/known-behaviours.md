# Known behaviours of ConfigHub and Sveltos

Things we measured while building `cub sveltos` that a user, or anyone building on ConfigHub or Sveltos, will meet. Each entry says what happens, what to do about it, and when and where it was measured. When ConfigHub or Sveltos changes one, its entry is updated or removed.

Measured on ConfigHub (v0.6.5 where a log records the version) and on kind with stock Sveltos v1.15.0, in September 2026.

## ConfigHub

**A release with nothing new is refused.**
- **What happens:** `cub release publish` fails with HTTP 400, "no changes were made since :latest bundle".
- **What to do:** treat that message as success. `apply.sh`, `handover.sh` and the management record's publish do.
- **Measured:** 28 and 30 September ([policy-2026-09-28.log](../../examples/meridian-slice/policy-2026-09-28.log)).

**After `cub variant demote`, the same change proposed again does not reach the demoted unit.**
- **What happens:** the demote restores the unit's data, but the unit stays counted as upgraded to the revision it was demoted from. A later promotion of the same value is then no change to it, and reports "Upgraded" with no new revision.
- **What to do:** check a promotion's result before relying on it, or make the change in the downstream Space directly, then open a new change order.
- **Issue:** confighubai/confighub#5559.
- **Measured:** 29 September ([demo-2026-09-29.log](../../examples/meridian-slice/demo-2026-09-29.log), step 4b).

**Without `--squash`, a promotion replays the root's function past a class's protection.**
- **What happens:** a function run at the root reaches a class's clusters even though the class base protects the field.
- **What to do:** promote with `--squash`, as `apply.sh` and the docs do.
- **Issue:** confighubai/confighub#5529.

**A trigger can let changes through while its worker is gone.**
- **What happens:** a stopped worker stays `Ready`, with its last-seen time frozen, and a change made in that window is released unchecked, well before the six-hour fail-open.
- **What to do:** gate releases on a required check (`--require PolicyCheck`), which never passes without a recorded verdict.
- **Issue:** confighubai/confighub#5530.
- **Measured:** 28 September ([policy-checks.md](policy-checks.md)).

**The Healthy gate reads words, not releases.**
- **What happens:** a stage's `Healthy` prerequisite passes on a live-status reading of Synced and Healthy, whichever release the reading is about. A reading whose revision equals a release's digest also moves that release's change order on by itself.
- **What to do:** keep `cub sveltos status --watch` running, and promote after it has reported the new release.
- **See:** [live status](onboard-your-sveltos-fleet.md#live-status-in-confighub).

**The release a cluster runs is worked out, not reported.**
- **What happens:** Sveltos does not report which release it fetched, so `cub sveltos status` takes the latest release created before Sveltos last applied the profile.
- **What to do:** read `Synced` as "Sveltos applied the latest release", not as proof of the exact artifact.

**`latest: not found` before a Space's first release.**
- **What happens:** the OCI gateway has nothing at `/space/<slug>:latest` until the Space publishes a release. A Sveltos profile pointed at it goes `Failed` ("not found") and retries.
- **What to do:** deliver a variant only once it has a release. `apply.sh` and `--management-release` do.
- **Measured:** 30 September ([management-release-2026-09-30.log](../../examples/meridian-slice/management-release-2026-09-30.log)).

**Change orders keep what they were made with.**
- **What happens:** an order carries only changes made before it was created, and copies its workflow at creation. A stage with nothing new needs no approval.
- **What to do:** make the change, then open the order. To change the workflow for an order already open, abort it and open a new one.

**Refusals are specific, and worth reading.**
- **What happens:** a release waiting on a check is refused with, for example, "requires policycheck: 1 PolicyCheck attestation(s) from eligible attesters; kyverno revision 9 has 0 of 1".
- **What to do:** `cub attestation create --dry-run -o json` lists exactly which revisions an attestation would cover.

**Small things that cost time:**
- `cub changeorder update --aborted-reason` rejects an apostrophe.
- Our organization's quota was 100 Spaces, and each variant is a Space. `cub sveltos plan` prints the count; ask for more before onboarding a large fleet.

**The UI:**
- It does not yet recognise live status from Sveltos: its cards read "Not reported yet" (confighubai/confighub#5049, patch attached).

## Sveltos

**`validateHealths` runs only when Sveltos deploys.**
- **What happens:** a profile is `Provisioned` once its health checks pass, and they are not run again. A workload that goes down later still shows `Provisioned`. The Sveltos maintainers confirm it: these checks work like Helm's post-install hooks.
- **What to do:** use a ClusterHealthCheck for health after the release. `cub sveltos apply` writes one for each profile that delivers Deployments, StatefulSets or DaemonSets.
- **Measured:** 30 September ([health-2026-09-30.log](../../examples/meridian-slice/health-2026-09-30.log)).

**A ClusterHealthCheck's `Addons` check follows deployment, not running workloads.**
- **What happens:** it stayed passing while a workload was down. The Sveltos maintainers confirm this is intended: `Addons` reports the profile's own status, `Provisioned` or `Failed`.
- **What to do:** use the `HealthCheck` liveness type with a script that names the workloads. `cub sveltos apply` writes one.
- **Measured:** 30 September ([health-2026-09-30.log](../../examples/meridian-slice/health-2026-09-30.log)).

**A HealthCheck's script must return each resource's health under `status`.**
- **What happens:** the field's description says `healthStatus`, but the agent reads `status`. With `healthStatus`, every report is rejected: `spec.resourceStatuses[0].healthStatus: Unsupported value: ""`.
- **Measured:** 30 September.

**A ClusterHealthCheck chooses clusters by label only.**
- **What happens:** it has no `clusterRefs`, while a delivery profile names its one cluster.
- **What to do:** `cub sveltos` selects by the profile's own labels, with every class of a component. For a profile that uses `clusterRefs`, it selects every cluster Sveltos manages, and the check names its workloads, so other clusters pass.

**A custom resource listed before its CRD stops a fresh cluster.**
- **What happens:** without `continueOnError`, Sveltos stops at the first object that fails, on every retry. NVIDIA's GPU operator chart does this.
- **What to do:** delivery profiles set `continueOnError: true`. The Sveltos maintainers have made OCI delivery apply CRDs first, in the release after v1.15.0 ([#77](https://github.com/confighub/sveltos-confighub/issues/77)).

**A new release reaches a cluster within the fetch interval.**
- **What happens:** delivery profiles fetch every minute. A redeploy annotation, `profile.projectsveltos.io/redeploy`, comes in the release after v1.15.0 ([#77](https://github.com/confighub/sveltos-confighub/issues/77)).

**A health check that never passes leaves the profile `Provisioning`.**
- **What happens:** `maxConsecutiveFailures` will count health checks from the release after v1.15.0 ([#77](https://github.com/confighub/sveltos-confighub/issues/77)).

**Removing a profile withdraws what it deployed.**
- **What happens:** that is the default `stopMatchingBehavior`.
- **What to do:** `handover.sh` sets `LeavePolicies` before deleting a live profile. The root profile of `--management-release` has `LeavePolicies`, so removing it never takes every add-on off every cluster.

**A profile can deploy profiles to the management cluster.**
- **What happens:** Sveltos registers the management cluster as `mgmt/mgmt`. A ClusterProfile addressed to it can deliver other ClusterProfiles, and it takes over ones `kubectl` applied.
- **Measured:** 30 September.

**On kind, cluster tokens last 30 days.**
- **What to do:** `node examples/meridian-slice/kind-fleet.mjs --refresh` renews them.

## Kubernetes

**Deleting a ValidatingAdmissionPolicy can leave its successors' parameters stale.**
- **What happens:** on Kubernetes v1.35, after a policy is deleted, the parameters the policies after it read stay as they were until the API server restarts.
- **What to do:** `cub sveltos impact` applies policies in place, and says when it removed one. Restart the sandbox's API server if a result looks wrong.
- **Measured:** 28 September.

**An overloaded host makes kind clusters restart their own pods.**
- **What happens:** with sixteen kind clusters on one laptop, containers failed to start ("unable to apply cgroup configuration"). Kyverno's pods restarted on their own. The continuous health check reported it, where Sveltos's own status did not.
- **Measured:** 30 September ([health-2026-09-30.log](../../examples/meridian-slice/health-2026-09-30.log)).
