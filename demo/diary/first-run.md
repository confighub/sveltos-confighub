# Diary of the first run, 3 October 2026

Two AI agents with their own ConfigHub identities ran three outages on a
Sveltos fleet. **Devil** caused each outage. **Angel** found the cause, fixed it
through ConfigHub and proposed what stops it happening again. **A person, the
approver**, approved every release. **The operator**, a Claude Code session,
started each agent run, relayed approvals and reviewed before the approver saw
anything.

Kind clusters stand in for production. All times are UTC. The agents' words
and commands are quoted from their transcripts, which are in
[recording/runs/](../recording/runs/) with ConfigHub's own record of each
outage (`evidence*.txt`). The agents ran a development build of
`cub sveltos`, invoked as `cub-sveltos-chaos`. Its features shipped in v0.13.0.

The second run, made later the same day from the README with an agent
approver, has [its own diary](verification-run.md).

## Contents

- [Morning: the fleet comes under ConfigHub](#morning-the-fleet-comes-under-confighub)
- [Outage 1: a rotation nobody picked up](#outage-1-a-rotation-nobody-picked-up)
- [Outage 2: half the fleet at once](#outage-2-half-the-fleet-at-once)
- [Outage 3: staging said yes, prod said no](#outage-3-staging-said-yes-prod-said-no)
- [Evening: what the run turned into](#evening-what-the-run-turned-into)
- [To do after the first run](#to-do-after-the-first-run)

## Morning: the fleet comes under ConfigHub

**The fleet.** Five kind clusters run stock Sveltos v1.15.0: `chaos-mgmt`, and
four workload clusters. `staging` and `prod-eu` carry `region=eu`;
`prod-us-1` and `prod-us-2` carry `region=us`, which is half the fleet.

**By 11:05. The agents get identities.** Devil and Angel are ConfigHub workers in
the Space `chaos-agents`, each signed in to its own `cub` context. Neither may
approve.

![The Workers page: devil and angel in the Space chaos-agents](images/r1-00-workers.jpg)

**11:07. The shop.** Plain Sveltos installs a small shop on the four workload
clusters. `api` checks a bearer token on each request and reads it from a
mounted file. `web` calls `api` with the same token, which it reads once, from
its environment, at start. Both come from the Secret `shop-token`.

**11:21. Angel onboards the shop.** `cub sveltos` turns the running Sveltos
profiles into ConfigHub units: a base, a class base each for staging and prod,
and one variant per cluster. Each release goes through the workflow
`chaos-shop-base/rollout`:

- `bases` takes the change with no gate;
- `staging`'s release needs one approval;
- `prod` needs staging released, and one approval.

The approval must come from a named approver and never from an author of the
change. Angel printed the gate as "1 Approval attestation(s) from 1 named
user(s), not by an author of the change".

![The onboarding rollout: staging promoted, prod gated](images/r1-02-onboard-promotion-path.jpg)

**11:26 to 11:29. The first approvals.** The approver approved staging, then
prod, in a chat with the operator. The operator recorded each approval under
the approver's own identity. Recording an approval has this shape:

```bash
cub variant approve --change-order chaos-shop-base/onboard-d244df9f --stage staging --note "<the approver's words>"
```

Angel's onboarding script then published each stage, the way every release in
this demo is published: `cub release publish <space> --revision ChangeOrder:<order>`.

**11:30. The handover.** The management cluster's delivery profiles now come
from ConfigHub. The record `chaos-management` holds them, and one root
ClusterProfile fetches its releases. Nothing was reinstalled: staging's `api`
pods kept their names and age through the handover.

![The shop's component graph: four deployments, Live and Synced at rel-1](images/r1-05-shop-healthy.jpg)

**12:09 to 12:22. The platform.** Plain Sveltos installs Stakater Reloader on
every cluster. It is onboarded the same way, as the component `chaos-platform`,
and the record takes its profile over at 12:22.

## Outage 1: a rotation nobody picked up

![Timeline of outage 1](images/r1-o1-timeline.png)

**12:29:54. Devil rotates the shop's token**, the way a secret store or a
security team would: directly in each cluster, outside ConfigHub.

```bash
openssl rand -hex 16 | tr -d '\n' | jq -Rs '{stringData:{token:.}}' \
  | kubectl --context kind-chaos-staging -n shop patch secret shop-token --type merge --patch-file /dev/stdin
```

> The shop's API token is rotated in all four workload clusters, and nothing
> else was touched. (Devil)

![Devil's run](images/r1-o1-devil.png)

**12:30:46. `web` goes unready.** `api` reads the new token from its file.
`web` still sends the old one, so `api` answers 401 and `web`'s readiness probe
fails.

**12:31:15. ConfigHub sees it**, 81 seconds after the rotation. The live status
of all four variants turns Degraded:

```
ClusterHealthCheck chaos-shop: Deployment: shop/web status is Degraded Message: web: 0 of 2 available
```

![The shop Degraded on all four clusters](images/r1-10-outage1-degraded.jpg)

**12:39:10. Angel starts**, launched by the operator on the Degraded status.
Nothing alerted on it yet.

**12:41. Angel proposes the fix**, 11 minutes after the fault. It found that
`web` reads the token "once, from the environment, at start". The fix is a
Reloader annotation on `web`, so it restarts whenever the Secret changes, plus a
one-time pod-template annotation to roll it now. Angel wrote it to the base
unit, opened a change order and promoted it as far as the first gate:

```bash
cub unit update shop shop.yaml --space chaos-shop-base --change-desc "web: restart on shop-token rotation (Reloader annotation) and roll once to pick up the 2026-10-03 rotation"
cub changeorder create --space chaos-shop-base web-reload-on-token-rotation --change-workflow chaos-shop-base/rollout --description "..."
cub variant promote --change-order chaos-shop-base/web-reload-on-token-rotation --target-stage staging --squash
```

> Not tested: there is nowhere to run the change before staging, so staging is
> the test. I have not seen Reloader restart web on a rotation in this fleet.
> (Angel's approval request)

![Angel's fix waiting for approval at staging](images/r1-12-outage1-fix-waiting.jpg)

![Angel's diagnosis and fix](images/r1-o1-angel.png)

**12:44 to 12:51. Angel writes the prevention.** It is an admission policy for
every cluster: `secret-env-needs-reload`. A Deployment that takes a Secret
through its environment must carry `reloader.stakater.com/auto: "true"` or
name every such Secret in `secret.reloader.stakater.com/reload`. Nothing is
exempt. Angel put 11 known cases in a new Space, `chaos-policies`, and
previewed the policy in a sandbox cluster that runs nothing:

```bash
cub-sveltos-chaos impact --sandbox-kubeconfig $AI_CHAOS_DIR/sandbox.kubeconfig --policy $DEMO/agents/no-policies.yaml \
  --candidate chaos-platform-base/guardrails --tests chaos-policies/known-cases --component chaos-shop
```

- **As the fleet runs now:** "4 newly denied", `web` on every cluster.
- **With the fix as the next promotion:** "0 newly denied".
- **The platform's own Reloader:** allowed.

So the fix must be released before the policy, and Angel asked for exactly
that.

![Angel's policy previews](images/r1-o1-policy.png)

On the way, Angel found that ConfigHub's YAML round trip added blank lines
inside a multi-line CEL expression at each promotion hop. The text then
differed between Spaces, though its behaviour did not. Angel wrote the
expression on one line, opened a replacement order
(`guardrails-secret-env-reload-r3`) and aborted the first, with a reason.

![The policy's change order, with the rewritten expression](images/r1-13-outage1-policy-waiting.jpg)

**12:51 to 14:20. Waiting for the approver.** Most of this outage's two and a
half hours was this wait.

**14:20:39. The approver approves the fix for staging.** Angel published it at
14:21:15. New `web` pods were ready at 14:22:10. ConfigHub showed Degraded for
another minute and a half: Sveltos had run its health check mid-rollout, seen "web: 1
of 2 updated", and recorded a failure until its next pass. Staging was Healthy
at 14:23:48.

![Staging fixed and Live; prod still Degraded and one release behind](images/r1-17-outage1-staging-fixed.jpg)

**14:24:39. The policy goes to staging.** The approver approved it and Angel
released it. The policy and its binding were on the staging cluster at 14:25:13.
Angel then promoted both orders to prod and stopped at the prod gate.

**14:26:52. Devil tries again, on staging.** First, it rotated the token again.
Reloader restarted `web`, and the old pods served while the new ones came up.
Then it deployed a copy of `web` without the annotation:

```
The deployments "web-copy" is invalid: : ValidatingAdmissionPolicy 'secret-env-needs-reload' with binding
'secret-env-needs-reload' denied request: Deployment web-copy takes a Secret through its environment
(env secretKeyRef or envFrom secretRef) but does not say how it picks up a rotation. Annotate the Deployment
with reloader.stakater.com/auto: "true", or with secret.reloader.stakater.com/reload naming every such Secret.
```

![Devil, again: the rotation is handled, the copy is refused](images/r1-o1-again.png)

**14:59:19. Prod.** The approver approved both orders for prod. Angel published
the fix to the three prod clusters at 15:00:08, waited for each cluster's `web`
to be ready, then published the policy. All four clusters were Healthy at
15:02:31.

![The fleet Healthy again, at rel-2](images/r1-19-outage1-healthy.jpg)

![The fix's rollout complete: every stage promoted and released](images/r1-20-outage1-complete.jpg)

What outage 1 showed:
- ConfigHub saw the failure in 81 seconds, from the clusters' own health checks.
- Angel had the fix in 11 minutes and the policy in 22. The preview showed
  which had to go first, before anything shipped.
- Nothing reached a cluster without a named person's approval. Every release is
  recorded with who published it, and every approval with who recorded it.

## Outage 2: half the fleet at once

![Timeline of outage 2](images/r1-o2-timeline.png)

**15:07:20. The record is gated first.** The management record gets its own
workflow, `chaos-management/record`: one stage, released only with the
approver's approval. A direct publish is now refused:

```
$ cub release publish chaos-management
Failed: HTTP 400: component chaos-management requires a ChangeWorkflow; use a ChangeOrder that has one
```

**15:07:42. Devil applies a lockdown by hand** on the management cluster, as a
security team might: a ConfigMap holding a deny-all NetworkPolicy for the
`shop` namespace, and a ClusterProfile `shop-lockdown` that delivers it to
every cluster with `region=us`. Sveltos matched `prod-us-1` and `prod-us-2`.

**15:08:38. Half the fleet goes down.** ConfigHub showed `prod-us-1` Degraded
56 seconds after the fault, and `prod-us-2` 19 seconds later. Staging and
`prod-eu` stayed Healthy.

![prod-us-1 and prod-us-2 Degraded; staging and prod-eu Live](images/r1-21-outage2-half-degraded.jpg)

**15:10:20. Angel starts**, and named the stray profile 18 seconds later:

```bash
kubectl get clusterprofiles,profiles,clustersummaries -A -o wide --context kind-chaos-mgmt
```

The profile was not in the record. "Why it was possible: the management cluster
had no admission policy, so anyone with access could add a profile beside the
record's."

![Angel finds the stray profile](images/r1-o2-angel.png)

**15:14 to 15:21. Angel's proposal.** It came as three change orders on the
record:

- **A:** the record takes the stray profile over and makes it match no cluster
  and deliver nothing.
- **B:** an admission policy on the management cluster, under which only
  Sveltos, acting for the record, may write profiles.
- **C:** remove the stray profile.

Angel first opened three orders in the wrong shape, saw it, and aborted them
with reasons: "I abort the three change orders I opened, saying why, so none of
them can be approved or published by mistake."

The preview could not judge B. It answered "unknown" for every case, because
the policy reads who sends the request, and a configuration does not say that.

**15:28. The operator's review finds B wrong.** Before the approver saw
anything, the operator checked the identity B exempted. B exempted
`register-mgmt-cluster`, the job that registered the cluster. Sveltos writes to
the management cluster as another identity. The operator read the kubeconfig
Sveltos holds for the management cluster (Secret
`mgmt/mgmt-sveltos-kubeconfig`) and decoded only its token's subject, never the
token: `system:serviceaccount:projectsveltos:projectsveltos`. Readers can
repeat the check with `proof/token-subject.sh`, written after this run.

Released, B would have refused the record's own releases. Tested in the
sandbox by impersonation, the policy's logic held, 10 cases of 10: only the
identity was wrong. So A went to the approver alone, and B and C went back to
Angel, which aborted them and proposed **B2** and **C2** with the right
identity. A second impersonation test passed 13 of 13.

![Rollouts: A, B and C waiting; Angel's three mis-shaped orders aborted](images/r1-22-outage2-orders.jpg)

**15:32. A near miss nobody saw yet.** In that second run Angel had no sandbox
path, so it ran the preview three times without naming one. The tool took the
current kubectl context, the management cluster itself, as its sandbox. It
applied the policy and its binding there at 15:32:26, a copy with no
exemptions at 15:33:17, and five test namespaces.

**16:14:28. The approver: "Approve outage 2 A, B2 and C2".** ConfigHub stored
the approver's own words as the note on each approval.

**16:15:16. A is released, and the outage ends.** The lockdown was gone from
both US clusters and `web` was 2/2 by 16:16:19. Both were Healthy by 16:16:51.
But the stray policy from 15:32 refused Sveltos's own writes of the record's
profiles:

```
ClusterProfile shop-staging may not be written by system:serviceaccount:projectsveltos:projectsveltos
```

The outage still ended, because A had also emptied the ConfigMap the lockdown
came from. Angel stopped before B2, as its instructions said to on any refusal,
and reported "a stray binding ... created 15:32:26 by
`kubectl-client-side-apply`. It did not come from the record, and I do not know
who applied it."

**16:18:31. The approver decides:** publish B2, then C2, and delete the five
stray namespaces. The operator told Angel where the stray policy had come from:
its own previews, through a defect in the tool.

**16:19:20. B2 and C2.** Sveltos took the policy and binding into the record
(Healthy 16:20:02). Then C2 had the record delete the hand-applied profile and
its ConfigMap, under the new policy, at 16:20:33.

![A, B2 and C2 released; five orders aborted, each with its reason](images/r1-26-outage2-released.jpg)

**16:23. Devil tries again**: the lockdown once more, then a hand edit that
widens `shop-prod-eu` to `region=us`. Both profile writes were refused. (The
ConfigMap, which the policy does not cover, was created, and Devil deleted it.)

```
Error from server (Forbidden): clusterprofiles.config.projectsveltos.io "shop-prod-eu" is forbidden:
ValidatingAdmissionPolicy 'profiles-only-from-record' with binding 'profiles-only-from-record' denied request:
ClusterProfile shop-prod-eu may not be written by kubernetes-admin: profiles on the management cluster
come only from the record. Change a unit in the Space chaos-management and release it through the
workflow chaos-management/record.
```

![Devil, again: both writes refused](images/r1-o2-again.png)

What outage 2 showed:
- **The blast radius was visible at once.** Two of four clusters were Degraded
  and two were Healthy, so the selector was the suspect from the start.
- **A preview that says "unknown" needs another check.** Reading the token's
  subject and testing by impersonation caught a policy that would have stopped
  the record itself.
- **The preview tool had a defect.** Without a named sandbox, it used whatever
  cluster was current. This was fixed the same evening: since v0.12.1, `impact`
  and `check` refuse to run without a named sandbox, and refuse a cluster that
  runs workloads.

## Outage 3: staging said yes, prod said no

![Timeline of outage 3](images/r1-o3-timeline.png)

Devil plays ordinary people here. Every change goes through the workflow and is
put in front of the approver.

**16:29:01. On call, Devil cuts cost.** It lowered `api`'s memory limit from
128Mi to 40Mi in prod's class base only. Staging kept 128Mi, and nothing
declared the difference:

```bash
cub function set --space chaos-shop-class-prod --unit shop --change-desc "api: lower memory limit 128Mi -> 40Mi in prod to cut cost" \
  -o mutations --where-resource "metadata.name = 'api'" \
  set-string-path apps/v1/Deployment "spec.template.spec.containers.?name=api.resources.limits.memory" 40Mi
```

Opening the change order failed: "component ... not found". Devil worked around
it by naming the workflow by its ID in a JSON file. The cause turned out later
to be a missing grant: Devil had no View or Use on the component. One command it
ran with `--debug` printed its worker token into its transcript. It is redacted
in the published files, and the agents' instructions now forbid `--debug`.

**16:33. An order that shows no changes.** Devil said so in its own request:

> The change order shows as "no changes" in every space, although the prod
> units now hold 40Mi. ... Staging has not tested this.

The edit was made in the class base before the order was opened, so the order
carried it into prod as a prior revision. The prod units' diff shows it. The
order's own summary does not.

![Devil cuts prod's memory limit](images/r1-o3-devil.png)

**17:09:40. The approver: "Proceed".** Devil published the 40Mi limit to the
three prod clusters at 17:10:44. Prod ran at 40Mi, healthy.

**17:15. Devil, now a developer**, gave `api` a response cache of up to 32 MiB.
The change went through the same workflow, staging first.

![Before the cache's staging release: prod at 40Mi and one release behind; staging holding the cache, unreleased](images/r1-29-outage3-40mi.jpg)

**17:30 to 17:35. Staging says yes.** The approver approved the cache for
staging, and Devil released it at 17:30:59. Three minutes later `api` used 44.8
to 45.9 MiB under its 128Mi limit, Healthy. The prod approval was recorded only
after staging had run it Healthy.

**17:36:20. Prod says no.** The cache reached the three prod clusters, and
within two minutes `api` was OOMKilled at 40Mi:

```
api-57b477bd4d-sb268   0/1     OOMKilled           0          70s
api-57b477bd4d-9ql5v   0/1     OOMKilled           0          90s
```

Between kills the pods reported Ready, so ConfigHub's live status flapped
between Healthy and Degraded.

![Prod flapping: one cluster Degraded](images/r1-30-outage3-flapping.jpg)

**17:39:43. Angel starts.** It found `Reason: OOMKilled  Exit Code: 137` under a
40Mi limit in prod, while staging had run the same cache at 128Mi:

> Two changes each passed the workflow on their own and are fatal together.
> ... Staging tested the cache with 128Mi, so nothing compared prod with what
> staging had actually run.

The fix put prod back to 128Mi. Angel then checked it against what staging
runs, with the new parity check, which records a `ParityCheck` attestation:

```
$ cub-sveltos-chaos check --change-order chaos-shop-base/api-memory-limit-restore-128mi-prod --stage prod --parity-with staging --type ParityCheck
chaos-shop-prod-eu: passed shop/6; recorded a Pass (8050a153-...)
```

As the prevention, Angel proposed that prod's release also require a parity
check. That changes a gate, so Angel only wrote the command and asked the
approver to run it under their own login:

```bash
cub changeworkflow update rollout --space chaos-shop-base \
  --attestation-prerequisite approval --attestation-prerequisite parity \
  --attestation-prerequisite-type parity=ParityCheck --attestation-prerequisite-count parity=1 \
  --attestation-prerequisite-allow-authors parity=true --stage-release-prerequisites 'prod=approval;parity'
```

![Angel finds the OOMKills and restores the limit](images/r1-o3-angel.png)

**17:58. The fix and the gate.** The approver approved the fix ("Proceed").
Angel released it one prod cluster at a time, waiting each time for new pods,
2/2 and three minutes without a restart. The gate went in at 17:58:54, under the
approver's login. From then on, prod's release needs an approval and a
ParityCheck from Angel, the only checker. All three prod clusters were Healthy
at 18:09:37.

**18:12. Devil tries again: 96Mi in prod only**, undeclared, with no approval.
The publish was refused:

```
Failed: HTTP 422 ...: unable to publish a release of change order 'api-memory-limit-96mi-prod' in stage 'prod':
requires approval: 1 Approval attestation(s) from eligible attesters who did not write the change; shop revision 7 has 0 of 1;
requires parity: 1 ParityCheck attestation(s) from eligible attesters; shop revision 7 has 0 of 1
```

![Devil tries a prod-only limit again](images/r1-o3-devil96.png)

**18:15:51. The parity check, run as the checker**, failed on all three prod
Spaces. It named the field and recorded a rejection that holds the release:

```
chaos-shop-prod-eu: FAILED on shop/7; recorded a rejection (99815d50-...), which holds its release:
  - shop/7: Deployment shop/api spec.template.spec.containers[api].resources.limits.memory is "96Mi" here
    and "128Mi" in chaos-shop-staging, and no guard departure=<why> declares it
```

![The parity check refuses the change](images/r1-o3-check.png)

**18:17. Devil withdraws.** It aborted the order with its reason and restored the
units to 128Mi. ConfigHub still flagged the prod units "Unreleased changes" and
"Stale": it counts revisions, not content.

![After the withdrawal: Live, but flagged by a change that was withdrawn](images/r1-33-outage3-flags.jpg)

What outage 3 showed:
- **Each change was reasonable, and each was approved.** The cut saved cost on
  paper. The cache passed staging. Together they were fatal, because staging
  never ran prod's limit.
- **The approval gate alone could not catch it.** The parity check can: prod
  may differ from staging only where a guard `departure=<why>` says so.

## Evening: what the run turned into

- **18:44. `cub sveltos` v0.12.1 is released.** `impact` and `check` now refuse
  to run without a named sandbox, and refuse a cluster that runs workloads.
  (Issue #105, PR #106.)
- **20:04. A findings report goes to the ConfigHub team.** It lists eight
  items, each with a check anyone can rerun. They are in the to-do list below.
- **20:13. `cub sveltos` v0.13.0 is released**, with `demo/`: the parity
  check, named approvers, the first-policy preview, and `demo/` with every
  prompt and script, an agent approver (Milton) and a clean-up. (PR #107.)
- **Before publishing**, names were taken out of the transcripts and the
  evidence, and the token Devil's `--debug` printed was redacted.

## To do after the first run

As the list stood at the end of the run, with what became of each item by 4
October.

| To do | Why | What became of it |
| --- | --- | --- |
| Make `impact` and `check` refuse to guess a sandbox | One preview put a policy on the management cluster (outage 2) | Done: v0.12.1, the same evening |
| Ship the parity check and named approvers | Outage 3's prevention ran on a development build | Done: v0.13.0 |
| Let a reader run it all again, with an agent approver and a clean-up | So the claims can be checked, not taken on trust | Done: `demo/`, then [the verification run](verification-run.md) |
| Keep names out of the published record | The repository rule against personal names | Done before publishing |
| Revoke the token Devil's `--debug` printed | It was valid until 4 October, 11:02 | No command revokes a token or rotates a worker secret. It expires on 4 October at 11:02 UTC. The agents may no longer use `--debug` |
| Report what ConfigHub got wrong | The team asked for the findings | Done: 8 items in #product. Answers are in [the verification diary](verification-run.md#to-do-after-the-verification-run) |
| A change order whose own summary shows no changes | An edit made before the order rode into prod unseen (outage 3) | Reported. ConfigHub's answer: `cub changeorder get` does not show unit diffs, so read `cub unit diff` on each Space. The demo's approver now does |
| YAML changes a folded string's value | Blank lines were added inside a CEL expression at each hop (outage 1) | Reported. ConfigHub traced it to kustomize's YAML code, upstream |
| Workflow gates are edited in place, by whoever created them | An agent that creates a workflow can loosen its own gate | Reported. ConfigHub's answers: each change order keeps a copy of the workflow it ran under, and a newer `cub` can back a workflow with a unit that has revisions. Agents should not create the workflows that gate them |
| A worker with Edit cannot open a change order | Devil's "component not found" (outage 3) | Explained: opening a change order needs View and Use on the component. `setup/grant-agents.sh` grants them |
| Promotions cannot pass a clearance, so guards cannot protect prod-only fields | A guard would have blocked the very promotions it should allow | Fixed in ConfigHub v0.8.2, released 4 October: promote takes the options of a unit update. Not yet tried here |
| A write a guard withholds reports success | `cub` said "Successfully updated unit", exit 0 | ConfigHub: intended, with conflicts recorded on the revision. The v0.8.2 release notes add refusing guards a change is not cleared for. Not yet rechecked here |
| The plugin publishes the gated management record directly | Once the record is gated, the onboarding handover cannot publish it | Open. The demo gates the record after onboarding |
| Withdrawn changes leave "Unreleased changes" and "Stale" flags | ConfigHub counts revisions, not content | Open, not yet reported |
