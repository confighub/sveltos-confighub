#!/usr/bin/env bash
# Looks through the agents' runs, before you publish them, for anything that
# looks like a credential: a bearer token (a JWT), a private key, or a
# kubeconfig's client key. Prints the file and line of each, never the value,
# and exits non-zero if it finds one.
#
#   source demo/env.sh && bash $DEMO/proof/scan-runs.sh [directory]
#
# The directory is $CHAOS_RUNS unless you name one.
set -euo pipefail
dir=${1:-${CHAOS_RUNS:?source demo/env.sh first, or name a directory}}
python3 - "$dir" <<'PY'
import os, re, sys
patterns = {
    "a bearer token (JWT)": re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    "a private JWK": re.compile(r'\\?"d\\?"\s*:\s*\\?"[A-Za-z0-9_-]{40,}'),
    "a PEM private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "a kubeconfig client key": re.compile(r"client-key-data\\?\"?\s*:\s*\\?\"?[A-Za-z0-9+/=]{40,}"),
    # The same, base64-encoded, as a Secret's data prints them.
    "a bearer token, base64 (a Secret's data)": re.compile(r"ZXlK[A-Za-z0-9+/]{40,}"),
    "a PEM private key, base64": re.compile(r"LS0tLS1CRUdJTi[A-Za-z0-9+/]{0,12}(?:UFJJVkFURS|BSSVZBVEU|QUklWQVRF)"),
    "a Secret's password field": re.compile(r'\bpassword\\?"?\s*:\s*\\?"?[A-Za-z0-9+/=]{20,}'),
}
found = 0
for root, _, files in os.walk(sys.argv[1]):
    for name in sorted(files):
        path = os.path.join(root, name)
        try:
            lines = open(path, errors="replace").read().splitlines()
        except OSError:
            continue
        for number, line in enumerate(lines, 1):
            for what, pattern in patterns.items():
                if pattern.search(line):
                    print(f"{path}:{number}: {what}")
                    found += 1
print(f"{found} found: read those lines before publishing" if found else "nothing that looks like a credential")
sys.exit(1 if found else 0)
PY
