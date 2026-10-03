# The verification run, 2026-10-03

A second run, made from this folder's README alone, with **Milton approving
every release** and no person approving anything. Versions as in the README:
`cub sveltos` v0.13.0 (installed from the release), `cub` v0.8.1, ConfigHub
server v0.8.1, Sveltos v1.15.0, kind v0.31.0, Claude Code 2.1.285.

| Part | Outcome |
| --- | --- |
| Setup | Fleet, sandbox, shop and Reloader in about 7 minutes, as written |
| Onboarding | Milton reviewed and approved staging and prod for both components; handover with nothing reinstalled; all nine Spaces Synced and Healthy |
| Outage 1 | Rotation at 20:18:57Z, Degraded on 4 of 4 by 20:21:15Z. Angel's fix (reload annotation and a one-time restart) and policy, each approved by Milton; staging serving again 21 s after its release, prod 28 s after. Devil's repeat: the rotation handled by Reloader, `web-copy` refused at admission |
| Outage 2 | Lockdown at 20:59:55Z, prod-us-1 and prod-us-2 Degraded by 21:00:55Z. Angel's policy judges a profile by its shape, not by who sends it, so no identity needed exempting. Milton approved after testing every live record profile and its own extra cases. Healthy 1.5 minutes after the release; clean-up deleted the stray profile under the policy; Devil's repeat refused twice |
| Outage 3 | **Milton refused Devil's prod-only memory cut**: lowering only the limit saves no cost, it had never run in staging, and there was no evidence of a safe margin. So the outage did not happen. In the recording, a person approved the same change, and prod was OOMKilled |

What the run found and fixed in this folder (the follow-up commit):
- `run-agent.sh` failed under macOS's bash 3.2 when no model was set.
- Milton could not read what it was asked to approve until permissions were
  granted, so `grant-agents.sh` now runs before the first approval.
- A Space has no `Approve` permission. Milton needs `ApproveChildren` to
  approve, and `UseChildren` because approving a change order needs Use on it.
- Devil needs View and Use on a component to open a change order on its
  workflow.
- Milton applied objects to the policy sandbox to compare them, so the next
  preview refused the sandbox as not empty. Milton now applies only policies
  there, and `setup/sandbox.sh --reset` empties it.
- Milton now reviews with every request in the run, not only the last.
- Every script loads `env.sh` itself.

