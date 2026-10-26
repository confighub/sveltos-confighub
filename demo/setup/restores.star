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
        return ((spec.get("jobTemplate") or {}).get("spec") or {}).get("template", {}).get("spec") or {}
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"):
        return (spec.get("template") or {}).get("spec") or {}
    return None

def uses(ps):
    found = []
    for c in (ps.get("containers") or []) + (ps.get("initContainers") or []) + (ps.get("ephemeralContainers") or []):
        for e in c.get("env") or []:
            v = e.get("valueFrom") or {}
            if v.get("secretKeyRef"):
                found.append("Secret/" + v["secretKeyRef"].get("name", ""))
            if v.get("configMapKeyRef"):
                found.append("ConfigMap/" + v["configMapKeyRef"].get("name", ""))
        for e in c.get("envFrom") or []:
            if e.get("secretRef"):
                found.append("Secret/" + e["secretRef"].get("name", ""))
            if e.get("configMapRef"):
                found.append("ConfigMap/" + e["configMapRef"].get("name", ""))
    for v in ps.get("volumes") or []:
        if v.get("secret"):
            found.append("Secret/" + v["secret"].get("secretName", ""))
        if v.get("configMap"):
            found.append("ConfigMap/" + v["configMap"].get("name", ""))
        for s in (v.get("projected") or {}).get("sources") or []:
            if s.get("secret"):
                found.append("Secret/" + s["secret"].get("name", ""))
            if s.get("configMap"):
                found.append("ConfigMap/" + s["configMap"].get("name", ""))
    for s in ps.get("imagePullSecrets") or []:
        found.append("Secret/" + s.get("name", ""))
    return found

def validate(r):
    ps = pod_spec(r)
    if ps == None:
        return {"passed": True}
    allowed = [x.strip() for x in params.get("restores", "").split(",") if x.strip()]
    name = r.get("kind", "") + " " + (r.get("metadata") or {}).get("name", "")
    missing = []
    for u in uses(ps):
        if u not in allowed and u not in missing:
            missing.append(u)
    if missing:
        return {"passed": False, "details": [name + " uses " + m + ", which is not on the restore list: a repave would not bring it back" for m in missing]}
    return {"passed": True}
