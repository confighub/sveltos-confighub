import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "../..");

export function command(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 200,
  });
}

export function runCub(cubArgs) {
  return execFileSync("cub", cubArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: cubEnv(),
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 200,
  });
}

export function cubEnv() {
  const env = { ...process.env, CONFIGHUB_AGENT: "1" };
  try {
    const goPath = execFileSync("go", ["env", "GOPATH"], { encoding: "utf8" }).trim();
    const goBin = join(goPath, "bin");
    if (!env.PATH?.split(":").includes(goBin)) env.PATH = `${env.PATH ?? ""}:${goBin}`;
  } catch {
    // Let cub fail clearly if the local toolchain is incomplete.
  }
  return env;
}

export function parseObjects(text) {
  return py(
    `
import json, sys, yaml
class ManifestLoader(yaml.SafeLoader):
    pass
ManifestLoader.add_constructor("tag:yaml.org,2002:value", lambda loader, node: loader.construct_scalar(node))
objects = []
for doc in yaml.load_all(sys.stdin.read(), Loader=ManifestLoader):
    if not isinstance(doc, dict):
        continue
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        continue
    api_version = str(doc.get("apiVersion", ""))
    kind = str(doc.get("kind", ""))
    namespace = str(metadata.get("namespace", ""))
    name = str(metadata.get("name", ""))
    if api_version and kind and name:
        objects.append({
            "apiVersion": api_version,
            "kind": kind,
            "namespace": namespace,
            "name": name,
            "identity": "|".join([api_version, kind, namespace, name]),
        })
objects.sort(key=lambda item: item["identity"])
print(json.dumps(objects, sort_keys=True))
`,
    text,
  );
}

export function parseDocs(text) {
  return py(
    `
import json, sys, yaml
class ManifestLoader(yaml.SafeLoader):
    pass
ManifestLoader.add_constructor("tag:yaml.org,2002:value", lambda loader, node: loader.construct_scalar(node))
docs = [doc for doc in yaml.load_all(sys.stdin.read(), Loader=ManifestLoader) if isinstance(doc, dict)]
print(json.dumps(docs, sort_keys=True))
`,
    text,
  );
}

export function readYaml(path) {
  return readYamlText(readFileSync(path, "utf8"));
}

export function readYamlText(text) {
  return py(
    `
import json, sys, yaml
class ManifestLoader(yaml.SafeLoader):
    pass
ManifestLoader.add_constructor("tag:yaml.org,2002:value", lambda loader, node: loader.construct_scalar(node))
docs = [doc for doc in yaml.load_all(sys.stdin.read(), Loader=ManifestLoader) if doc is not None]
print(json.dumps(docs[0] if len(docs) == 1 else docs, sort_keys=True))
`,
    text,
  );
}

