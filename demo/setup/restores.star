# Every Secret and ConfigMap a workload uses must be on the restore list: what
# a repave brings back, because the release holds it or the Job that makes it.
# params["restores"] is the list, as Kind/name, comma-separated. Run by the
# trigger restores, which setup/repave-gate.sh makes.
def pod_spec(r):
    kind = r.get("kind", "")
    spec = r.get("spec") or {}
    if kind == "Pod":
        return spec
    if kind == "CronJob":
        return ((((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}).get("spec")) or {}
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job"):
        return (spec.get("template") or {}).get("spec") or {}
    return None

def named(kind, ref):
    name = (ref or {}).get("name") or (ref or {}).get("secretName") or ""
    return [kind + "/" + name] if name else []

def uses(ps):
    found = []
    for c in (ps.get("containers") or []) + (ps.get("initContainers") or []) + (ps.get("ephemeralContainers") or []):
        for e in c.get("env") or []:
            v = e.get("valueFrom") or {}
            found += named("Secret", v.get("secretKeyRef")) + named("ConfigMap", v.get("configMapKeyRef"))
        for e in c.get("envFrom") or []:
            found += named("Secret", e.get("secretRef")) + named("ConfigMap", e.get("configMapRef"))
    for v in ps.get("volumes") or []:
        found += named("Secret", v.get("secret")) + named("ConfigMap", v.get("configMap"))
        found += named("Secret", (v.get("csi") or {}).get("nodePublishSecretRef"))
        for s in (v.get("projected") or {}).get("sources") or []:
            found += named("Secret", s.get("secret")) + named("ConfigMap", s.get("configMap"))
    for s in ps.get("imagePullSecrets") or []:
        found += named("Secret", s)
    return found

# What a resource other than a workload uses.
def other_uses(r):
    kind = r.get("kind", "")
    found = []
    if kind == "Ingress":
        for t in (r.get("spec") or {}).get("tls") or []:
            found += named("Secret", t)
    if kind == "ServiceAccount":
        for s in (r.get("imagePullSecrets") or []) + (r.get("secrets") or []):
            found += named("Secret", s)
    return found

def validate(r):
    ps = pod_spec(r)
    found = (uses(ps) if ps != None else []) + other_uses(r)
    if not found:
        return {"passed": True}
    allowed = [x.strip() for x in params.get("restores", "").split(",") if x.strip()]
    name = r.get("kind", "") + " " + ((r.get("metadata") or {}).get("name") or "")
    missing = []
    for u in found:
        if u not in allowed and u not in missing:
            missing.append(u)
    if missing:
        return {"passed": False, "details": [name + " uses " + m + ", which is not on the restore list: a repave would not bring it back" for m in missing]}
    return {"passed": True}
