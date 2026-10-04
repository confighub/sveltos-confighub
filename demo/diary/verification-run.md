# Diary of the verification run, 3 October 2026

The second run was made from [the demo's README](../README.md), step by step,
to check that a reader can repeat it. This time no person approved anything.
**Milton**, a third agent with its own ConfigHub identity, reviewed every
request and approved or refused it. Devil and Angel played their parts as
before. **The operator**, a Claude Code session acting for the person who ran
the demo, started each step from the scenarios.

Kind clusters stand in for production. All times are UTC. Versions:
`cub sveltos` v0.13.0 (installed from the release), `cub` v0.8.1, ConfigHub
server v0.8.1, Sveltos v1.15.0, kind v0.31.0, Claude Code 2.1.285 with
`claude-opus-5-5`.

ConfigHub's record of the run is in
[verification-2026-10-03.md](../recording/verification-2026-10-03.md). There
are no web UI screenshots of this run: the figures are drawn from the agents'
transcripts and ConfigHub's record. [The first run's diary](first-run.md)
has the screenshots.

**The outcome:**
- Milton made all 19 approvals, and nobody else made any.
- Outages 1 and 2 were fixed and prevented, and Devil's repeats were refused.
- In outage 3 Milton refused Devil's prod-only memory cut, so that outage
  never happened.

## Contents

