# Outage 2: the review before approval (2026-10-03)

From the first run. The operator, the Claude Code session that relayed approval
requests, reviewed Angel's proposal before the approver saw it. Read-only on the
fleet. [The first run's diary](../../../diary/first-run.md#outage-2-half-the-fleet-at-once)
tells the same story.

The orders: **A** is the fix (the record takes the stray profile over), **B**
the policy (profiles only from the record), **C** the clean-up. B2 and C2 are
B and C proposed again after this review. `guardrails@4` means revision 4 of
the unit `guardrails`.

1. Angel's first proposal exempted `system:serviceaccount:projectsveltos:register-mgmt-cluster` as
   the identity Sveltos writes the record as. Angel marked it "not tested anywhere"; the preview
   answered "unknown" for every known case, because the policy reads the requesting user.
2. The SveltosCluster `mgmt/mgmt` reads the kubeconfig in Secret `mgmt/mgmt-sveltos-kubeconfig`
   (key `re-kubeconfig`). Only the `sub` claim of the token in each key was decoded; both are
   `system:serviceaccount:projectsveltos:projectsveltos`. `register-mgmt-cluster` is the job that
   registered the cluster. Released, the first B would have refused the record's own releases.
3. In the policy sandbox, guardrails@4 bound, impersonating each identity: 10 of 10 cases as
   intended. The logic held; only the identity was wrong.
4. A went to approval alone. B and C went back to Angel, who aborted them and proposed B2 and C2.
5. guardrails@5 (B2) in the sandbox: 13 of 13 as intended
   (`review-guardrails-5-impersonation.txt`). On the management cluster, the only writers of a
   profile's spec are Sveltos's server-side apply (`application/apply-patch`) and earlier kubectl
   applies; the controller writes metadata and status only.

## The preview changed the management cluster (found 16:15, after A's release)

6. In its second run, Angel was not given the sandbox's kubeconfig. It ran `cub sveltos impact`
   three times without `--sandbox-kubeconfig` (commands 69, 71 and 73 in
   `angel-20261003T152856Z.md`). The plugin then took the current kubectl context, which is the
   management cluster `kind-chaos-mgmt`, as its sandbox.
7. As a result, it applied the policy `profiles-only-from-record` and its binding (Deny) to the
   management cluster with kubectl:
   - 15:32:26: guardrails@5, which exempts projectsveltos;
   - 15:33:17: a scratch copy with no exemptions;
   - it also created five namespaces `impact-tests-*` there.
   - Nothing in the record or in any approval put them there.
   - From 15:33:17, every write of a ClusterProfile or Profile on the management cluster was
     refused, Sveltos's included.
8. A, released at 16:15:16, updated the policy to its own unbound content (exempting
   register-mgmt-cluster). The stray binding kept it enforcing.
   - Sveltos's writes of all nine ClusterProfiles were refused; live status for chaos-management
     went Degraded ("ClusterProfile shop-staging may not be written by
     system:serviceaccount:projectsveltos:projectsveltos").
   - The outage still ended, because A also emptied the ConfigMap the stray profile delivered
     (16:16:13 and 16:16:16; Healthy 16:16:32 and 16:16:51).
9. Angel stopped before B2, as its stop condition said, and reported the binding it did not know
   it had applied.
10. Fixed in `cub sveltos` v0.12.1. The defect was in the plugin: `impact`, and `check` with the sandbox, accept the current
    context as a sandbox. They should refuse to run without one named, and refuse a cluster
    that runs Sveltos or anything else.
