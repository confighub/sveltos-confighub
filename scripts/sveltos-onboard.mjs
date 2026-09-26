#!/usr/bin/env node
// Onboard a Sveltos fleet into ConfigHub from what Sveltos already knows.
//
//   plan   Reads ClusterProfiles and the SveltosClusters they select, either
//          the YAML you wrote or `kubectl get clusterprofiles,sveltosclusters
//          -A -o yaml`, and shows the fleet ConfigHub would govern: one base
//          per profile, and one variant per cluster it selects, addressed to
//          that one cluster. Offline: no account, no cluster, nothing changes.
//
//   apply  Writes the plan as files beside one script of cub and kubectl
//          steps. Nothing runs until you run the script.
//
// Usage:
//   node scripts/sveltos-onboard.mjs plan  <input.yaml|-> [options]
//   node scripts/sveltos-onboard.mjs apply <input.yaml|-> --out <dir> [options]
//
// Options:
//   --stage-label <key> --stages <a,b,...>   roll out in stages, in this order,
//                                            by the value of this cluster label
//   --prefix <name>                          prefix for everything created in
//                                            ConfigHub (default: sveltos)
//   --management <namespace>/<name>         the management cluster, if it is
//                                            not registered as mgmt/mgmt
//   --profiles <a,b,...>                     onboard only these profiles

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { check, parseDocs, repoRoot, sha256 } from "./lib/proof-common.mjs";
import { writeStoredDocuments } from "./lib/per-cluster-fleet.mjs";
import { addressedStructurally } from "./verify-per-cluster-model.mjs";

const UNIT = "clusterprofile";
const WORKFLOW = "rollout";
const WORKER = "server-worker";
const DEFAULT_STAGE = "fleet";
const GATEWAY_HOST = "oci.hub.confighub.com";
const RELEASE_TAG = "latest";
const FETCH_INTERVAL = "1m0s";
const MINIMUM_SVELTOS = "v1.14.0";
// One gateway Secret per Targets Space: the gateway lets a Target's own worker
// pull its releases and refuses any other worker, so two onboardings that
// shared a Secret would lock one of them out.
const GATEWAY_SECRET = {
  namespace: "projectsveltos",
  type: "addons.projectsveltos.io/cluster-profile",
};
const gatewaySecretName = (targetsSpace) => `confighub-${targetsSpace}`;
const CLUSTER_REF_API = {
  SveltosCluster: "lib.projectsveltos.io/v1beta1",
  Cluster: "cluster.x-k8s.io/v1beta1",
};
const EXAMPLE_DIR = join(repoRoot, "examples/onboard");
const EXAMPLE_INPUT = join(EXAMPLE_DIR, "my-fleet.yaml");
const EXAMPLE_ARGS = ["--stage-label", "env", "--stages", "staging,prod"];
const EXAMPLE_PLAN = join(EXAMPLE_DIR, "plan.txt");
const EXAMPLE_APPLY = join(EXAMPLE_DIR, "apply");

// ---------------------------------------------------------------------------
// Reading what Sveltos knows
// ---------------------------------------------------------------------------

function flatten(docs) {
  return docs.flatMap((doc) => (doc?.kind === "List" ? flatten(doc.items ?? []) : [doc]));
}

function isClusterKind(doc) {
  return doc?.kind === "SveltosCluster"
    || (doc?.kind === "Cluster" && String(doc.apiVersion ?? "").startsWith("cluster.x-k8s.io/"));
}

function clusterOf(doc) {
  return {
    kind: doc.kind,
    namespace: doc.metadata?.namespace ?? "default",
    name: doc.metadata?.name,
    labels: doc.metadata?.labels ?? {},
    key: `${doc.kind}:${doc.metadata?.namespace ?? "default"}/${doc.metadata?.name}`,
  };
}

// Kubernetes label-selector semantics, the ones Sveltos evaluates a
// ClusterProfile's clusterSelector with.
export function selects(selector, labels) {
  const matchLabels = selector?.matchLabels ?? {};
  const matchExpressions = selector?.matchExpressions ?? [];
  for (const [key, value] of Object.entries(matchLabels)) {
    if (labels[key] !== value) return false;
  }
  for (const { key, operator, values = [] } of matchExpressions) {
    const has = Object.prototype.hasOwnProperty.call(labels, key);
    if (operator === "In" && !(has && values.includes(labels[key]))) return false;
    if (operator === "NotIn" && has && values.includes(labels[key])) return false;
    if (operator === "Exists" && !has) return false;
    if (operator === "DoesNotExist" && has) return false;
    if (!["In", "NotIn", "Exists", "DoesNotExist"].includes(operator)) {
      throw new Error(`unknown selector operator ${operator}`);
    }
  }
  return true;
}

