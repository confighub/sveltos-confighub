// Package chartrender renders a Helm chart to the objects ConfigHub holds,
// with the rules that make a rendering stand for what runs:
//
//   - the chart is at one exact version, not a range;
//   - it renders the same bytes twice, so it holds no random values;
//   - the hooks it leaves out are named, since only Helm runs them;
//   - the stray line cub helm template prints is dropped.
//
// It renders with cub helm template, ConfigHub's own Helm renderer. cub sveltos
// uses it to onboard the charts of Sveltos ClusterProfiles; anything else that
// flattens charts into ConfigHub, such as a Flux HelmRelease or an Argo CD
// chart source, can use the same rules.
package chartrender

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// Chart is one Helm chart, and how it is rendered.
type Chart struct {
	Release   string
	Namespace string
	// Ref is what cub helm template is given: a chart name resolved against
	// Repo, or an oci:// reference.
	Ref          string
	Repo         string
	Version      string
	Values       string
	SkipCRDs     bool
	IncludeHooks bool
}

// Key identifies a rendering: the same chart, version, namespace and values
// always render the same objects.
func (c Chart) Key() string {
	sum := sha256.Sum256([]byte(strings.Join([]string{c.Release, c.Namespace, c.Ref, c.Repo, c.Version, c.Values, fmt.Sprint(c.SkipCRDs), fmt.Sprint(c.IncludeHooks)}, "\x00")))
	return fmt.Sprintf("%s-%s-%s", slug(c.Release), slug(c.Version), hex.EncodeToString(sum[:])[:8])
}

// Command is the cub helm template command line that renders the chart, with
// the values read from valuesFile. Record it beside what it rendered, piped
// through Filter, so the next version can be rendered the same way.
func (c Chart) Command(valuesFile string) []string {
	args := []string{"cub", "helm", "template", c.Release, c.Ref}
	if c.Repo != "" {
		args = append(args, "--repo", c.Repo)
	}
	if c.Version != "" {
		args = append(args, "--version", c.Version)
	}
	args = append(args, "--namespace", c.Namespace, "--create-namespace")
	if c.SkipCRDs {
		args = append(args, "--skip-crds")
	}
	if c.IncludeHooks {
		args = append(args, "--include-hooks")
	}
	if c.Values != "" && valuesFile != "" {
		args = append(args, "-f", valuesFile)
	}
	return args
}

// ExactVersion says whether a chart version is one exact version. A range
// (1.2.x, ^1.2.0) or a partial version (1.2) resolves to whatever is newest
// when it is rendered, which need not be what is running; cub helm template
// accepts either.
func ExactVersion(version string) bool { return exactVersion.MatchString(version) }

var exactVersion = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// Rendering is what rendering a chart printed: the objects on stdout, and on
// stderr the hook manifests it left out.
type Rendering struct {
	Stdout []byte
	Stderr []byte
}

// Renderer renders a chart the way cub helm install would.
type Renderer func(Chart) (Rendering, error)

// CubHelm renders with the cub helm plugin's template command, which needs no
// ConfigHub connection.
func CubHelm(c Chart) (Rendering, error) {
	cub, err := exec.LookPath("cub")
	if err != nil {
		return Rendering{}, errors.New("rendering charts needs cub on the PATH")
	}
	valuesFile := ""
	if c.Values != "" {
		f, err := os.CreateTemp("", "chart-values-*.yaml")
		if err != nil {
			return Rendering{}, err
		}
		defer os.Remove(f.Name())
		if _, err := io.WriteString(f, c.Values); err != nil {
			f.Close()
			return Rendering{}, err
		}
		f.Close()
		valuesFile = f.Name()
	}
	args := c.Command(valuesFile)
	cmd := exec.Command(cub, args[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		text := strings.TrimSpace(stderr.String())
		if strings.Contains(text, "unknown command") {
			return Rendering{}, errors.New("rendering charts needs the cub helm plugin: cub plugin install confighub/cub-helm")
		}
		if i := strings.LastIndex(text, "\n"); i >= 0 {
			text = text[i+1:]
		}
		return Rendering{}, fmt.Errorf("%s: %s", strings.Join(args[:5], " "), text)
	}
	return Rendering{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}, nil
}

// ErrNotRepeatable is a chart that renders differently each time it is
// rendered: random values, a certificate minted per render, or lookup. It
// cannot be held as one reviewed set of objects.
var ErrNotRepeatable = errors.New("renders differently each time it is rendered (random values or lookup), so it cannot be held as one set of objects; set those values explicitly")

// Result is a chart's rendering, known to repeat.
type Result struct {
	// Objects is what the rendering printed, in its order, without the stray
	// line: the text to store.
	Objects []byte
	// Hooks are the hook manifests the rendering left out.
	Hooks []Hook
}

// Render renders a chart twice and returns the rendering once it is known to
// repeat byte for byte.
func Render(render Renderer, c Chart) (Result, error) {
	first, err := render(c)
	if err != nil {
		return Result{}, err
	}
	second, err := render(c)
	if err != nil {
		return Result{}, err
	}
	if !bytes.Equal(first.Stdout, second.Stdout) {
		return Result{}, ErrNotRepeatable
	}
	return Result{Objects: DropStrayLines(first.Stdout), Hooks: HooksOf(first.Stderr)}, nil
}

// Hook is a Helm hook manifest: an object Helm creates at a point in a
// release's life, which plain delivery does not have.
type Hook struct {
	Kind   string
	Name   string
	Events string
}

func (h Hook) String() string { return h.Kind + " " + h.Name }

// AtInstall is a hook Helm runs to install the chart: without it, a cluster
// that installs the chart from its plain objects lacks what the hook makes.
func (h Hook) AtInstall() bool {
	return strings.Contains(h.Events, "pre-install") || strings.Contains(h.Events, "post-install")
}

var droppedHook = regexp.MustCompile(`Dropped hook manifest: (\S+) (\S+) \(helm\.sh/hook: ([^)]*)\)`)

// HooksOf reads the hook manifests cub helm template reports leaving out.
func HooksOf(stderr []byte) []Hook {
	var out []Hook
	for _, m := range droppedHook.FindAllStringSubmatch(string(stderr), -1) {
		out = append(out, Hook{Kind: m[1], Name: m[2], Events: m[3]})
	}
	return out
}

// StrayLine is a line cub helm template prints at the top of some documents,
// after their comments: a key that is no part of the chart (26 of them in
// Kyverno 3.8.1). ConfigHub drops it, with the comments above it, when a unit
// is created, but keeps it when a unit is updated, so a chart upgrade would
// carry it into review and to the clusters.
const StrayLine = `$comment$head$: ""`

// Filter is the shell filter that drops StrayLine, for a recorded render
// command: cub helm template ... | Filter.
const Filter = `grep -vxF '` + StrayLine + `'`

// DropStrayLines drops every StrayLine and leaves the rest byte for byte.
func DropStrayLines(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for _, l := range bytes.SplitAfter(data, []byte("\n")) {
		if string(bytes.TrimRight(l, "\n")) == StrayLine {
			continue
		}
		out = append(out, l...)
	}
	return out
}

var slugInvalid = regexp.MustCompile(`[^a-z0-9-]+`)
var slugDashes = regexp.MustCompile(`-+`)

func slug(value string) string {
	s := slugInvalid.ReplaceAllString(strings.ToLower(value), "-")
	s = slugDashes.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}
