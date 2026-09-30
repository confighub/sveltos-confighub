# Local plugin UI preview

Build the `confighub/ui` bundle so its root contains `index.html` and
`plugin-ui-manifest.json`, then serve the verified bundle:

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

Build the bundle in the UI checkout with `npm ci && npm run build:plugin`.
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

The UI bundle is optional and is not downloaded automatically. The initial
pilot uses an explicitly supplied local build; release packaging and installer
selection remain separate work. Shared contract and cross-plugin lessons live in
`confighub/ui`, under `docs/dev/plugin-ui/`.