function describeSelector(selector) {
  const parts = [
    ...Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(selector?.matchExpressions ?? []).map(({ key, operator, values = [] }) =>
      (["Exists", "DoesNotExist"].includes(operator)
        ? `${operator === "Exists" ? "" : "!"}${key}`
        : `${key} ${operator} [${values.join(", ")}]`)),
  ];
  return parts.join(", ");
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// What the base keeps from a live or written profile: its spec without the
// addressing, and none of what the API server or Sveltos wrote back.
function baseOf(profile) {
  const { clusterSelector, clusterRefs, setRefs, ...rest } = profile.spec ?? {};
  const metadata = { name: `${profile.metadata.name}-base` };
  if (profile.metadata.labels && Object.keys(profile.metadata.labels).length > 0) {
    metadata.labels = { ...profile.metadata.labels };
  }
  return {
    apiVersion: profile.apiVersion ?? "config.projectsveltos.io/v1beta1",
    kind: "ClusterProfile",
    metadata,
    spec: { clusterRefs: [], ...rest },
  };
}

// The profile as its owner described it, without what the API server or
// Sveltos wrote back, kept so the fleet can be planned again later.
function sourceOf(profile) {
  const metadata = { name: profile.metadata.name };
  if (profile.metadata.labels && Object.keys(profile.metadata.labels).length > 0) {
    metadata.labels = { ...profile.metadata.labels };
  }
  return {
    apiVersion: profile.apiVersion ?? "config.projectsveltos.io/v1beta1",
    kind: "ClusterProfile",
    metadata,
    spec: profile.spec ?? {},
  };
}

function clusterRef(cluster) {
  return {
    apiVersion: CLUSTER_REF_API[cluster.kind],
    kind: cluster.kind,
    namespace: cluster.namespace,
    name: cluster.name,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export function planFleet(inputDocs, options = {}) {
  const prefix = slug(options.prefix ?? "sveltos");
  const stageLabel = options.stageLabel ?? null;
  const stageOrder = stageLabel ? options.stages ?? [] : [DEFAULT_STAGE];
  const problems = [];
  const notes = [];
  const docs = flatten(inputDocs).filter(Boolean);

  // A later input wins, so a fresh cluster list can be given after the file
  // that first described the fleet.
  const clusters = [...new Map(docs.filter(isClusterKind).map(clusterOf).map((c) => [c.key, c])).values()];
  const allProfiles = [...new Map(docs.filter((doc) => doc.kind === "ClusterProfile")
    .map((doc) => [doc.metadata?.name, doc])).values()];
  const delivered = allProfiles.filter(deliveredByConfigHub);
  const wanted = options.profiles ? new Set(options.profiles) : null;
  const profiles = allProfiles.filter((doc) => !delivered.includes(doc)
    && (!wanted || wanted.has(doc.metadata?.name)));
  for (const name of wanted ?? []) {
    if (!allProfiles.some((doc) => doc.metadata?.name === name)) {
      problems.push(`--profiles names ${name}, but no ClusterProfile of that name is in the input`);
    }
  }
  if (delivered.length > 0) {
    notes.push(`${delivered.length} profile(s) already come from ConfigHub and are left as they are: ${delivered.map((d) => d.metadata?.name).join(", ")}.`);
  }
  const namespaced = docs.filter((doc) => doc.kind === "Profile");
  if (namespaced.length > 0) {
    notes.push(`${namespaced.length} namespaced Profile(s) left as they are: ${namespaced.map((d) => d.metadata?.name).join(", ")}. This first version onboards ClusterProfiles.`);
  }
  if (stageLabel && stageOrder.length === 0) {
    problems.push(`--stage-label ${stageLabel} needs --stages to say the order, for example --stages staging,prod`);
  }

  const managementKey = options.management
    ? `SveltosCluster:${options.management}`
    : "SveltosCluster:mgmt/mgmt";
  const management = clusters.find((c) => c.key === managementKey);
  if (!management) {
    problems.push(options.management
      ? `no SveltosCluster ${options.management} in the input; --management names the management cluster as <namespace>/<name>`
      : "no management cluster in the input: Sveltos registers it as mgmt/mgmt, or name yours with --management <namespace>/<name>");
  }

  // One Target per cluster, named for it. Two clusters of the same name in
  // different namespaces keep the namespace in the name.
  const nameCounts = new Map();
  for (const c of clusters) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  const targetOf = (c) => slug(nameCounts.get(c.name) > 1 ? `${c.namespace}-${c.name}` : c.name);

  const targetsSpace = `${prefix}-targets`;
  const onboarded = [];
  const skipped = [];
  const profileNames = new Set(profiles.map((p) => p.metadata?.name));

  for (const profile of [...profiles].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const name = profile.metadata.name;
    const spec = profile.spec ?? {};
    if (spec.setRefs?.length) {
      skipped.push({ name, reason: "selects through ClusterSets, which choose clusters at delivery time; list the clusters with clusterRefs or labels instead" });
      continue;
    }
    const selector = spec.clusterSelector;
    if (madeByEvents(profile)) {
      skipped.push({ name, reason: "was made by Sveltos's event framework, which changes its scope when something happens; govern the EventTrigger that makes it instead" });
      continue;
    }
    if (selector && !selectorGiven(selector)) {
      skipped.push({ name, reason: "has an empty clusterSelector; say which clusters it is for with labels or clusterRefs" });
      continue;
    }
    const resolution = resolveMatches(profile, clusters);
    const { matched, byRef } = resolution;
    for (const key of resolution.missing) {
      problems.push(`${name} ${resolution.fromStatus ? "reaches" : "names"} ${key.replace(/^[^:]+:/, "")}, but no such cluster is in the input; export the SveltosClusters too`);
    }
    if (resolution.differs.length > 0) {
      notes.push(`${name}: Sveltos records it reaching a different set of clusters than its selector gives today (${resolution.differs.join(", ")}); the plan follows Sveltos's record.`);
    }
    if (matched.length === 0) {
      skipped.push({ name, reason: "selects no cluster today, so there is nothing to govern yet" });
      continue;
    }

    const component = `${prefix}-${slug(name)}`;
    const baseSpace = `${component}-base`;
    const base = baseOf(profile);
    const dependsOn = spec.dependsOn ?? [];
    const variants = [];
    for (const cluster of matched) {
      const stage = stageLabel ? cluster.labels[stageLabel] : DEFAULT_STAGE;
      if (stageLabel && !stageOrder.includes(stage)) {
        problems.push(`${cluster.name} is selected by ${name} but its ${stageLabel} label is ${stage === undefined ? "missing" : `"${stage}"`}, which is not one of the stages (${stageOrder.join(", ")})`);
        continue;
      }
      const target = targetOf(cluster);
      const doc = structuredClone(base);
      doc.metadata.name = `${name}-${target}`;
      doc.spec.clusterRefs = [clusterRef(cluster)];
      const departures = ["metadata.name", "spec.clusterRefs"];
      if (dependsOn.length > 0) {
        const unmet = dependsOn.filter((dep) => !profileNames.has(dep)
          || !matchedBy(profiles.find((p) => p.metadata.name === dep), clusters).some((c) => c.key === cluster.key));
        if (unmet.length > 0) {
          problems.push(`${name} depends on ${unmet.join(", ")}, which the input does not onboard for ${cluster.name}; onboard them together`);
        }
        doc.spec.dependsOn = dependsOn.map((dep) => `${dep}-${target}`);
        departures.push("spec.dependsOn");
      }
      const edits = [
        `.metadata.name = ${JSON.stringify(doc.metadata.name)}`,
        `.spec.clusterRefs = [${JSON.stringify(doc.spec.clusterRefs[0])}]`,
        ...(doc.spec.dependsOn ? [`.spec.dependsOn = ${JSON.stringify(doc.spec.dependsOn)}`] : []),
      ];
      variants.push({
        departExpression: edits.join(" | "),
        cluster: cluster.name,
        clusterKey: cluster.key,
        labels: cluster.labels,
        stage,
        target,
        space: `${component}-${target}`,
        profileName: doc.metadata.name,
        departures,
        doc,
      });
    }
    variants.sort((a, b) =>
      stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) || a.cluster.localeCompare(b.cluster));
    const stages = stageOrder.filter((s) => variants.some((v) => v.stage === s));
    // The first release goes through a change order named for the set of
    // variants it releases. Re-running with the same fleet finds it finished;
    // a cluster that joined makes a new set, and a new change order releases
    // the newcomer while every other variant has nothing new.
    const releaseOrder = `onboard-${sha256(variants.map((v) => v.space).sort().join("\n")).slice(0, 8)}`;
    onboarded.push({
      name,
      source: sourceOf(profile),
      live: Boolean(profile.metadata?.uid || profile.status),
      selector: selectorGiven(selector) ? describeSelector(selector) : null,
      clusterRefs: [...byRef].length,
      component,
      baseSpace,
      base,
      stages,
      variants,
      releaseOrder,
      workflowText: workflowText(stages),
    });
  }

  const governedKeys = new Set(onboarded.flatMap((p) => p.variants.map((v) => v.clusterKey)));
  const ungoverned = clusters.filter((c) => !governedKeys.has(c.key) && c.key !== management?.key);

  const managementPlan = management
    ? {
      cluster: management.name,
      namespace: management.namespace,
      target: targetOf(management),
      component: `${prefix}-management`,
      space: `${prefix}-management`,
      byProfile: onboarded.map((p) => ({
        profile: p.name,
        unit: `bootstrap-${slug(p.name)}`,
        profiles: p.variants.map((v) => bootstrapProfile(v, management, gatewaySecretName(targetsSpace))),
      })),
    }
    : null;

  const targets = [
    ...new Map([
      ...onboarded.flatMap((p) => p.variants.map((v) => [v.target, v.cluster])),
      ...(management ? [[targetOf(management), management.name]] : []),
    ]).entries(),
  ].map(([target, cluster]) => ({ target, cluster })).sort((a, b) => a.target.localeCompare(b.target));

  const spaces = [
    targetsSpace,
    ...onboarded.flatMap((p) => [p.baseSpace, ...p.variants.map((v) => v.space)]),
    ...(managementPlan ? [managementPlan.space] : []),
  ];
  const duplicates = spaces.filter((s, i) => spaces.indexOf(s) !== i);
  for (const space of new Set(duplicates)) {
    problems.push(`two things would share the Space name ${space}; rename one of the clusters or profiles, or pass --prefix`);
  }
  for (const space of spaces.filter((s) => s.length > 63)) {
    problems.push(`${space} is longer than 63 characters; pass a shorter --prefix`);
  }

  const live = onboarded.some((p) => p.live);
  return {
    prefix,
    stageLabel,
    stageOrder,
    targetsSpace,
    targets,
    profiles: onboarded,
    skipped,
    ungoverned,
    management: managementPlan,
    live,
    notes,
    problems,
  };
}

// A bootstrap profile reads a Space from the ConfigHub gateway. A profile it
// delivered carries ConfigHub's origin annotation, and Sveltos records the
// gateway reference it came from. Both are ConfigHub's already.
function deliveredByConfigHub(doc) {
  const gateway = `oci://${GATEWAY_HOST}/`;
  const annotations = doc.metadata?.annotations ?? {};
  const readsGateway = (doc.spec?.policyRefs ?? []).some((ref) =>
    String(ref?.remoteURL?.url ?? "").startsWith(gateway));
  return readsGateway
    || annotations["confighub.com/origin"] !== undefined
    || String(annotations["projectsveltos.io/reference-name"] ?? "").startsWith(gateway);
}

const refKey = (ref) => `${ref.kind}:${ref.namespace ?? "default"}/${ref.name}`;

function selectorGiven(selector) {
  return Boolean(selector && (Object.keys(selector.matchLabels ?? {}).length > 0
    || (selector.matchExpressions ?? []).length > 0));
}

// Which clusters a profile reaches today. A live profile carries Sveltos's
// own answer in status.matchingClusters, which is used as it stands; a
// written one is evaluated here with Sveltos's selector semantics.
function resolveMatches(profile, clusters) {
  const spec = profile?.spec ?? {};
  const byRef = new Set((spec.clusterRefs ?? []).map(refKey));
  const evaluated = clusters.filter((c) =>
    (selectorGiven(spec.clusterSelector) && selects(spec.clusterSelector, c.labels)) || byRef.has(c.key));
  const recorded = profile?.status?.matchingClusters;
  if (!Array.isArray(recorded)) return { matched: evaluated, byRef, missing: [...byRef].filter((k) => !clusters.some((c) => c.key === k)), fromStatus: false, differs: [] };
  const recordedKeys = new Set(recorded.map(refKey));
  const matched = clusters.filter((c) => recordedKeys.has(c.key));
  const differs = [...new Set([...recordedKeys, ...evaluated.map((c) => c.key)])]
    .filter((k) => recordedKeys.has(k) !== evaluated.some((c) => c.key === k))
    .map((k) => k.replace(/^[^:]+:/, ""));
  return { matched, byRef, missing: [...recordedKeys].filter((k) => !clusters.some((c) => c.key === k)), fromStatus: true, differs };
}

function matchedBy(profile, clusters) {
  return resolveMatches(profile, clusters).matched;
}

// Sveltos's event framework creates profiles when something happens, so their
// scope changes by itself; the template that makes them is what to govern.
function madeByEvents(doc) {
  const owners = doc.metadata?.ownerReferences ?? [];
  const labels = Object.keys(doc.metadata?.labels ?? {});
  return owners.some((o) => /^Event(Trigger|BasedAddOn)$/.test(o?.kind ?? ""))
    || labels.some((l) => /event-?trigger/i.test(l));
}

// Each variant's Space reaches its cluster through one profile on the
// management cluster that fetches the Space's latest release from the
// ConfigHub gateway. Publishing a release moves the tag; Sveltos follows.
function bootstrapProfile(variant, management, secretName) {
  return {
    apiVersion: "config.projectsveltos.io/v1beta1",
    kind: "ClusterProfile",
    metadata: { name: `confighub-${variant.space}` },
    spec: {
      clusterRefs: [clusterRef({ kind: "SveltosCluster", namespace: management.namespace, name: management.name })],
      policyRefs: [{
        deploymentType: "Remote",
        remoteURL: {
          url: `oci://${GATEWAY_HOST}/space/${variant.space}:${RELEASE_TAG}`,
          interval: FETCH_INTERVAL,
          secretRef: { name: secretName, namespace: GATEWAY_SECRET.namespace },
        },
      }],
    },
  };
}

// Every stage's releases wait for one approval of the change as it stands
// there, and every stage after the first waits until the stage ahead has
// released it.
function workflowText(stages) {
  const lines = [
    "# The order a change moves through this profile's clusters, and what each",
    "# stage waits for. ConfigHub enforces both on the server.",
    "#",
    "# AllowAuthors: true lets the person who promoted a change also approve it,",
    "# which one person trying this needs. Set it to false once a second person",
    "# approves: ConfigHub then refuses an approval from the change's author.",
    "AttestationPrerequisites:",
    "  - Name: approval",
    "    Type: Approval",
    "    Count: 1",
    "    AllowAuthors: true",
    "Stages:",
  ];
  stages.forEach((stage, index) => {
    lines.push(`  - Name: ${stage}`);
    lines.push(`    WhereSpace: "Labels.Stage = '${stage}'"`);
    if (index > 0) lines.push("    Prerequisites:", "      - Released");
    lines.push("    ReleasePrerequisites:", "      - approval");
  });
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Showing it
// ---------------------------------------------------------------------------

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderPlan(plan) {
  const out = [];
  const variants = plan.profiles.reduce((n, p) => n + p.variants.length, 0);
  const clusters = new Set(plan.profiles.flatMap((p) => p.variants.map((v) => v.clusterKey))).size;
  out.push(`Onboarding plan: ${count(plan.profiles.length, "profile")} over ${count(clusters, "cluster")}, one variant per cluster per profile (${count(variants, "variant")}).`);
  out.push("Nothing has changed. This is what ConfigHub would hold.");
  for (const profile of plan.profiles) {
    out.push("");
    const how = [
      profile.selector ? `selects ${profile.selector}` : null,
      profile.clusterRefs ? `names ${profile.clusterRefs} cluster${profile.clusterRefs === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join("; ");
    out.push(`${profile.name}  (${how})`);
    out.push(`  base     ${profile.baseSpace}  reaches no cluster: clusterRefs is empty`);
    for (const stage of profile.stages) {
      out.push(`  stage ${stage}`);
      for (const v of profile.variants.filter((row) => row.stage === stage)) {
        out.push(`    ${v.cluster.padEnd(12)} variant ${v.space}  ->  Target ${plan.targetsSpace}/${v.target}`);
        out.push(`    ${"".padEnd(12)} differs from the base in ${v.departures.join(", ")}`);
      }
    }
  }
  if (plan.management) {
    out.push("");
    out.push(`Management cluster ${plan.management.namespace}/${plan.management.cluster}`);
    const count = plan.management.byProfile.reduce((n, b) => n + b.profiles.length, 0);
    out.push(`  record   ${plan.management.space}  one bootstrap profile per variant (${count}), fetching its release from the gateway`);
  }
  if (plan.ungoverned.length > 0 || plan.skipped.length > 0) {
    out.push("");
    out.push("Not onboarded");
    for (const c of plan.ungoverned) out.push(`  cluster ${c.name}: no profile selects it`);
    for (const s of plan.skipped) out.push(`  profile ${s.name}: ${s.reason}`);
  }
  out.push("");
  out.push("In ConfigHub");
  out.push(`  ${count(plan.targets.length, "Target")} in ${plan.targetsSpace}, one per cluster, on a server-hosted worker`);
  out.push(`  ${count(plan.profiles.length, "component")}, each one base, ${count(variants, "variant")}, 1 management record`);
  const spaceCount = 1 + plan.profiles.reduce((n, p) => n + 1 + p.variants.length, 0) + (plan.management ? 1 : 0);
  out.push(`  ${count(spaceCount, "Space")} and ${count(variants, "Link")}, one tying each variant to its base (check your organization's quotas for both first)`);
  out.push(`  first rollout: ${plan.profiles.map((p) => `${p.name} in ${p.stages.length} stage${p.stages.length === 1 ? "" : "s"}`).join(", ")}; one approval per stage, one release per variant`);
  for (const note of plan.notes) {
    out.push("");
    out.push(`Note: ${note}`);
  }
  if (plan.live) {
    out.push("");
    out.push(`Live on your management cluster: ${plan.profiles.filter((p) => p.live).map((p) => p.name).join(", ")}. Each variant's profile deploys the same add-ons to the same cluster, and Sveltos lets one profile manage a release at a time, so the per-cluster profiles wait until the live one steps aside. apply also writes takeover.sh, which hands each release over without reinstalling it; run it after apply.sh. See "If your profiles are live" in docs/user/onboard-your-sveltos-fleet.md.`);
  }
  if (plan.problems.length > 0) {
    out.push("");
    out.push("Fix these before apply:");
    for (const p of plan.problems) out.push(`  - ${p}`);
  } else {
    out.push("");
    out.push("Next: npm run onboard -- apply <the same input and options> --out <dir>, read <dir>/apply.sh, then run it.");
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

function q(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

function line(...words) {
  return words.map(q).join(" ");
}

export function applyScript(plan) {
  const L = [];
  const profilesWord = plan.profiles.map((p) => p.name).join(", ");
  L.push("#!/usr/bin/env bash");
  L.push(`# Onboard ${profilesWord} into ConfigHub: one variant per cluster per profile.`);
  L.push("# Written by `npm run onboard -- apply`. Read it, then run it:");
  L.push("#");
  L.push("#   MGMT_CONTEXT=<kubectl context of your management cluster> bash apply.sh");
  L.push("#");
  L.push("# cub uses its current context; set CUB_CONTEXT to choose another.");
  L.push("# Steps 1 to 4 only create records in ConfigHub. Step 5 is the first release:");
  L.push("# each stage is promoted, approved, released. All of it is safe to re-run,");
  L.push("# which is also how a cluster that joined since gets its variants.");
  L.push("# Step 6 is the one change to your management cluster: a Secret holding the");
  L.push("# gateway credential, and one bootstrap profile per variant.");
  L.push("set -euo pipefail");
  L.push('cd "$(dirname "$0")"');
  L.push('k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }');
  L.push("step() { printf '\\n== %s\\n' \"$*\"; }");
  L.push("# Re-running picks up where ConfigHub says each first release stands: a");
  L.push("# finished change order is skipped, and a variant with nothing new is kept.");
  L.push("# A cluster that joined since makes a new change order, which releases it.");
  L.push("rolled_out() { [ \"$(cub changeorder get --space \"${1%/*}\" \"${1#*/}\" -o jq=.ChangeOrder.Stage)\" = Completed ]; }");
  L.push("# A variant takes its departures once, as a fresh clone (an empty revision,");
  L.push("# then the clone), and they touch only their own fields, so the clone keeps");
  L.push("# everything the base holds today. Later revisions are changes made in");
  L.push("# ConfigHub, which a re-run leaves alone.");
  L.push("depart() {");
  L.push(`  if [ "$(cub unit get --space "$1" ${UNIT} -o jq=.Unit.HeadRevisionNum)" -le 2 ]; then`);
  L.push(`    cub function set --space "$1" --unit ${UNIT} --change-desc "$3" --quiet -- set-yq "$2"`);
  L.push("  else");
  L.push("    echo \"$1 already has its departures\"");
  L.push("  fi");
  L.push("}");
  L.push("publish() {");
  L.push("  local out");
  L.push("  out=$(cub release publish \"$1\" --revision \"ChangeOrder:$2\" --quiet 2>&1) && return 0");
  L.push("  case \"$out\" in *\"no changes were made since :latest bundle\"*) echo \"$1 already released\" ;; *) echo \"$out\" >&2; return 1 ;; esac");
  L.push("}");
  L.push("");
  L.push("step \"0/6 Check before changing anything\"");
  L.push("cub space list --quiet >/dev/null || { echo \"cub is not logged in: run cub auth login\"; exit 1; }");
  L.push("image=$(k get deployment addon-controller -n projectsveltos -o jsonpath='{.spec.template.spec.containers[0].image}')");
  L.push("version=${image##*:}");
  L.push(`if [ "$(printf '%s\\n' ${MINIMUM_SVELTOS} "$version" | sort -V | head -1)" != ${MINIMUM_SVELTOS} ]; then`);
  L.push(`  echo "the management cluster runs addon-controller $version; ConfigHub's gateway serves gzipped layers, which Sveltos reads from ${MINIMUM_SVELTOS}"; exit 1`);
  L.push("fi");
  L.push("");
  L.push(`step "1/6 One named Target per cluster, in ${plan.targetsSpace}"`);
  L.push(line("cub", "space", "create", plan.targetsSpace, "--allow-exists", "--quiet"));
  L.push(line("cub", "worker", "create", "--space", plan.targetsSpace, WORKER, "--filename", "worker.json", "--allow-exists", "--quiet"));
  for (const t of plan.targets) {
    L.push(line("cub", "target", "create", t.target, "{}", WORKER, "--space", plan.targetsSpace, "--provider", "OCI", "--toolchain", "Any", "--allow-exists", "--quiet"));
  }
  L.push("");
  L.push("step \"2/6 One component, one base and one rollout workflow per profile\"");
  for (const p of plan.profiles) {
    L.push(line("cub", "component", "create", p.component, "--allow-exists", "--quiet"));
    L.push(line("cub", "space", "create", p.baseSpace, "--component", p.component, "--allow-exists", "--quiet"));
    L.push(line("cub", "unit", "create", "--space", p.baseSpace, UNIT, `${p.name}/base.yaml`, "--change-desc", `Onboard ${p.name} from its ClusterProfile: the shared base`, "--allow-exists", "--quiet"));
    L.push(line("cub", "changeworkflow", "create", "--space", p.baseSpace, WORKFLOW, "--filename", `${p.name}/change-workflow.yaml`, "--allow-exists", "--quiet"));
  }
  L.push("");
  L.push("step \"3/6 One variant per cluster, addressed to that cluster alone\"");
  for (const p of plan.profiles) {
    for (const v of p.variants) {
      L.push(line("cub", "variant", "create", v.cluster, p.baseSpace, "--stage", v.stage, "--space-pattern", `template:${v.space}`, "--target", `${plan.targetsSpace}/${v.target}`, "--allow-exists", "--quiet"));
      L.push(line("depart", v.space, v.departExpression, `Depart from the base for ${v.cluster}: ${v.departures.join(", ")}`));
    }
  }
  if (plan.management) {
    const m = plan.management;
    L.push("");
    L.push("step \"4/6 The management cluster's record: its bootstrap profiles\"");
    L.push(line("cub", "component", "create", m.component, "--allow-exists", "--quiet"));
    L.push(line("cub", "space", "create", m.space, "--component", m.component, "--allow-exists", "--quiet"));
    for (const b of m.byProfile) {
      L.push(line("cub", "unit", "create", "--space", m.space, b.unit, `management/${b.profile}.yaml`, "--target", `${plan.targetsSpace}/${m.target}`, "--change-desc", `The bootstrap profiles that point Sveltos at each ${b.profile} variant's releases`, "--allow-exists", "--quiet"));
      L.push(line("cub", "unit", "update", "--space", m.space, b.unit, `management/${b.profile}.yaml`, "--change-desc", `The bootstrap profiles for every ${b.profile} variant this plan holds`, "--quiet"));
    }
  }
  L.push("");
  L.push("step \"5/6 Release each variant, stage by stage: promote, approve, publish\"");
  for (const p of plan.profiles) {
    const order = `${p.baseSpace}/${p.releaseOrder}`;
    L.push(line("cub", "changeorder", "create", "--space", p.baseSpace, p.releaseOrder, "--change-workflow", `${p.baseSpace}/${WORKFLOW}`, "--description", `First release of ${p.variants.map((v) => v.space).join(", ")}`, "--allow-exists", "--quiet"));
    L.push(`if rolled_out ${order}; then`);
    L.push(`  echo ${q(`${p.name}: every variant in this plan is released`)}`);
    L.push("else");
    for (const stage of p.stages) {
      L.push(`  ${line("cub", "variant", "promote", "--change-order", order, "--target-stage", stage, "--quiet")}`);
      L.push(`  ${line("cub", "variant", "approve", "--change-order", order, "--stage", stage, "--quiet")}`);
      for (const v of p.variants.filter((row) => row.stage === stage)) {
        L.push(`  ${line("publish", v.space, order)}`);
      }
    }
    L.push("fi");
  }
  if (plan.management) {
    L.push("");
    L.push("step \"6/6 Point Sveltos at ConfigHub (your management cluster)\"");
    L.push("# Sveltos reads the gateway as the Targets' server worker: a credential that");
    L.push("# does not expire and can pull only the releases of those Targets. The ID and");
    L.push("# secret go from cub into the Secret through file descriptors, never to disk,");
    L.push("# the command line, or the terminal.");
    const worker = `cub worker get --space ${plan.targetsSpace} ${WORKER}`;
    L.push(`k create secret generic ${gatewaySecretName(plan.targetsSpace)} --namespace ${GATEWAY_SECRET.namespace} --type ${GATEWAY_SECRET.type} \\`);
    L.push(`  --from-file=username=<(${worker} -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\\n') \\`);
    L.push(`  --from-file=password=<(${worker} --include-secret -o jq=.BridgeWorker.Secret | tr -d '\\n') \\`);
    L.push("  --dry-run=client -o yaml | k apply -f -");
    L.push("k apply -f management/");
    L.push("");
    L.push("echo");
    L.push("echo \"Done. Sveltos fetches each variant's release within a minute. Watch it with:\"");
    L.push("echo \"  kubectl get clustersummaries -A\"");
  }
  return `${L.join("\n")}\n`;
}

// Measured on kind with Sveltos v1.15.0 and a Helm chart: while the live
// profile manages a release, each per-cluster profile waits ("cannot manage
// chart ... ClusterSummary ... managing it") and nothing changes. Set to
// LeavePolicies and then deleted, the live profile leaves the release in
// place, and each per-cluster profile takes it over within seconds, at the
// same Helm revision, with the same pods.
export function takeoverScript(plan) {
  const live = plan.profiles.filter((p) => p.live);
  const L = [];
  L.push("#!/usr/bin/env bash");
  L.push(`# Hand ${live.map((p) => p.name).join(", ")} to the per-cluster profiles ConfigHub delivers,`);
  L.push("# without reinstalling anything. Run it after apply.sh:");
  L.push("#");
  L.push("#   MGMT_CONTEXT=<kubectl context of your management cluster> bash takeover.sh");
  L.push("#");
  L.push("# For each live profile it checks that every per-cluster profile has arrived,");
  L.push("# sets the live profile to LeavePolicies so deleting it leaves its add-ons in");
  L.push("# place, then deletes it. Each per-cluster profile then takes over the release");
  L.push("# it was waiting for. Skipping LeavePolicies would uninstall the add-ons first.");
  L.push("set -euo pipefail");
  L.push('k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }');
  for (const p of live) {
    const perCluster = p.variants.map((v) => v.profileName);
    L.push("");
    L.push(`echo ${q(`== ${p.name}`)}`);
    L.push(`if ! k get clusterprofile ${p.name} >/dev/null 2>&1; then`);
    L.push(`  echo ${q(`${p.name} is already gone`)}`);
    L.push("else");
    L.push(`  for profile in ${perCluster.join(" ")}; do`);
    L.push("    k get clusterprofile \"$profile\" >/dev/null 2>&1 || { echo \"$profile has not arrived from ConfigHub yet: run apply.sh, wait a minute, run this again\"; exit 1; }");
    L.push("  done");
    L.push(`  k patch clusterprofile ${p.name} --type merge -p '{"spec":{"stopMatchingBehavior":"LeavePolicies"}}'`);
    L.push("  sleep 20");
    L.push(`  k delete clusterprofile ${p.name} --wait=true`);
    L.push("fi");
  }
  L.push("");
  L.push("echo");
  L.push("echo \"Done. Each per-cluster profile reports Provisioned within a minute:\"");
  L.push("echo \"  kubectl get clustersummaries -A\"");
  return `${L.join("\n")}\n`;
}

const WORKER_ENTITY = {
  Slug: WORKER,
  OrgRole: "none",
  ProvidedInfo: {
    IsServerWorker: true,
    BridgeWorkerInfo: { SupportedConfigTypes: [{ ProviderType: "OCI", ToolchainType: "Any" }] },
  },
};

export function writeApply(plan, outDir) {
  check(plan.problems.length === 0, `the plan has problems to fix first:\n  - ${plan.problems.join("\n  - ")}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "plan.txt"), renderPlan(plan));
  writeFileSync(join(outDir, "worker.json"), `${JSON.stringify(WORKER_ENTITY, null, 2)}\n`);
  writeStoredDocuments(join(outDir, "profiles.yaml"), plan.profiles.map((p) => p.source));
  for (const p of plan.profiles) {
    const dir = join(outDir, p.name);
    mkdirSync(dir, { recursive: true });
    // The base is stored as YAML: ConfigHub lines each variant up with its
    // base by the stored document, and a JSON base would not line up.
    writeStoredDocuments(join(dir, "base.yaml"), [p.base]);
    writeFileSync(join(dir, "change-workflow.yaml"), p.workflowText);
  }
  if (plan.management) {
    mkdirSync(join(outDir, "management"), { recursive: true });
    for (const b of plan.management.byProfile) {
      writeStoredDocuments(join(outDir, `management/${b.profile}.yaml`), b.profiles);
    }
  }
  const script = join(outDir, "apply.sh");
  writeFileSync(script, applyScript(plan));
  chmodSync(script, 0o755);
  if (plan.live) {
    const takeover = join(outDir, "takeover.sh");
    writeFileSync(takeover, takeoverScript(plan));
    chmodSync(takeover, 0o755);
  }
  return script;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { inputs: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const next = rest[i + 1];
      check(next !== undefined, `${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--out") options.out = value();
    else if (arg === "--prefix") options.prefix = value();
    else if (arg === "--stage-label") options.stageLabel = value();
    else if (arg === "--stages") options.stages = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--management") options.management = value();
    else if (arg === "--profiles") options.profiles = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.inputs.push(arg);
  }
  return { command, options };
}

// npm runs scripts from the repository root and records where it was
// started in INIT_CWD, so paths resolve from where the command was typed.
const here = (path) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

function readInputs(inputs) {
  check(inputs.length > 0, "name the input: a YAML file, or - to read kubectl output from stdin");
  return inputs.flatMap((input) =>
    parseDocs(input === "-" ? readFileSync(0, "utf8") : readFileSync(here(input), "utf8")));
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "plan") {
    const plan = planFleet(readInputs(options.inputs), options);
    process.stdout.write(renderPlan(plan));
    process.exit(plan.problems.length > 0 ? 1 : 0);
  }
  if (command === "apply") {
    check(options.out, "apply needs --out <dir> for the files and the script it writes");
    const plan = planFleet(readInputs(options.inputs), options);
    if (plan.problems.length > 0) {
      process.stdout.write(renderPlan(plan));
      process.exit(1);
    }
    const script = writeApply(plan, here(options.out));
    process.stdout.write(renderPlan(plan).replace(/\nNext: .*\n$/, "\n"));
    const shown = relative(process.env.INIT_CWD ?? process.cwd(), script);
    const takeover = plan.live ? `\nThen hand the live profiles over, without reinstalling anything:\n  MGMT_CONTEXT=<same context> bash ${join(dirname(shown), "takeover.sh")}\n` : "";
    process.stdout.write(`\nWrote ${shown} and the files it reads. Read it, then run it:\n  MGMT_CONTEXT=<kubectl context of your management cluster> bash ${shown}\n${takeover}`);
    return;
  }
  if (command === "--verify") return verify();
  if (command === "--self-test") return selfTest();
  process.stderr.write("usage: npm run onboard -- plan <input.yaml|-> [--stage-label <key> --stages <a,b>] [--prefix <name>] [--management <ns>/<name>]\n       npm run onboard -- apply <input.yaml|-> --out <dir> [same options]\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The committed example and the self-test
// ---------------------------------------------------------------------------

function examplePlan() {
  const { options } = parseArgs(["plan", EXAMPLE_INPUT, ...EXAMPLE_ARGS]);
  return planFleet(readInputs(options.inputs), options);
}

function listFilesUnder(dir, base = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory()
    ? listFilesUnder(join(dir, entry.name), base)
    : [relative(base, join(dir, entry.name))])).sort();
}

// The committed plan and apply output are what the example produces today.
function verify() {
  const plan = examplePlan();
  check(plan.problems.length === 0, `the example plan has problems:\n  - ${plan.problems.join("\n  - ")}`);
  check(
    readFileSync(EXAMPLE_PLAN, "utf8") === renderPlan(plan),
    `${relative(repoRoot, EXAMPLE_PLAN)} is not what the example plans today; regenerate it with npm run onboard:example`,
  );
  const scratch = join(process.env.TMPDIR ?? "/tmp", `sveltos-onboard-verify-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  writeApply(plan, scratch);
  const expected = listFilesUnder(EXAMPLE_APPLY);
  const actual = listFilesUnder(scratch);
  const stale = actual.filter((file) => !expected.includes(file)
    || readFileSync(join(EXAMPLE_APPLY, file), "utf8") !== readFileSync(join(scratch, file), "utf8"));
  rmSync(scratch, { recursive: true, force: true });
  check(
    JSON.stringify(expected) === JSON.stringify(actual),
    `${relative(repoRoot, EXAMPLE_APPLY)} holds ${expected.join(", ")} but apply writes ${actual.join(", ")}; regenerate it with npm run onboard:example`,
  );
  check(
    stale.length === 0,
    `${stale.map((file) => relative(repoRoot, join(EXAMPLE_APPLY, file))).join(", ")} is not what apply writes today; regenerate it with npm run onboard:example`,
  );
  console.log(`verified the onboarding example: plan.txt and the ${actual.length} files apply writes match what the example produces`);
}

function writeExample() {
  const plan = examplePlan();
  writeFileSync(EXAMPLE_PLAN, renderPlan(plan));
  rmSync(EXAMPLE_APPLY, { recursive: true, force: true });
  writeApply(plan, EXAMPLE_APPLY);
  console.log(`wrote ${relative(repoRoot, EXAMPLE_PLAN)} and ${relative(repoRoot, EXAMPLE_APPLY)}/`);
}

function cluster(name, labels = {}, namespace = "projectsveltos") {
  return { apiVersion: "lib.projectsveltos.io/v1beta1", kind: "SveltosCluster", metadata: { name, namespace, labels } };
}

function profile(name, spec, extra = {}) {
  return { apiVersion: "config.projectsveltos.io/v1beta1", kind: "ClusterProfile", metadata: { name, ...extra }, spec };
}

function selfTest() {
  // Selector semantics.
  const labels = { env: "prod", region: "eu" };
  check(selects({ matchLabels: { env: "prod" } }, labels), "matchLabels should select an equal label");
  check(!selects({ matchLabels: { env: "staging" } }, labels), "matchLabels should refuse a different value");
  check(selects({ matchExpressions: [{ key: "env", operator: "In", values: ["staging", "prod"] }] }, labels), "In should select a listed value");
  check(!selects({ matchExpressions: [{ key: "tier", operator: "In", values: ["a"] }] }, labels), "In should refuse a missing key");
  check(selects({ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["a"] }] }, labels), "NotIn should select a missing key");
  check(!selects({ matchExpressions: [{ key: "env", operator: "NotIn", values: ["prod"] }] }, labels), "NotIn should refuse a listed value");
  check(selects({ matchExpressions: [{ key: "region", operator: "Exists" }] }, labels), "Exists should select a present key");
  check(!selects({ matchExpressions: [{ key: "region", operator: "DoesNotExist" }] }, labels), "DoesNotExist should refuse a present key");

  // The committed example: two profiles, the documented stages.
  const plan = examplePlan();
  check(plan.problems.length === 0, `the example should plan cleanly:\n  - ${plan.problems.join("\n  - ")}`);
  const byName = Object.fromEntries(plan.profiles.map((p) => [p.name, p]));
  check(
    JSON.stringify(byName.kyverno.variants.map((v) => [v.cluster, v.stage])) === JSON.stringify([["staging-eu", "staging"], ["prod-eu", "prod"], ["prod-us", "prod"]]),
    "kyverno should reach staging-eu in staging, then prod-eu and prod-us in prod",
  );
  check(
    JSON.stringify(byName["ingress-nginx"].stages) === JSON.stringify(["prod"]),
    "ingress-nginx selects only prod clusters, so its workflow should hold only the prod stage",
  );
  check(plan.ungoverned.map((c) => c.name).join() === "dev-1", "dev-1 is selected by no profile and should be reported as not onboarded");
  check(plan.management?.byProfile.reduce((n, b) => n + b.profiles.length, 0) === 5
    && plan.management.byProfile.map((b) => b.unit).join() === "bootstrap-ingress-nginx,bootstrap-kyverno",
  "the management record should hold one bootstrap profile per variant, in one unit per profile");
  check(!plan.live, "the written example is not live");

  // Everything apply stores addresses at most one cluster, by the same rule the
  // repository holds its own examples to.
  const stored = [
    ...plan.profiles.flatMap((p) => [p.base, ...p.variants.map((v) => v.doc)]),
    ...plan.management.byProfile.flatMap((b) => b.profiles),
  ];
  const unaddressed = stored.filter((doc) => !addressedStructurally(doc));
  check(unaddressed.length === 0, `apply would store profiles that fan out: ${unaddressed.map((d) => d.metadata.name).join(", ")}`);

  // A variant is the base plus exactly its departures.
  for (const p of plan.profiles) {
    for (const v of p.variants) {
      const back = structuredClone(v.doc);
      back.metadata.name = p.base.metadata.name;
      back.spec.clusterRefs = [];
      check(JSON.stringify(back) === JSON.stringify(p.base), `${v.space} should differ from its base only in ${v.departures.join(", ")}`);
    }
  }

  // The workflow: approval on every stage, Released on every stage after the first.
  const workflow = byName.kyverno.workflowText;
  check(/Name: staging\n {4}WhereSpace: "Labels.Stage = 'staging'"\n {4}ReleasePrerequisites/.test(workflow), "the first stage should wait only for approval");
  check(/Name: prod\n[^]*Prerequisites:\n {6}- Released\n {4}ReleasePrerequisites:\n {6}- approval/.test(workflow), "a later stage should wait for Released and approval");

  // A cluster that joins makes a new set of variants, so its first release
  // goes through a new change order; the same fleet keeps the same one.
  const joined = planFleet([...flatten(parseDocs(readFileSync(EXAMPLE_INPUT, "utf8"))), cluster("staging-us", { env: "staging" }), cluster("prod-eu", { env: "prod", region: "eu" })], { stageLabel: "env", stages: ["staging", "prod"] });
  check(joined.targets.filter((t) => t.cluster === "prod-eu").length === 1, "a cluster given twice should be one cluster, the later description winning");
  const joinedKyverno = joined.profiles.find((p) => p.name === "kyverno");
  const joinedIngress = joined.profiles.find((p) => p.name === "ingress-nginx");
  check(joinedKyverno.releaseOrder !== byName.kyverno.releaseOrder && joinedIngress.releaseOrder === byName["ingress-nginx"].releaseOrder,
    "a joining cluster should give its profiles a new release change order, and leave the others' unchanged");
  check(examplePlan().profiles.find((p) => p.name === "kyverno").releaseOrder === byName.kyverno.releaseOrder, "the same fleet should name the same change order");

  // kubectl's List output, a live profile, and the problems a plan names.
  const listed = planFleet([{ kind: "List", items: [cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), profile("p", { clusterSelector: { matchLabels: { env: "prod" } } }, { uid: "1" })] }]);
  check(listed.profiles[0]?.variants.length === 1 && listed.live, "a kubectl List should flatten, and a profile with a uid is live");
  check(/takeover.sh/.test(renderPlan(listed)) && /If your profiles are live/.test(renderPlan(listed)), "a live fleet's plan should point at takeover.sh and its guide");
  check(!listed.profiles[0].base.metadata.uid, "the base should keep nothing the API server wrote");
  const takeover = takeoverScript(listed);
  check(takeover.indexOf("stopMatchingBehavior\":\"LeavePolicies") > 0
    && takeover.indexOf("LeavePolicies") < takeover.indexOf("k delete clusterprofile p "),
  "the takeover should set LeavePolicies before it deletes the live profile, or the add-ons are uninstalled first");
  check(/for profile in p-a; do/.test(takeover), "the takeover should wait until every per-cluster profile has arrived");

  const noMgmt = planFleet([cluster("a", { env: "prod" }), profile("p", { clusterSelector: { matchLabels: { env: "prod" } } })]);
  check(noMgmt.problems.some((p) => p.includes("no management cluster")), "a plan without a management cluster should say so");

  const badStage = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "qa" }), profile("p", { clusterSelector: { matchLabels: { env: "qa" } } })], { stageLabel: "env", stages: ["prod"] });
  check(badStage.problems.some((p) => p.includes(`its env label is "qa"`)), "a cluster outside the stages should be named");
  let refused = false;
  try {
    writeApply(badStage, join(process.env.TMPDIR ?? "/tmp", `sveltos-onboard-refuse-${process.pid}`));
  } catch {
    refused = true;
  }
  check(refused, "apply should refuse a plan with problems");

  const recorded = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), cluster("b", { env: "prod" }),
    profile("p", { clusterSelector: { matchLabels: { env: "prod" } } }, { uid: "1" })]
    .map((doc) => (doc.metadata.name === "p" ? { ...doc, status: { matchingClusters: [{ apiVersion: "lib.projectsveltos.io/v1beta1", kind: "SveltosCluster", namespace: "projectsveltos", name: "a" }] } } : doc)));
  check(recorded.profiles[0].variants.map((v) => v.cluster).join() === "a" && recorded.notes.some((n) => n.includes("projectsveltos/b")),
    "a live profile should follow Sveltos's own record of the clusters it reaches, and say where its selector disagrees");
  const events = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }),
    profile("e", { clusterSelector: { matchLabels: { env: "prod" } } }, { ownerReferences: [{ kind: "EventTrigger", name: "t" }] })]);
  check(events.skipped.some((s) => s.name === "e" && /event framework/.test(s.reason)), "a profile the event framework made should be left out, with the reason");

  const sets = planFleet([cluster("mgmt", {}, "mgmt"), profile("s", { setRefs: ["prod-set"] })]);
  check(sets.skipped.some((s) => s.name === "s" && /ClusterSets/.test(s.reason)), "a ClusterSet profile should be left out, with the reason");

  const empty = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a"), profile("e", { clusterSelector: {} })]);
  check(empty.skipped.some((s) => s.name === "e" && /empty clusterSelector/.test(s.reason)), "an empty selector should be left out, not read as every cluster");

  const deps = planFleet([
    cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }),
    profile("cert-manager", { clusterSelector: { matchLabels: { env: "prod" } } }),
    profile("app", { clusterSelector: { matchLabels: { env: "prod" } }, dependsOn: ["cert-manager"] }),
  ]);
  const app = deps.profiles.find((p) => p.name === "app").variants[0];
  check(app.doc.spec.dependsOn[0] === "cert-manager-a" && app.departures.includes("spec.dependsOn")
    && app.departExpression.endsWith('.spec.dependsOn = ["cert-manager-a"]'), "dependsOn should name the dependency's variant for the same cluster");
  const unmetDeps = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), profile("app", { clusterSelector: { matchLabels: { env: "prod" } }, dependsOn: ["missing"] })]);
  check(unmetDeps.problems.some((p) => p.includes("depends on missing")), "a dependency the input does not onboard should be named");

  const capi = planFleet([cluster("mgmt", {}, "mgmt"), { apiVersion: "cluster.x-k8s.io/v1beta1", kind: "Cluster", metadata: { name: "c1", namespace: "fleet", labels: { gpu: "true" } } }, profile("gpu-operator", { clusterSelector: { matchLabels: { gpu: "true" } } })]);
  const capiRef = capi.profiles[0].variants[0].doc.spec.clusterRefs[0];
  check(capiRef.kind === "Cluster" && capiRef.apiVersion === "cluster.x-k8s.io/v1beta1" && capiRef.namespace === "fleet", "a Cluster API cluster should be addressed as its Cluster");

  const twins = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }, "team-1"), cluster("a", { env: "prod" }, "team-2"), profile("p", { clusterSelector: { matchLabels: { env: "prod" } } })]);
  check(twins.profiles[0].variants.map((v) => v.target).join() === "team-1-a,team-2-a", "two clusters of one name should keep their namespaces in their Targets");

  const bootstrap = profile("confighub-sveltos-p-a", { clusterRefs: [{ kind: "SveltosCluster", namespace: "mgmt", name: "mgmt" }], policyRefs: [{ deploymentType: "Remote", remoteURL: { url: "oci://oci.hub.confighub.com/space/sveltos-p-a:latest" } }] });
  const reonboard = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), bootstrap, profile("p", { clusterSelector: { matchLabels: { env: "prod" } } })]);
  check(reonboard.profiles.map((p) => p.name).join() === "p" && reonboard.notes.some((n) => n.includes("confighub-sveltos-p-a")), "a profile that reads the ConfigHub gateway is ConfigHub's already and should be left out");

  const delivered = profile("p-a", { clusterRefs: [{ kind: "SveltosCluster", namespace: "projectsveltos", name: "a" }] }, {
    annotations: { "confighub.com/origin": "{}", "projectsveltos.io/reference-name": "oci://oci.hub.confighub.com/space/sveltos-p-a:latest" },
  });
  const again = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), delivered, profile("p", { clusterSelector: { matchLabels: { env: "prod" } } })]);
  check(again.profiles.map((p) => p.name).join() === "p", "a profile ConfigHub delivered should be left out, not onboarded twice");

  const only = planFleet([cluster("mgmt", {}, "mgmt"), cluster("a", { env: "prod" }), profile("p", { clusterSelector: { matchLabels: { env: "prod" } } }), profile("q", { clusterSelector: { matchLabels: { env: "prod" } } })], { profiles: ["q"] });
  check(only.profiles.map((p) => p.name).join() === "q", "--profiles should onboard only the named profiles");
  const unknown = planFleet([cluster("mgmt", {}, "mgmt"), profile("p", { clusterSelector: { matchLabels: { env: "prod" } } })], { profiles: ["nope"] });
  check(unknown.problems.some((p) => p.includes("--profiles names nope")), "--profiles naming a missing profile should say so");

  // The files apply writes: YAML (JSON severs a variant's lineage), and a
  // script that never writes the credential to disk.
  const scratch = join(process.env.TMPDIR ?? "/tmp", `sveltos-onboard-self-test-${process.pid}`);
  writeApply(plan, scratch);
  const saved = parseDocs(readFileSync(join(scratch, "profiles.yaml"), "utf8"));
  const replanned = planFleet([...saved, ...flatten(parseDocs(readFileSync(EXAMPLE_INPUT, "utf8"))).filter(isClusterKind)], { stageLabel: "env", stages: ["staging", "prod"] });
  check(!replanned.live && JSON.stringify(replanned.profiles.map((p) => p.releaseOrder)) === JSON.stringify(plan.profiles.map((p) => p.releaseOrder)),
    "the saved profiles.yaml should plan the same fleet again, and not as live profiles");
  const baseText = readFileSync(join(scratch, "kyverno/base.yaml"), "utf8");
  check(!baseText.trimStart().startsWith("{"), "the base should be written as YAML");
  const script = readFileSync(join(scratch, "apply.sh"), "utf8");
  check(/k create secret generic confighub-sveltos-targets /.test(script)
    && plan.management.byProfile.flatMap((b) => b.profiles).every((doc) => doc.spec.policyRefs[0].remoteURL.secretRef.name === "confighub-sveltos-targets"),
  "the gateway Secret should be named for its Targets Space, so a second onboarding cannot lock the first out");
  check(/--from-file=username=<\(cub worker get [^)]*BridgeWorkerID/.test(script)
    && /--from-file=password=<\(cub worker get [^)]*--include-secret -o jq=\.BridgeWorker\.Secret/.test(script),
  "the gateway credential should be the Targets' worker, fed to the Secret through file descriptors");
  check(!/get-token/.test(script), "a login token expires within a day, so the fleet must not read the gateway with one");
  check(!/--from-literal/.test(script), "a credential on the command line shows in the process list");
  const kyvernoOrder = `sveltos-kyverno-base/${byName.kyverno.releaseOrder}`;
  check(script.includes(`publish sveltos-kyverno-prod-eu ${kyvernoOrder}`) && /--revision "ChangeOrder:\$2"/.test(script),
    "a release should name its change order with its base Space, so two profiles' change orders cannot be confused");
  check(script.includes(`if rolled_out ${kyvernoOrder}; then`), "a finished first release should be skipped on a re-run");
  check(script.includes(`depart sveltos-kyverno-prod-eu '.metadata.name = "kyverno-prod-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-eu"}]'`)
    && !/^cub unit update --space sveltos-kyverno-prod-eu/m.test(script),
  "a variant's departures should touch only its own fields, once, so it keeps what the base holds today");
  const kyvernoStaging = script.indexOf(`${kyvernoOrder} --target-stage staging`);
  const kyvernoProd = script.indexOf(`${kyvernoOrder} --target-stage prod`);
  check(kyvernoStaging > 0 && kyvernoStaging < kyvernoProd, "a profile's stages should roll out in order");
  rmSync(scratch, { recursive: true, force: true });

  console.log("onboarding self-test passed: selector semantics, the example's variants, stages and management record, one-cluster addressing, base-plus-departures, the workflow gates, kubectl List input, live profiles and their takeover, a joining cluster's release, dependsOn, ClusterSets, empty selectors, Sveltos's recorded matches, event-made profiles, profiles ConfigHub already delivers, --profiles, Cluster API clusters, name collisions, the problems apply refuses, YAML output, and the credential path");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--write-example") writeExample();
  else main(process.argv.slice(2));
}
