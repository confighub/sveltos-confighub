# Local plugin UI preview

The UI is optional and viewing an exported preview needs no ConfigHub server
or account. It requires Sveltos plugin v0.11.0 or newer; follow the
[install or upgrade steps](../../README.md#optional-local-ui), then select a UI
release explicitly. Plugin and UI bundle versions are independent:

```sh
cub sveltos ui install --version plugin-ui-v0.1.0
cub sveltos ui
```

The installer downloads `confighub-plugin-ui.tar.gz` and its `.sha256` file
from the matching `confighub/ui` GitHub release with the `gh` CLI. Configure
`gh auth login` first when the repository requires authentication. For an
offline install, pass both `--archive` and `--sha256`; the expected digest is
the 64-character SHA-256 value. The archive must contain the bundle files at
its root, including `index.html` and `plugin-ui-manifest.json`.

The installer checks the archive digest, safely extracts and validates the
manifest, then atomically selects the installed bundle. It retains older
content-addressed versions. Without an explicit `--assets-dir` or
`CUB_UI_DIR`, `cub sveltos ui` serves the selected install. An explicit local
bundle remains useful during development:

```sh
CUB_UI_DIR=/path/to/confighub/ui/dist cub sveltos ui
# or: cub sveltos ui --assets-dir /path/to/confighub/ui/dist --no-browser
```

The command binds only to `127.0.0.1` (port 0 by default), verifies each
manifest SHA-256 before serving, prints the `/local` URL and bundle version,
and keeps the verified bytes in memory. The manifest format is
`confighub.com/ui-bundle/v1`; it pins local file contents and is not a publisher
signature or a source of trust in who built the bundle. The UI command serves
static files only; it does not expose APIs or upload or execute a preview.

The adjacent [`minimal.yaml`](minimal.yaml) and [`preview.json`](preview.json)
show the CLI preview document that a local UI can inspect.

To build this version yourself, check out the `plugin-ui-v0.1.0` tag in
`confighub/ui`, then run `npm ci && npm run build:plugin`. The tagged source
contains the explorer; subsequent server-release syncs removed it from UI `main`.
Export a fresh preview with:

```sh
go build -o ./cub-sveltos .
./cub-sveltos plan examples/ui-preview/minimal.yaml --format json > preview.json
./cub-sveltos ui --assets-dir /absolute/path/to/ui/dist
```

Open the exported file in the browser. The default plan remains ASCII;
`--format json` emits a versioned envelope with supplied inventory, proposed
ConfigHub objects, and explicit issues. Planning problems preserve that JSON and
return a nonzero exit; input read/parse errors return a diagnostic without an
envelope. The planner may read chart sources; opening an existing export does
not require a cluster, server or network. No raw configuration bodies are exported.

Normal `cub plugin install` does not download the UI bundle. The explicit
wrapper below installs it as a second step. The [shared contract and lessons](https://github.com/confighub/ui/tree/plugin-ui-v0.1.0/docs/dev/plugin-ui)
are available in the matching UI release source.

## Choose the UI during installation

For fresh installations, the release also includes `install-plugin.sh` and its SHA-256 file. Download them
from the trusted Sveltos release, verify the checksum, and run:

```sh
bash install-plugin.sh --with-ui plugin-ui-v0.1.0
```

Omit `--with-ui` for CLI only. The same script is in this checkout's `scripts/`.
It installs the plugin through cub, then installs the explicitly requested UI
version. UI failure returns nonzero; the CLI remains installed and an existing
UI selection is preserved. It does not change cub's global installer behavior.