- [Setup: seven minutes](#setup-seven-minutes)
- [Onboarding: Milton refuses until it can see](#onboarding-milton-refuses-until-it-can-see)
- [Outage 1: a rotation nobody picked up](#outage-1-a-rotation-nobody-picked-up)
- [Outage 2: half the fleet at once](#outage-2-half-the-fleet-at-once)
- [Outage 3: refused before it happened](#outage-3-refused-before-it-happened)
- [Close](#close)
- [To do after the verification run](#to-do-after-the-verification-run)

## Setup: seven minutes

**19:15 to 19:22.** The README's setup commands ran as written:

```bash
source demo/env.sh
node $DEMO/setup/kind-fleet.mjs        # chaos-mgmt and four workload clusters, Sveltos v1.15.0
bash $DEMO/setup/sandbox.sh            # the policy sandbox: Sveltos's CRDs, nothing running
bash $DEMO/setup/setup-shop.sh         # the shop and Reloader, delivered by plain Sveltos
bash $DEMO/setup/identities.sh         # devil, angel, reporter, milton
```

The shop's Secret and Deployments were created at 19:21:54, and Reloader was
up at 19:22:39. Milton is a ConfigHub worker with the viewer role. It can
approve only where it is granted to.

## Onboarding: Milton refuses until it can see

![Timeline of onboarding](images/r2-o0-timeline.png)

**19:47. The fleet comes under ConfigHub.** `setup/onboard.sh` ran
`cub sveltos` as Angel. It created a base, class bases and one variant per
cluster for the shop and the platform. It opened `chaos-shop-base/onboard-d244df9f`
and `chaos-platform-base/onboard-111745ae`, and stopped at staging.

**19:49. Milton's first review: it cannot read.** Milton had not yet been given
access to the new Spaces. It said so, and approved nothing:

> **Not approved.** I could not read what I was asked to approve, so I
> approved nothing.

**19:54. Milton can read now, and ConfigHub refuses its approval.** Milton
reviewed the change and decided to approve, but:

```
$ cub variant approve --change-order chaos-shop-base/onboard-d244df9f --stage staging --note "..."
Failed: HTTP 403 ... cannot use ChangeOrder; Use permission required: permission denied
```

> I did not try approving the Space directly instead: that would step around a
> permission set on this change order, and I was told to approve nothing else.
> (Milton)

Two things were missing. A Space has no `Approve` permission: an approver needs
`ApproveChildren`. Approving a change order also needs `Use` on it, so the
approver needs `UseChildren` too. `setup/grant-agents.sh` now grants both, and
the scenario runs it before the first approval.

**20:01 to 20:12. Milton approves, with notes that say what it checked.** For
staging, it read the unit in full, because a first release has nothing to diff
against. It compared the unit with what Sveltos delivers today and with the
live objects. Its note on the shop:

> First release, so no prior release to diff: read chaos-shop-staging/shop head
> (rev 2) in full; it is identical to its bases and to ConfigMap default/shop
> that ClusterProfile shop delivers today, and matches live objects in ns shop
> on staging (generation 1, 2/2 ready). No Secret in the unit.

For prod, it diffed each prod unit against what Sveltos delivers, using a
server dry run in the sandbox. To compare, it applied the shop's objects to the
sandbox, and it left them there. That came back to bite in outage 1.

![Milton reviews the shop's onboarding for prod](images/r2-onboard-milton.png)

**20:16:48. The handover.** The management record took over every delivery
profile, and nothing was reinstalled. The operator then granted the agents
their permissions again, set the gates and started the reporter. The gates:
- each component's rollout needs one approval from the person or Milton, and
  never from an author;
- the management record has a workflow of its own.

All nine Spaces were Synced and Healthy at 20:17:51.

## Outage 1: a rotation nobody picked up

![Timeline of outage 1](images/r2-o1-timeline.png)

**20:18:57. Devil rotates the token** on all four clusters, outside ConfigHub:

```bash
kubectl patch secret shop-token -n shop --type merge \
  -p "{\"stringData\":{\"token\":\"$(openssl rand -hex 16)\"}}" --context kind-chaos-staging
```

> The failure is in place: all four patches were accepted, and I stopped
> there. (Devil)

**20:19:49 to 20:21:07. ConfigHub sees it**, one cluster after another, with the
same message as in the first run:

```
ClusterHealthCheck chaos-shop: Deployment: shop/web status is Degraded Message: web: 0 of 2 available
```

**20:23:26. Angel opens the fix**: the same Reloader annotation on `web` as in
the first run, plus a one-time roll, as `chaos-shop-base/web-reload-on-token-rotation`.

**20:25. A transcript is lost.** The operator edited a script while that Angel
run was still using it, and the run's record came out empty. Bash reads a
script as it goes. A read-only recovery run checked the order again and
rewrote Angel's approval request:

> I have no record of the previous run, so I am starting from the live state.
> (Angel)

**20:29. The sandbox is refused.** Angel's first policy preview stopped:

```
Error: the cluster named as the sandbox runs shop/api, shop/web, so it is not a sandbox: its admission
policies would be replaced. Name a disposable cluster with no Deployment, StatefulSet or DaemonSet outside
kube-system and local-path-storage
```

Those were the objects Milton had left there at 20:08. Angel would not delete
things it had not made:

> Someone with rights on the sandbox must remove the stray shop objects from
> `chaos-policy-sandbox` (or give me another empty sandbox).

The operator emptied the sandbox. Milton's instructions now say to apply only
admission policies there, and `setup/sandbox.sh --reset` empties it.

**20:32. The policy, previewed.** Angel's policy, `secret-env-needs-reloader`,
has the same rule as the first run's: a Deployment that takes a Secret through
its environment must say how it picks up a rotation. Its known cases now number
12. The previews:

- **As the fleet runs now:** "4 newly denied", `web` on all four clusters.
- **With the fix as the next promotion:** "0 newly denied".

Angel asked for the fix to go first.

**20:37:12. Milton approves the fix for staging.** It did not take the request
on trust. It read the diff and saw `web` failing with 401s on staging. It
checked that Reloader runs with a role that lets it restart Deployments, and
that Sveltos would not undo that restart.

![Milton reviews the fix for staging](images/r2-o1-milton.png)

**20:38:05. Staging's release.** New `web` pods were ready 21 seconds later.
ConfigHub caught up at 20:40:14, after the same mid-rollout reading as in the
first run.

**20:42:57. Milton approves the policy for staging.** It ran the 12 known
cases as server dry runs in the sandbox. Every case gave the expected verdict.
It also confirmed whom Sveltos acts as on staging:

```bash
bash $DEMO/proof/token-subject.sh kind-chaos-mgmt projectsveltos staging-sveltos-kubeconfig kubeconfig
```

Its note named the risk: "rolling back the web fix is refused until this is
demoted first."

**20:46. Devil tries again, on staging.** Reloader restarted `web` on the
second rotation. The new pod failed its readiness check until `api`'s mounted
copy of the token refreshed, while the old pods kept serving: "the rollout is
stalled rather than the service being down." Then `web-copy` was refused:

```
ValidatingAdmissionPolicy 'secret-env-needs-reloader' with binding 'secret-env-needs-reloader' denied request:
Deployment web-copy takes a Secret through its environment (env secretKeyRef or envFrom secretRef) but does not
say how it picks up a rotation: annotate the Deployment with reloader.stakater.com/auto: "true", or with
secret.reloader.stakater.com/reload naming every such Secret
```

![Devil, again: the rotation is handled, the copy is refused](images/r2-o1-again.png)

**20:49 and 20:55. Milton approves prod**, the fix and then the policy. The
policy review was its longest: six minutes, eight of its own dry-run cases, and
the token subject on all four clusters. On its first preview it made a mistake
and said so:

> My mistake, cleaned up: on my first preview I named the `reloader` unit as
> the policies in force, and the tool applied that whole unit, so Reloader ran
> in the sandbox for about two minutes.

**20:56:38. Prod.** Angel published the fix to the three prod clusters. Each
`web` was ready about 28 seconds after its release, and then the policy
followed. All four clusters were Synced and Healthy at 20:58:32.

## Outage 2: half the fleet at once

![Timeline of outage 2](images/r2-o2-timeline.png)

**20:59:55. Devil applies the lockdown by hand** on the management cluster:
the ConfigMap with a deny-all NetworkPolicy, and the ClusterProfile
`shop-lockdown` for `region=us`. **21:00:47:** `prod-us-1` and `prod-us-2`
were Degraded, and staging and `prod-eu` stayed Healthy.

**21:01 to 21:11. Angel's fix and a different kind of policy.** The fix was the
same as in the first run: the record takes the stray profile over and empties
it. The policy was new. This time Angel judged a profile by its **shape**, not
by who sends it:

> A ClusterProfile that delivers anything must be named
> `<component>-<cluster>`, with one `clusterRef` to `projectsveltos/<cluster>`
> and no `clusterSelector` or `setRefs`. ... No identity exemption: the rule
> reads the object, not the sender, so it applies to Sveltos and cluster admins
> alike.

That removes the question that tripped the first run: which identity to
exempt. A profile that delivers nothing is allowed, so the record can take the
stray one over and empty it. Angel previewed 14 known cases: 10 denied and 4
allowed, all as expected.

Angel warned that the two orders could not be released apart, expecting the
fix's release to carry the policy too:

> Approving 1 is in effect approving both.

The server disagreed, as 21:20 shows.

![Angel finds the stray profile and proposes the fix](images/r2-o2-angel.png)

**21:14:45 and 21:18:56. Milton approves both.** For the fix, it dry-ran all
nine live record profiles and the emptied `shop-lockdown` against the policy in
the sandbox: all admitted, and the rogue profile denied. For the policy, it
applied only the policy to the sandbox, which its instructions now allow. It
then tried 13 off-shape profiles of its own, all denied, and emptied the
sandbox again. It also named a gap for later: `deploymentType`, `path` and
`templateResourceRefs` on a record-shaped profile are not pinned.

![Milton tests the policy in the sandbox](images/r2-o2-milton.png)

**21:20:00. The fix will not publish.**

```
$ cub release publish chaos-management --revision ChangeOrder:chaos-management/withdraw-shop-lockdown
Failed: HTTP 500 ...: no Revision found for Unit guardrails with the specified TagID f02d4f93-...
```

Angel had created the policy's unit after the fix's change order was cut, so
the unit had no revision at that order's end tag. `cub release publish --help`
says such a unit falls back to its head revision. The server returned a 500
instead. Angel stopped, and offered a choice:
- **Option 1, which Angel recommended:** publish the policy's order. It carries
  both units, and both were already approved.
- **Option 2:** move a tag on an order that was already approved.

**21:21:35. The operator chooses option 1**, inside the approvals Milton had
given, and logged it. One correction to the record: the operator's prompt to
Angel called this "the approver's decision". It wasn't. Milton approved both
orders, but did not choose between them.

**21:22:03. Released.** The policy landed on the management cluster, the record
emptied the stray profile, and the lockdown was withdrawn:

> From publish to all three spaces Healthy took about 1 minute 32 seconds.
> (Angel)

Angel aborted the fix's order with its reason. ConfigHub refused the first
wording because it held an apostrophe (HTTP 400).

**21:24 to 21:27. The clean-up.** Angel opened the clean-up as a third order
once the fix was in, as the scenario allows. Milton approved it after checking
that the live policy would not block Sveltos removing its finalizer. Sveltos
deleted the profile and its ConfigMap under the policy, 22 seconds after the
release.

**21:27:38 and 21:27:53. Devil tries again.** The lockdown and the widening of
`shop-prod-eu` were both refused, this time by the shape rule:

```
Error from server (Forbidden): clusterprofiles.config.projectsveltos.io "shop-prod-eu" is forbidden:
ValidatingAdmissionPolicy 'profiles-deliver-confighub-releases' with binding 'profiles-deliver-confighub-releases'
denied request: ClusterProfile shop-prod-eu must name its one cluster: a single clusterRef to the SveltosCluster
projectsveltos/<cluster>, no clusterSelector and no setRefs, and be named <component>-<cluster> for a component
of the record (shop, platform)
```

The policy covers profiles, not ConfigMaps, so Devil's ConfigMap was created,
and Devil deleted it as told.

![Devil, again: both writes refused](images/r2-o2-again.png)

## Outage 3: refused before it happened

![Timeline of outage 3](images/r2-o3-timeline.png)

**21:29:33. Devil cuts prod's memory limit**, on call and to save cost: `api`
at 40Mi in prod's class base only, as in the first run.

**21:30. Devil cannot open a change order.**

```
Failed: failed to fetch Component b7e44cae-...: component b7e44cae-... not found
```

> I did not go around this with raw API calls; it looks like access that
> `devil` has not been given. (Devil)

In the first run Devil had worked around this. Here it stopped. Opening a
change order needs View and Use on the component, and the operator granted
both. `setup/grant-agents.sh` now does. The operator also started Milton once
too early, on an order that did not exist yet. Milton found nothing to approve
and said so.

**21:36:04. The order reaches prod.** `chaos-shop-base/prod-api-memory-40mi`
was promoted to prod, and staging carried nothing for it. Devil's request said
so: "Staging: not changed, and it did not exercise this limit."

![Devil cuts prod's memory limit and asks for approval](images/r2-o3-devil.png)

**21:38. Milton refuses.** It checked the diff, one line in each prod unit. It
read `api`'s real memory from the kubelet, 12Mi at idle, because the clusters
have no metrics API. Then it said no:

> **Not approved.** I did not approve `chaos-shop-base/prod-api-memory-40mi`
> for stage `prod`, and I approved nothing else.
>
> 1. **The stated reason does not hold.** ... Lowering only the limit saves
>    nothing; it only lowers the point at which the pod is killed.
> 2. **The limit has never run anywhere.** ... Approval would put an
>    unexercised limit on all three prod clusters at once.
> 3. **I can only vouch for idle use.** 12Mi is a snapshot; I have no peak or
>    under-load figure.

Its fourth reason was that Devil's first report had called the change "outage
3" and "the failure". Devil's instructions now say to write requests as the
person it plays, without naming the exercise. Milton also said what would make
the change approvable: a true reason, the same limit run in staging first, and
a memory figure under load.

![Milton refuses the cut](images/r2-o3-milton.png)

**21:38 to 21:55. The run ends here.** The operator reported the refusal. The
person running the demo chose to end the run there, rather than approve the
cut by hand to stage the outage. So the cache, the OOMKill, the parity gate and
the parity check from the first run were not exercised again.

**21:55:50. Devil withdraws.** It aborted the order, giving Milton's reasons,
and restored the four units to 128Mi. Prod never ran 40Mi.

## Close

**ConfigHub's record of the run**, read with `cub` the next morning:

```
$ cub changeorder list --space chaos-shop-base
NAME                            STATE       ABORTED-REASON
prod-api-memory-40mi            Aborted     Not approved by the approvers agent (the limit change saves no cost, never ran in staging, ...
onboard-d244df9f                Released
web-reload-on-token-rotation    Released

$ cub changeorder list --space chaos-management
NAME                                              STATE       ABORTED-REASON
withdraw-shop-lockdown                            Aborted     Not published: its end tag could not be bundled into a release on its own. ...
guardrails-profiles-deliver-confighub-releases    Released
remove-shop-lockdown                              Released
```

(Columns trimmed.) The full record is
[verification-2026-10-03.md](../recording/verification-2026-10-03.md):
- **Approvals:** 19, each "Approval Pass by milton (Worker)" with its note.
  None was by a person.
- **Releases:** 19, every one published by Angel.
- **Change orders:** eight listed, six released and two aborted, each with its
  reason.

**The run in numbers.** It took about 2 hours 40 minutes from the first cluster
to the withdrawal. There were 34 agent runs, and their transcripts add up to
about $22.

**The clean-up.** `teardown.sh` deleted the kind clusters. It missed the
reporter, which was stopped by hand; `setup/reporter.sh` now finds it. The run's ConfigHub Spaces are deleted separately, with
`teardown.sh --confighub`.

## To do after the verification run

As of 4 October. This adds the ConfigHub team's answers in #product, and
ConfigHub v0.8.2 and v0.8.3, both released on 4 October.

| To do | Why | Where it stands |
| --- | --- | --- |
| Fold the run's lessons into `demo/` | Grants before approvals, an empty sandbox, every request in Milton's review, scripts that load `env.sh` | Done: PR #108 |
| Delete this run's 18 ConfigHub Spaces | The record is kept in [verification-2026-10-03.md](../recording/verification-2026-10-03.md) | Open, for the person who ran it: `bash demo/teardown.sh --confighub` |
| Report the HTTP 500 on publish | A unit created after an order's end tag breaks the publish, although the help promises a fallback to the head revision | Open, not yet reported |
| Report that an abort reason may not hold an apostrophe | HTTP 400 twice in one run, on ordinary English | Open, not yet reported |
| Answer the ConfigHub team's questions | They asked what was diffed in the "no changes" finding, and more detail was promised | Open. What was diffed: `cub unit diff` on each prod unit showed the edit, while `cub changeorder get` showed none |
| Have Milton's refusals leave a record in ConfigHub | A refusal now lives only in a transcript, and in the abort reason Devil wrote | Open: record a rejection, the way `cub sveltos check` does |
| Run outage 3 through to the parity gate on v0.13.0 | Milton's refusal meant the released parity check never ran in this run | Open: approve step 2 by hand to stage it |
| Recheck the demo on ConfigHub v0.8.3 and the next `cub` | Workers now default to no org role. The `cub worker` commands are going away in favour of service accounts, and `setup/identities.sh` depends on them | Open. The demo is pinned to v0.8.1 until then |
| Try the new ConfigHub features in the demo | Promote can pass a clearance, so a guard could protect a prod-only field. An approval rule can count a group's members. Live status can be written on the release | Open |
| Back the workflows with a unit that has revisions | So a gate edit has history, not only the copy each change order keeps | Open: `--with-backing-unit` in a newer `cub` |
| Publish a gated management record through a change order | Carried over from the first run | Open |
| Ask Sveltos about health checks taken mid-rollout | ConfigHub showed Degraded for one to two minutes after each recovery, because Sveltos recorded a reading of "1 of 2 updated" as a failure | Open, for the Sveltos maintainers |
| Pin the rest of a record-shaped profile in the outage 2 policy | Milton's review: `deploymentType`, `path` and `templateResourceRefs` are not checked | Open |
| Move to Sveltos v1.16.0 | CRDs first, a failure limit for health checks, redeploy on publish | Waiting: the release with its manifest is not out yet (issue #77) |
