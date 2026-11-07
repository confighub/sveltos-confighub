# Three outages we had on purpose

*A companion to the post
[No human in the loop? Agents manage a Sveltos fleet in ConfigHub](https://confighub.com/blog/no-human-in-the-loop-agents-manage-a-sveltos-fleet-in-confighub-178205600338). It tells
the whole story at a walking pace, and assumes you have not read anything else we have written.*

## Fleets fail in a few familiar ways

If you run more than a handful of Kubernetes clusters, you have met at least one of these.

Someone rotates a credential. The service that uses it reads the value once, when it starts,
and nobody tells it to read again. It keeps using the old one and starts failing, and the
configuration looks perfectly correct the whole time.

Someone makes one change and it lands on far more clusters than they expected. The change was
one line in one file. What decided how far it reached was something else entirely, and it was
not written down where anyone could see it.

A cluster is rebuilt from scratch, as security teams like them to be, and comes back missing
something it used to have. Usually something that was put there by hand, once, a long time ago,
by someone who has since left.

Most teams meet each of these exactly once, during an incident, at an unhelpful hour. The fix
goes in, the team gets a little wiser, and the knowledge lives in the heads of whoever was
awake. The next cluster, or the next team, meets it fresh.

## So we arranged to meet them on purpose

We built a small fleet and handed it to two AI agents.

The first agent is called Devil. Its job is to cause outages, and to cause them the way they
actually happen rather than the way a test would. It does not corrupt anything or delete
anything. It does ordinary, reasonable-looking things in slightly the wrong place.

The second agent is called Angel. Its job is to find out what happened, repair it, and then
write a rule that stops the same thing happening again.

A third agent, called Milton, can approve changes. So can you. The rule is that whoever wrote a
change is never allowed to approve it, which means Angel cannot wave its own work through.

Two pieces of software hold the fleet together, and between them they do three jobs: they run
the fleet, they keep it compliant, and they are what lets the agents work at all.

**Sveltos** delivers configuration from a management cluster out to the working clusters, and
watches whether what it delivered is healthy. **ConfigHub** holds the configuration itself, the
policies, and the record of every change and every approval.

The fleet is five Kubernetes clusters, local `kind` clusters standing in for production: one
management cluster, where Sveltos runs, one staging cluster and three production clusters.
What is running on it is a small web application we call the shop: two services, `api`
and `web`, both written in Python, plus one platform component that restarts pods when a secret
changes. None of what follows depends on the workload being an application, or being small. The
same arrangement carries platform components and GPU stacks, and there is a second example in
the same repository that takes an NVIDIA GPU operator fleet through it and upgrades the driver
on staging before production.

## The part that matters: who decides

An agent that fixes an outage and then tells you it fixed the outage has not proved anything.
So nothing either agent says counts as evidence. For each claim, something other than the agent
settles it.

| The claim | What settles it |
| --- | --- |
| Something broke | The clusters' own health checks, showing up in ConfigHub as live status |
| It is fixed | Health back to healthy, and the exact release that was delivered |
| The new rule is safe | A real Kubernetes API server, judging the rule against everything currently running |
| This may ship | An approval from a person, or from Milton, and never from the change's author |
| It cannot happen again | Devil tries again, the same fault or a way round it, and is refused |

That last row is the one to watch for. A prevention you have tested by attacking it is worth
more than a prevention you have reasoned about.

## Outage one, in full

Devil rotated the shop's API token on all four working clusters, directly in each cluster, the
way a secret store or a security team would. Nothing about that is wrong.

The `web` service reads the token once, at start-up, from its environment. It carried on with
the old value. Eighty-one seconds later ConfigHub's live status went from healthy to degraded
and named what had gone: `web: 0 of 2 available`. Nobody had to notice. The fleet said so
itself.

Angel traced it back to the rotation and proposed two separate changes.

The first was the repair. There is a well-known small tool, Stakater Reloader, that restarts
pods when a secret they use changes. Angel added the annotation that switches it on for `web`,
and asked for one restart now.

The second was the prevention, and it is the more interesting of the two. Angel wrote an
admission policy, which is a rule Kubernetes applies to every change before accepting it. The
rule says: a workload that takes a secret in through its environment has to say how it picks up
a rotation, or it is refused. Angel tested the rule against eleven known cases before proposing
it, from a workload that should obviously pass to the exact one that had just failed.

Both changes went to an approver, because everything does.

Then came the part worth watching. Devil rotated the token a second time. Reloader picked it up
and the shop stayed running. So Devil tried a different way in: it copied the old manifest into
a brand new deployment, without the annotation. The cluster refused to accept it and said why,
naming the policy. That refusal is in Devil's own transcript, which is a better piece of
evidence than anything we could write.

## Outage two, more briefly

Devil applied one delivery profile by hand on the management cluster. It selected clusters by a
label, `region=us`, and delivered a network policy that blocked the shop.

Two of the four clusters carry that label. The first went degraded fifty-six seconds after the
fault, and the second nineteen seconds after that. The other two stayed healthy. One
hand-applied object, written in one place, reaching exactly as far as its selector said and no
further than anyone could see.

Angel found a profile that no record held, took it over through ConfigHub, and proposed a rule:
delivery profiles come from the record, and a delivery profile names the single cluster it is
for. Devil tried twice more, and both attempts were refused.

## Outage three: a repave, and an honest note

The third outage is the one worth reading twice.

Security teams ask for three things, often called the three Rs: rotate your credentials often,
repave your servers from a known good state, and repair what is vulnerable quickly. Outage one
was a rotation. This one is a repave. Some large organisations rebuild their entire platform
several times a week under a standing approval, without telling the application teams, which is
the point of doing it.

So the clusters are rebuilt from nothing overnight. A real repave usually moves each cluster
onto newly hardened images as well. Ours come back on the same image, and neither of the
failures below depends on it. A cluster rebuilt from nothing should get everything back from its source of
truth.

Two things went wrong, and we found both while building it.

The first was silent, which makes it the most interesting failure in the whole exercise. Sveltos
delivered nothing to the rebuilt clusters. It still held its own record saying it had delivered
everything already, and nothing had told it the clusters were new. ConfigHub reads that record,
so live status went on saying healthy while production was empty.

The second was simpler, and not silent. When delivery did resume, the shop came back without its
token, because that token had been made by hand in each cluster and no release held it. The pods
said which Secret was missing, and live status went degraded.

The prevention here is not a cluster rule but a check ConfigHub runs on every change: everything
a workload uses must either be held in its release or be created by something in its release.
If it is not, the change does not ship.

**Where this one stands.** Outage three has been built and checked by hand, and the agents have
not yet run it end to end. The first two have been run twice, by the agents, and are recorded.

## Letting an agent approve

In the first run a person approved every change. In the second, nobody did: Milton made all
nineteen approvals. ConfigHub held it to the same rules as any approver: it refused Milton's
first approval, "Use permission required", until Milton was granted that permission.

Milton also refused one change. In an earlier version of outage three, since replaced by the
repave, Devil cut a memory limit in production alone, a limit staging had never run. Milton said
no: the limit had never run anywhere, and approving it would have put it on all three production
clusters at once. The person running the demo chose to end the run there, rather than approve
the cut by hand. Production never ran it.

So in the second run there was no person among the approvers. A person still set the rules and
named who may approve, a Claude Code session acting for that person started each step, and the
person decided when the run ended.

## Why not keep all this in Git

Two of the three preventions are ordinary Kubernetes admission policies, and a Git repository
could hold those as well as ConfigHub does.

The third, the repave check, is a check ConfigHub runs on every change before it releases
anything. And before any policy ships, it is previewed against each cluster's configuration at
the release that cluster runs, which ConfigHub records cluster by cluster. The preview judges
that configuration, not objects read back from the clusters, so something made by hand on a
cluster is not in it.

ConfigHub keeps the history around each policy: its revisions, each with a description and an
author, the change order that carried it, the approval with the approver's note, and the known
cases it was tested against, in a unit of their own.

The agents may change configuration, and may not change a workflow or a check. What holds them
to that is the program that runs them, which refuses those commands, and the sandbox it runs
them in.

## What the fleet keeps

Three outages, three rules, and each rule sits in the record with the outage that caused it, the
cases it was tested against, and who approved it.

The second run took about two hours and forty minutes, thirty-four agent sessions, and around
twenty-two dollars of model time. Agents are slower than you expect. One release to three
clusters, done one at a time, took thirteen minutes.

## What this is and is not

The story is set in production, and the recording is a fleet of local `kind` clusters standing
in for one. The agents' notes and requests are published exactly as they wrote them. Everything
here runs on one machine, and you can run all of it yourself.
