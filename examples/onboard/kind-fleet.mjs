// The example fleet on kind: a management cluster running stock Sveltos v1.15.0
// (which registers itself as mgmt/mgmt) and the three clusters my-fleet.yaml
// describes, registered as SveltosClusters with its env and region labels.
// --join registers a fourth, staging-us, the way a new cluster joins.
//
//   node examples/onboard/kind-fleet.mjs            build the fleet
//   node examples/onboard/kind-fleet.mjs --join     register staging-us
//   node examples/onboard/kind-fleet.mjs --delete   remove it
//
// Kubeconfigs go to $ONBOARD_DIR (default: $TMPDIR/sveltos-onboard).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { parseDocs } from "../../scripts/lib/proof-common.mjs";
import { manifestImages, preloadSveltosImages, writeDocuments } from "../../scripts/lib/per-cluster-fleet.mjs";

const W = process.env.ONBOARD_DIR ?? join(tmpdir(), "sveltos-onboard");
const VERSION = "v1.15.0";
const MANIFEST_URL = `https://raw.githubusercontent.com/projectsveltos/sveltos/${VERSION}/manifest/manifest.yaml`;
const MANIFEST_SHA = "ad80fa92a73b167e30df7a98cc0295acd3716b476dd0cc25859df3f45b69b4ce";
const MGMT = "ob-mgmt";
const WORKLOADS = [
  { kind: "ob-staging-eu", name: "staging-eu", labels: { env: "staging", region: "eu" } },
  { kind: "ob-prod-eu", name: "prod-eu", labels: { env: "prod", region: "eu" } },
  { kind: "ob-prod-us", name: "prod-us", labels: { env: "prod", region: "us" } },
];
const JOINER = { kind: "ob-staging-us", name: "staging-us", labels: { env: "staging", region: "us" } };

function run(cmd, args, { timeout = 900_000, input } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(" ")} failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
  return r.stdout;
}
const kc = (name) => join(W, `${name}.kubeconfig`);
const k = (name, args, opts) => run("kubectl", ["--kubeconfig", kc(name), ...args], opts);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function waitReady(ns, name) {
  for (let i = 0; i < 120; i += 1) {
    const r = spawnSync("kubectl", ["--kubeconfig", kc(MGMT), "-n", ns, "get", "sveltoscluster", name, "-o", "json"], { encoding: "utf8" });
    if (r.status === 0) {
      const s = JSON.parse(r.stdout).status ?? {};
      if (s.ready === true || s.connectionStatus === "Healthy") return s;
    }
    sleep(3000);
  }
  throw new Error(`${ns}/${name} never became ready`);
}
mkdirSync(W, { recursive: true });
if (process.argv[2] === "--delete") {
  for (const name of [MGMT, ...WORKLOADS.map((w) => w.kind), JOINER.kind]) spawnSync("kind", ["delete", "cluster", "--name", name]);
  console.log("deleted the fleet's kind clusters");
  process.exit(0);
}
const registerOnly = process.argv[2] === "--join";
const existing = run("kind", ["get", "clusters"]).split("\n");
for (const name of registerOnly ? [JOINER.kind] : [MGMT, ...WORKLOADS.map((w) => w.kind)]) {
  if (existing.includes(name)) { log(`${name} exists`); continue; }
  log(`creating ${name}`);
  run("kind", ["create", "cluster", "--name", name, "--kubeconfig", kc(name), "--wait", "180s"]);
}

if (!registerOnly) {
log("fetching the Sveltos manifest");
const manifest = run("curl", ["-fsSL", MANIFEST_URL]);
const sha = createHash("sha256").update(manifest).digest("hex");
if (sha !== MANIFEST_SHA) throw new Error(`manifest sha ${sha} differs from the lock`);

log("preloading Sveltos images");
preloadSveltosImages({
  clusters: [MGMT, ...WORKLOADS.map((w) => w.kind)],
  version: VERSION,
  addonControllerImage: `docker.io/projectsveltos/addon-controller:${VERSION}`,
  images: manifestImages(manifest),
});

log("installing Sveltos");
const docs = parseDocs(manifest);
const crds = docs.filter((d) => d.kind === "CustomResourceDefinition");
const rest = docs.filter((d) => d.kind !== "CustomResourceDefinition" && d.kind !== "ServiceMonitor");
writeDocuments(join(W, "sveltos-crds.json"), crds);
writeDocuments(join(W, "sveltos-rest.json"), rest);
k(MGMT, ["apply", "--server-side", "-f", join(W, "sveltos-crds.json")]);
for (const crd of crds) k(MGMT, ["wait", "--for=condition=Established", `crd/${crd.metadata.name}`, "--timeout=180s"]);
k(MGMT, ["apply", "--server-side", "-f", join(W, "sveltos-rest.json")]);
k(MGMT, ["-n", "projectsveltos", "wait", "--for=condition=Available", "deployment", "--all", "--timeout=900s"]);

log("waiting for mgmt/mgmt");
waitReady("mgmt", "mgmt");
}

for (const w of registerOnly ? [JOINER] : WORKLOADS) {
  log(`registering ${w.name}`);
  k(w.kind, ["apply", "-f", "-"], { input: `apiVersion: v1
kind: Namespace
metadata: {name: projectsveltos}
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: sveltos-manager, namespace: projectsveltos}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: sveltos-manager}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin}
subjects: [{kind: ServiceAccount, name: sveltos-manager, namespace: projectsveltos}]
` });
  const token = k(w.kind, ["-n", "projectsveltos", "create", "token", "sveltos-manager", "--duration=720h"]).trim();
  const ca = JSON.parse(k(w.kind, ["config", "view", "--raw", "-o", "json"])).clusters[0].cluster["certificate-authority-data"];
  const kubeconfig = `apiVersion: v1
kind: Config
clusters: [{name: workload, cluster: {server: "https://${w.kind}-control-plane:6443", certificate-authority-data: ${ca}}}]
users: [{name: sveltos-manager, user: {token: ${token}}}]
contexts: [{name: workload, context: {cluster: workload, user: sveltos-manager}}]
current-context: workload
`;
  const labels = Object.entries(w.labels).map(([key, v]) => `    ${key}: ${v}`).join("\n");
  k(MGMT, ["apply", "-f", "-"], { input: `apiVersion: v1
kind: Secret
metadata: {name: ${w.name}-sveltos-kubeconfig, namespace: projectsveltos}
type: Opaque
data:
  kubeconfig: ${Buffer.from(kubeconfig).toString("base64")}
---
apiVersion: lib.projectsveltos.io/v1beta1
kind: SveltosCluster
metadata:
  name: ${w.name}
  namespace: projectsveltos
  labels:
${labels}
spec: {}
` });
  waitReady("projectsveltos", w.name);
}
log(`fleet ready; kubeconfigs in ${W}`);