export function py(script, input) {
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-python-"));
  const inputPath = join(tempRoot, "stdin.txt");
  try {
    writeFileSync(inputPath, input ?? "", "utf8");
    const wrappedScript = [
      "import sys",
      `sys.stdin = open(${JSON.stringify(inputPath)}, "r", encoding="utf-8")`,
      script,
    ].join("\n");
    const result = spawnSync("python3", ["-c", wrappedScript], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 200,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function canonicalObjectMaps(helmYaml, cubYaml) {
  return py(
    `
import json, sys, yaml
payload = json.load(sys.stdin)
class ManifestLoader(yaml.SafeLoader):
    pass
ManifestLoader.add_constructor("tag:yaml.org,2002:value", lambda loader, node: loader.construct_scalar(node))
def object_map(text):
    result = {}
    for doc in yaml.load_all(text or "", Loader=ManifestLoader):
        if not isinstance(doc, dict):
            continue
        def prune(value):
            if isinstance(value, dict):
                return {k: prune(v) for k, v in value.items() if v is not None}
            if isinstance(value, list):
                return [prune(v) for v in value]
            return value
        doc = prune(doc)
        metadata = doc.get("metadata") or {}
        if isinstance(metadata, dict):
            for optional_map in ["annotations", "labels"]:
                if metadata.get(optional_map) == {}:
                    metadata.pop(optional_map)
        metadata = doc.get("metadata") or {}
        key = "|".join([str(doc.get("apiVersion", "")), str(doc.get("kind", "")), str(metadata.get("namespace", "")), str(metadata.get("name", ""))])
        if key.strip("|"):
            result[key] = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return result
print(json.dumps({"helm": object_map(payload["helm"]), "cub": object_map(payload["cub"])}, sort_keys=True))
`,
    JSON.stringify({ helm: helmYaml, cub: cubYaml }),
  );
}

export function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return `${pad}-\n${toYaml(item, indent + 2)}`;
        }
        if (Array.isArray(item)) return `${pad}-\n${toYaml(item, indent + 2)}`;
        return `${pad}- ${toYaml(item, 0)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([key, item]) => {
        if (item && typeof item === "object") return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        return `${pad}${key}: ${toYaml(item, 0)}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

export function writeYaml(path, value) {
  write(path, `${toYaml(value)}\n`);
}

export function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

// Machine-specific scratch paths must never reach a committed artifact: they
// differ per operator and per runner, so they churn diffs and leak a local
// filesystem layout into public evidence. Recorded commands are written with a
// literal <tmp> placeholder; captured output and error text goes through here.
// The segment-bounded pattern stops at the mkdtemp directory so a meaningful
// repo-relative tail survives. Committed live receipts under runs/ keep their
// recorded text as observed; this is for text on its way into a new artifact.
export function normalizeTempPaths(text) {
  return String(text ?? "")
    .replaceAll(repoRoot, "<repo>")
    // A macOS scratch tree is scratch all the way down, including any nested
    // mkdtemp directory, so the whole path collapses. Leaving a nested random
    // segment behind would keep the output changing on every run.
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, "<tmp>")
    // /tmp is different: a working copy can legitimately live there, and its
    // repo-relative tail carries meaning, so only the scratch segment goes.
    .replace(/\/(?:private\/)?tmp\/[A-Za-z0-9._-]+/g, "<tmp>");
}

export function normalizeYaml(text) {
  return `${text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n*$/, "")}\n`;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function relativeRepo(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

export function findingCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function identityFor(doc) {
  const metadata = doc.metadata ?? {};
  return [doc.apiVersion ?? "", doc.kind ?? "", metadata.namespace ?? "", metadata.name ?? ""].join("|");
}

export function labelsMatch(selector, labels) {
  return Object.entries(selector ?? {}).every(([key, value]) => labels?.[key] === value);
}

export function workloadPodSpec(doc) {
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(doc.kind)) return doc.spec?.template?.spec ?? null;
  if (doc.kind === "Job") return doc.spec?.template?.spec ?? null;
  if (doc.kind === "CronJob") return doc.spec?.jobTemplate?.spec?.template?.spec ?? null;
  return null;
}

export function workloadTemplateLabels(doc) {
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(doc.kind)) {
    return doc.spec?.template?.metadata?.labels ?? {};
  }
  if (doc.kind === "Job") return doc.spec?.template?.metadata?.labels ?? {};
  if (doc.kind === "CronJob") return doc.spec?.jobTemplate?.spec?.template?.metadata?.labels ?? {};
  return {};
}

export function imageTag(image) {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon <= lastSlash) return null;
  return image.slice(lastColon + 1);
}

export function listFiles(root) {
  const result = [];
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

export function listYamlFiles(root) {
  if (!existsSync(root)) return [];
  return listFiles(root).filter((file) => [".yaml", ".yml"].some((suffix) => file.endsWith(suffix)));
}

export function objectFilesFromDirs(dirs) {
  return dirs.flatMap((dir) =>
    listYamlFiles(dir).map((file) => ({ path: file, yaml: readFileSync(file, "utf8"), name: basename(file) })),
  );
}

export function difference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

export function check(condition, message) {
  if (!condition) throw new Error(message);
}