Found in ConfigHub: publishing a change order whose end tag a unit created
later does not carry failed with HTTP 500 ("no Revision found for Unit ... with
the specified TagID"). `cub release publish --help` says such a unit falls back
to its head revision. Angel published the other order, which carried both
units.

One operator error: a script was edited while a run was using it, which
truncated one transcript. A read-only recovery run rewrote that request.

## ConfigHub's record

Printed by `proof/evidence.sh 2026-10-03T19:40` before teardown. User IDs are
shortened.

```
## Gates
  chaos-shop-base/rollout: approval = 1 Approval from you, milton (Worker); authors counted: False
  chaos-shop-base/rollout: stage bases releases need nothing
  chaos-shop-base/rollout: stage staging releases need approval
  chaos-shop-base/rollout: stage prod releases need approval
  chaos-platform-base/rollout: approval = 1 Approval from you, milton (Worker); authors counted: False
  chaos-platform-base/rollout: stage bases releases need nothing
  chaos-platform-base/rollout: stage staging releases need approval
  chaos-platform-base/rollout: stage prod releases need approval
  chaos-management/record: approval = 1 Approval from you, milton (Worker); authors counted: False
  chaos-management/record: stage record releases need approval

## Change orders, and how each ended
  2026-10-03T19:47:40  chaos-shop-base/onboard-d244df9f  Released
  2026-10-03T20:23:26  chaos-shop-base/web-reload-on-token-rotation  Released
  2026-10-03T21:35:22  chaos-shop-base/prod-api-memory-40mi  Aborted
      aborted: Not approved by the approvers agent (the limit change saves no cost, never ran in staging, and had no evidence of a safe margin); withdrawn by devil.
  2026-10-03T19:47:34  chaos-platform-base/onboard-111745ae  Released
  2026-10-03T20:33:48  chaos-platform-base/guardrails-secret-env-needs-reloader  Released
  2026-10-03T21:07:28  chaos-management/withdraw-shop-lockdown  Aborted
      aborted: Not published: its end tag could not be bundled into a release on its own. Its content (shop-lockdown revision 2) shipped in chaos-management/guardrails-profiles-deliver-confighub-releases, published 2026-10-03T21:22:03Z under the approval of that order.
  2026-10-03T21:10:43  chaos-management/guardrails-profiles-deliver-confighub-releases  Released
  2026-10-03T21:24:20  chaos-management/remove-shop-lockdown  Released

## Approvals and checks: who recorded each, and why
  2026-10-03T20:01:19  chaos-shop-staging  Approval Pass by milton (Worker) on chaos-shop-base/onboard-d244df9f
      note: First release, so no prior release to diff: read chaos-shop-staging/shop head (rev 2) in full; it is identical to its bases and to ConfigMap default/shop that ClusterProfile shop delivers today, and matches live objects in ns shop on staging (generation 1, 2/2 ready). No Secret in the unit. Risk: two owners of the same objects at a later cutover from the Sveltos profile (WithdrawPolicies).
  2026-10-03T20:03:20  chaos-platform-staging  Approval Pass by milton (Worker) on chaos-platform-base/onboard-111745ae
      note: First release, no prior release to diff: read full head of chaos-platform-staging/reloader (7 objects, no Secret), same data hash as base and class-staging with a single cloned revision, so no pre-order edit. Compared field by field with live staging and the platform ClusterProfile (stakater/reloader 2.2.18, image v1.4.22): identical spec and RBAC, pod healthy; risk is the ownership handover from the Helm release, not content.
  2026-10-03T20:09:06  chaos-shop-prod-eu  Approval Pass by milton (Worker) on chaos-shop-base/onboard-d244df9f
      note: Checked: prod-eu, prod-us-1, prod-us-2 units each have one content revision (hash d151211a..., same as base and staging), no later edits; sandbox diff of each against ConfigMap default/shop that ClusterProfile shop deploys is empty; live objects on all 4 clusters carry the same Sveltos hashes. Staging release 1 published 20:05:53Z left staging at generation 1, 0 restarts, 2/2 ready. Caveat: nothing on mgmt consumes a release yet, so the delivery cutover from the profile is untested and needs its own review.
  2026-10-03T20:09:06  chaos-shop-prod-us-1  Approval Pass by milton (Worker) on chaos-shop-base/onboard-d244df9f
      note: Checked: prod-eu, prod-us-1, prod-us-2 units each have one content revision (hash d151211a..., same as base and staging), no later edits; sandbox diff of each against ConfigMap default/shop that ClusterProfile shop deploys is empty; live objects on all 4 clusters carry the same Sveltos hashes. Staging release 1 published 20:05:53Z left staging at generation 1, 0 restarts, 2/2 ready. Caveat: nothing on mgmt consumes a release yet, so the delivery cutover from the profile is untested and needs its own review.
  2026-10-03T20:09:06  chaos-shop-prod-us-2  Approval Pass by milton (Worker) on chaos-shop-base/onboard-d244df9f
      note: Checked: prod-eu, prod-us-1, prod-us-2 units each have one content revision (hash d151211a..., same as base and staging), no later edits; sandbox diff of each against ConfigMap default/shop that ClusterProfile shop deploys is empty; live objects on all 4 clusters carry the same Sveltos hashes. Staging release 1 published 20:05:53Z left staging at generation 1, 0 restarts, 2/2 ready. Caveat: nothing on mgmt consumes a release yet, so the delivery cutover from the profile is untested and needs its own review.
  2026-10-03T20:12:26  chaos-platform-prod-eu  Approval Pass by milton (Worker) on chaos-platform-base/onboard-111745ae
      note: First release, so read whole unit: prod-eu, prod-us-1, prod-us-2 reloader are one clone revision each, byte-identical to staging's released unit (no later edits). Content is stock stakater/reloader 2.2.18 (image v1.4.22) as the platform ClusterProfile installs today; live deployment, ClusterRole/Binding, Role/Binding on all three prod clusters match it, and staging is released, generation 1, 1/1 ready. Risk: live objects are still Helm-owned by the Sveltos profile; a later delivery cutover needs its own review.
  2026-10-03T20:12:26  chaos-platform-prod-us-2  Approval Pass by milton (Worker) on chaos-platform-base/onboard-111745ae
      note: First release, so read whole unit: prod-eu, prod-us-1, prod-us-2 reloader are one clone revision each, byte-identical to staging's released unit (no later edits). Content is stock stakater/reloader 2.2.18 (image v1.4.22) as the platform ClusterProfile installs today; live deployment, ClusterRole/Binding, Role/Binding on all three prod clusters match it, and staging is released, generation 1, 1/1 ready. Risk: live objects are still Helm-owned by the Sveltos profile; a later delivery cutover needs its own review.
  2026-10-03T20:12:26  chaos-platform-prod-us-1  Approval Pass by milton (Worker) on chaos-platform-base/onboard-111745ae
      note: First release, so read whole unit: prod-eu, prod-us-1, prod-us-2 reloader are one clone revision each, byte-identical to staging's released unit (no later edits). Content is stock stakater/reloader 2.2.18 (image v1.4.22) as the platform ClusterProfile installs today; live deployment, ClusterRole/Binding, Role/Binding on all three prod clusters match it, and staging is released, generation 1, 1/1 ready. Risk: live objects are still Helm-owned by the Sveltos profile; a later delivery cutover needs its own review.
  2026-10-03T20:37:12  chaos-shop-staging  Approval Pass by milton (Worker) on chaos-shop-base/web-reload-on-token-rotation
      note: Read the order and chaos-shop-staging/shop head 3 against release 2: only a comment, the secret.reloader.stakater.com/reload: shop-token annotation on Deployment shop/web and a one-time pod-template annotation. Confirmed on staging: web 0/2 with 401 probes since the shop-token Secret was patched by kubectl at 20:18:54Z, Reloader v1.4.22 1/1 with a cluster-wide role to watch Secrets and patch Deployments, Sveltos syncMode Continuous; the fix itself is unproven until staging runs it.
  2026-10-03T20:42:57  chaos-platform-staging  Approval Pass by milton (Worker) on chaos-platform-base/guardrails-secret-env-needs-reloader
      note: Read chaos-platform-staging: guardrails head (rev 3, never released) is only the VAP secret-env-needs-reloader plus its Deny binding, same as base except blank lines in the CEL; reloader has no diff. Against the identical policy in the sandbox, server dry-runs gave the 12 known cases as expected (6 allowed, 6 denied) and admitted staging's released shop (web, api) and reloader; on the staging cluster web is the only Deployment taking a Secret through env, it is annotated and 2/2, and the shop fix is released there. Risk: any Deployment outside ConfigHub with Secret env and no annotation is refused, and rolling back the web fix is refused until this is demoted first.
  2026-10-03T20:49:11  chaos-shop-prod-eu  Approval Pass by milton (Worker) on chaos-shop-base/web-reload-on-token-rotation
      note: Read shop head vs last release (rev 2 to 3) in prod-eu, prod-us-1, prod-us-2: identical, only the Reloader annotation on Deployment web, a one-time pod-template annotation and a comment; no other unit in those Spaces. Staging runs rev 3 at 2/2 and Reloader restarted web on a second shop-token rotation at 20:46Z; prod web is 0/2 on 401 with api 2/2, same Reloader v1.4.22 running, no admission policy live, so the roll cannot lose availability.
  2026-10-03T20:49:11  chaos-shop-prod-us-1  Approval Pass by milton (Worker) on chaos-shop-base/web-reload-on-token-rotation
      note: Read shop head vs last release (rev 2 to 3) in prod-eu, prod-us-1, prod-us-2: identical, only the Reloader annotation on Deployment web, a one-time pod-template annotation and a comment; no other unit in those Spaces. Staging runs rev 3 at 2/2 and Reloader restarted web on a second shop-token rotation at 20:46Z; prod web is 0/2 on 401 with api 2/2, same Reloader v1.4.22 running, no admission policy live, so the roll cannot lose availability.
  2026-10-03T20:49:11  chaos-shop-prod-us-2  Approval Pass by milton (Worker) on chaos-shop-base/web-reload-on-token-rotation
      note: Read shop head vs last release (rev 2 to 3) in prod-eu, prod-us-1, prod-us-2: identical, only the Reloader annotation on Deployment web, a one-time pod-template annotation and a comment; no other unit in those Spaces. Staging runs rev 3 at 2/2 and Reloader restarted web on a second shop-token rotation at 20:46Z; prod web is 0/2 on 401 with api 2/2, same Reloader v1.4.22 running, no admission policy live, so the roll cannot lose availability.
  2026-10-03T20:55:16  chaos-platform-prod-us-2  Approval Pass by milton (Worker) on chaos-platform-base/guardrails-secret-env-needs-reloader
      note: Read guardrails@3 in all three prod Spaces: only the ValidatingAdmissionPolicy secret-env-needs-reloader and its Deny binding, same as live on staging; reloader unit has no diff. Reran the previews and 8 own dry-run cases in the sandbox: unfixed web is denied, the web fix, api and reloader are allowed, 12 known cases as expected; no other prod Deployment takes a Secret through env. Release after chaos-shop-base/web-reload-on-token-rotation in prod: until then any update or re-apply of the unfixed web is refused.
  2026-10-03T20:55:17  chaos-platform-prod-us-1  Approval Pass by milton (Worker) on chaos-platform-base/guardrails-secret-env-needs-reloader
      note: Read guardrails@3 in all three prod Spaces: only the ValidatingAdmissionPolicy secret-env-needs-reloader and its Deny binding, same as live on staging; reloader unit has no diff. Reran the previews and 8 own dry-run cases in the sandbox: unfixed web is denied, the web fix, api and reloader are allowed, 12 known cases as expected; no other prod Deployment takes a Secret through env. Release after chaos-shop-base/web-reload-on-token-rotation in prod: until then any update or re-apply of the unfixed web is refused.
  2026-10-03T20:55:17  chaos-platform-prod-eu  Approval Pass by milton (Worker) on chaos-platform-base/guardrails-secret-env-needs-reloader
      note: Read guardrails@3 in all three prod Spaces: only the ValidatingAdmissionPolicy secret-env-needs-reloader and its Deny binding, same as live on staging; reloader unit has no diff. Reran the previews and 8 own dry-run cases in the sandbox: unfixed web is denied, the web fix, api and reloader are allowed, 12 known cases as expected; no other prod Deployment takes a Secret through env. Release after chaos-shop-base/web-reload-on-token-rotation in prod: until then any update or re-apply of the unfixed web is refused.
  2026-10-03T21:14:45  chaos-management  Approval Pass by milton (Worker) on chaos-management/withdraw-shop-lockdown
      note: Covers shop-lockdown@2 and the four unchanged units only; guardrails@2 is NOT covered by this approval (no tag from this order). Checked: live shop-lockdown selects region=us and delivers the deny-all NetworkPolicy to prod-us-1/2 (web 0/2); the unit empties it (selector and policyRefs are atomic in the CRD, so replaced not merged; no cluster carries the new label). Sveltos withdrawal itself is untested; if it does not take, the lockdown stays and nothing gets worse. Because a release would also carry guardrails@2, I dry-ran it in the sandbox: all nine live record profiles and the emptied shop-lockdown admitted, the rogue profile denied.
  2026-10-03T21:18:56  chaos-management  Approval Pass by milton (Worker) on chaos-management/guardrails-profiles-deliver-confighub-releases
      note: Read guardrails@2 and shop-lockdown@2 (both new units; the other four record units have no diff). Applied guardrails@2 to the sandbox and dry-ran: the record's 8 delivery profiles, the root profile, the live defaulted form and the emptied shop-lockdown are admitted; the rogue shop-lockdown, namespaced Profiles and 13 other off-shape cases are denied; sandbox left empty. Not tested: Sveltos's takeover and withdrawal. Gap: deploymentType, path and templateResourceRefs on a record-shaped profile are not pinned.
  2026-10-03T21:26:14  chaos-management  Approval Pass by milton (Worker) on chaos-management/remove-shop-lockdown
      note: Read the order (one Space, chaos-management) and diffed all five remaining units head vs last release: no change, so the release only drops unit shop-lockdown. On mgmt the ClusterProfile shop-lockdown has empty policyRefs, a selector no SveltosCluster matches and no ClusterSummary; it and ConfigMap default/shop-lockdown are owned by root profile chaos-management; nothing else references the ConfigMap. Live guardrail policy matches only CREATE/UPDATE, skips objects being deleted and admits a profile that delivers nothing, so it will not block the finalizer removal. No lockdown NetworkPolicy and web/api 2/2 on all four clusters. Risk: Sveltos pruning is untested, so the two inert objects may remain and need a follow-up.

## Releases: who published each
  2026-10-03T20:05:41  chaos-platform-staging  release 1 by angel (Worker) for chaos-platform-base/onboard-111745ae
  2026-10-03T20:05:53  chaos-shop-staging  release 1 by angel (Worker) for chaos-shop-base/onboard-d244df9f
  2026-10-03T20:14:34  chaos-platform-prod-eu  release 1 by angel (Worker) for chaos-platform-base/onboard-111745ae
  2026-10-03T20:14:36  chaos-platform-prod-us-1  release 1 by angel (Worker) for chaos-platform-base/onboard-111745ae
  2026-10-03T20:14:38  chaos-platform-prod-us-2  release 1 by angel (Worker) for chaos-platform-base/onboard-111745ae
  2026-10-03T20:14:46  chaos-shop-prod-eu  release 1 by angel (Worker) for chaos-shop-base/onboard-d244df9f
  2026-10-03T20:14:48  chaos-shop-prod-us-1  release 1 by angel (Worker) for chaos-shop-base/onboard-d244df9f
  2026-10-03T20:14:49  chaos-shop-prod-us-2  release 1 by angel (Worker) for chaos-shop-base/onboard-d244df9f
  2026-10-03T20:16:48  chaos-management  release 1 by angel (Worker) for no change order
  2026-10-03T20:38:06  chaos-shop-staging  release 2 by angel (Worker) for chaos-shop-base/web-reload-on-token-rotation
  2026-10-03T20:43:34  chaos-platform-staging  release 2 by angel (Worker) for chaos-platform-base/guardrails-secret-env-needs-reloader
  2026-10-03T20:56:38  chaos-shop-prod-eu  release 2 by angel (Worker) for chaos-shop-base/web-reload-on-token-rotation
  2026-10-03T20:56:39  chaos-shop-prod-us-1  release 2 by angel (Worker) for chaos-shop-base/web-reload-on-token-rotation
  2026-10-03T20:56:40  chaos-shop-prod-us-2  release 2 by angel (Worker) for chaos-shop-base/web-reload-on-token-rotation
  2026-10-03T20:57:14  chaos-platform-prod-us-1  release 2 by angel (Worker) for chaos-platform-base/guardrails-secret-env-needs-reloader
  2026-10-03T20:57:15  chaos-platform-prod-us-2  release 2 by angel (Worker) for chaos-platform-base/guardrails-secret-env-needs-reloader
  2026-10-03T20:57:19  chaos-platform-prod-eu  release 2 by angel (Worker) for chaos-platform-base/guardrails-secret-env-needs-reloader
  2026-10-03T21:22:03  chaos-management  release 2 by angel (Worker) for chaos-management/guardrails-profiles-deliver-confighub-releases
  2026-10-03T21:26:36  chaos-management  release 3 by angel (Worker) for chaos-management/remove-shop-lockdown
```
