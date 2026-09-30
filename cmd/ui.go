package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	uiManifestName    = "plugin-ui-manifest.json"
	uiManifestVersion = "confighub.com/ui-bundle/v1"
	uiMaxFiles        = 5000
	uiMaxBytes        = 100 << 20
)

type uiBundleManifest struct {
	APIVersion string            `json:"apiVersion"`
	Version    string            `json:"version"`
	Files      map[string]string `json:"files"`
}

type uiBundle struct {
	version string
	files   map[string][]byte
}

func newUICommand() *cobra.Command {
	var assetsDir string
	var port int
	var noBrowser bool
	c := &cobra.Command{
		Use:   "ui",
		Short: "Serve the verified local plugin UI bundle",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if assetsDir == "" {
				assetsDir = os.Getenv("CUB_UI_DIR")
			}
			if assetsDir == "" {
				return errors.New("ui needs --assets-dir or CUB_UI_DIR pointing to the built UI bundle")
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			return runUI(ctx, assetsDir, port, noBrowser, cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
	c.Flags().StringVar(&assetsDir, "assets-dir", "", "built confighub/ui bundle directory (defaults to CUB_UI_DIR)")
	c.Flags().IntVar(&port, "port", 0, "loopback port (0 chooses an available port)")
	c.Flags().BoolVar(&noBrowser, "no-browser", false, "print the URL without opening a browser")
	return c
}

// loadUIBundle verifies all listed assets once and keeps those exact bytes in
// memory, so a later filesystem change cannot replace a verified response.
func loadUIBundle(root string) (*uiBundle, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve UI bundle directory: %w", err)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, fmt.Errorf("read UI bundle directory: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return nil, fmt.Errorf("UI bundle path must be a directory, not a symlink")
	}
	manifestPath := filepath.Join(root, uiManifestName)
	mi, err := os.Lstat(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", uiManifestName, err)
	}
	if mi.Mode()&os.ModeSymlink != 0 || !mi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s must be a regular file", uiManifestName)
	}
	if mi.Size() > 2<<20 {
		return nil, fmt.Errorf("%s exceeds the 2 MiB limit", uiManifestName)
	}
	f, err := os.Open(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", uiManifestName, err)
	}
	openedManifest, statErr := f.Stat()
	if statErr != nil || !os.SameFile(mi, openedManifest) {
		_ = f.Close()
		return nil, fmt.Errorf("%s changed while it was opened", uiManifestName)
	}
	var manifest uiBundleManifest
	dec := json.NewDecoder(io.LimitReader(f, 2<<20))
	dec.DisallowUnknownFields()
	err = dec.Decode(&manifest)
	if err == nil {
		var trailing any
		if trailingErr := dec.Decode(&trailing); trailingErr != io.EOF {
			if trailingErr == nil {
				err = errors.New("multiple JSON values")
			} else {
				err = trailingErr
			}
		}
	}
	closeErr := f.Close()
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", uiManifestName, err)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close %s: %w", uiManifestName, closeErr)
	}
	if manifest.APIVersion != uiManifestVersion {
		return nil, fmt.Errorf("%s apiVersion must be %q", uiManifestName, uiManifestVersion)
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return nil, fmt.Errorf("%s version must be nonempty", uiManifestName)
	}
	if len(manifest.Files) == 0 || len(manifest.Files) > uiMaxFiles {
		return nil, fmt.Errorf("%s must list between 1 and %d files", uiManifestName, uiMaxFiles)
	}
	if _, ok := manifest.Files["index.html"]; !ok {
		return nil, errors.New("UI bundle manifest must include index.html")
	}
	paths := make([]string, 0, len(manifest.Files))
	for rel, digest := range manifest.Files {
		if err := validateBundlePath(rel); err != nil {
			return nil, err
		}
		if rel == uiManifestName {
			return nil, fmt.Errorf("%s must not list itself", uiManifestName)
		}
		if len(digest) != sha256.Size*2 {
			return nil, fmt.Errorf("invalid SHA-256 for %q", rel)
		}
		if _, err := hex.DecodeString(digest); err != nil || strings.ToLower(digest) != digest {
			return nil, fmt.Errorf("invalid SHA-256 for %q", rel)
		}
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	files := make(map[string][]byte, len(paths))
	total := int64(0)
	for _, rel := range paths {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := rejectSymlinkPath(root, rel); err != nil {
			return nil, err
		}
		info, err := os.Stat(full)
		if err != nil {
			return nil, fmt.Errorf("read UI asset %q: %w", rel, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("UI asset %q must be a regular file", rel)
		}
		if info.Size() < 0 || total+info.Size() > uiMaxBytes {
			return nil, fmt.Errorf("UI bundle exceeds %d bytes", uiMaxBytes)
		}
		asset, err := os.Open(full)
		if err != nil {
			return nil, fmt.Errorf("read UI asset %q: %w", rel, err)
		}
		openedInfo, statErr := asset.Stat()
		if statErr != nil || !os.SameFile(info, openedInfo) || !openedInfo.Mode().IsRegular() {
			_ = asset.Close()
			return nil, fmt.Errorf("UI asset %q changed while it was opened", rel)
		}
		remaining := int64(uiMaxBytes) - total
		data, err := io.ReadAll(io.LimitReader(asset, remaining+1))
		closeErr := asset.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return nil, fmt.Errorf("read UI asset %q: %w", rel, err)
		}
		if int64(len(data)) > remaining {
			return nil, fmt.Errorf("UI bundle exceeds %d bytes", uiMaxBytes)
		}
		if int64(len(data)) != info.Size() {
			return nil, fmt.Errorf("UI asset %q changed while it was read", rel)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != manifest.Files[rel] {
			return nil, fmt.Errorf("UI asset %q does not match its manifest SHA-256", rel)
		}
		total += int64(len(data))
		files[rel] = data
	}
	return &uiBundle{version: manifest.Version, files: files}, nil
}

func validateBundlePath(rel string) error {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\:\x00") || path.Clean(rel) != rel {
		return fmt.Errorf("invalid relative UI asset path %q", rel)
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("invalid relative UI asset path %q", rel)
		}
	}
	return nil
}

func rejectSymlinkPath(root, rel string) error {
	cur := root
	parts := strings.Split(rel, "/")
	for i, part := range parts {
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if err != nil {
			return fmt.Errorf("read UI asset %q: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("UI asset %q traverses a symlink", rel)
		}
		if i < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("UI asset parent for %q is not a directory", rel)
		}
	}
	return nil
}

func newUIHandler(bundle *uiBundle, expectedHost string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.Host != expectedHost {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Scheme != "http" || u.Host != expectedHost || u.User != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
				http.Error(w, "cross-origin request denied", http.StatusForbidden)
				return
			}
		}
		requestPath := r.URL.Path
		if strings.HasPrefix(requestPath, "/api") || strings.HasPrefix(requestPath, "/auth") {
			http.NotFound(w, r)
			return
		}
		if requestPath == "/local" || requestPath == "/local/" {
			requestPath = "/index.html"
		}
		if strings.HasPrefix(requestPath, "/local/api") || strings.HasPrefix(requestPath, "/local/auth") {
			http.NotFound(w, r)
			return
		}
		rel := strings.TrimPrefix(requestPath, "/")
		if err := validateBundlePath(rel); err != nil {
			http.NotFound(w, r)
			return
		}
		data, ok := bundle.files[rel]
		if !ok {
			http.NotFound(w, r)
			return
		}
		contentType := map[string]string{".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm"}[strings.ToLower(filepath.Ext(rel))]
		if contentType == "" {
			contentType = mime.TypeByExtension(filepath.Ext(rel))
		}
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(data)
		}
	})
}

func runUI(ctx context.Context, assetsDir string, port int, noBrowser bool, out, errOut io.Writer) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("--port must be between 0 and 65535")
	}
	bundle, err := loadUIBundle(assetsDir)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		return fmt.Errorf("listen for local UI: %w", err)
	}
	addr := listener.Addr().(*net.TCPAddr)
	host := net.JoinHostPort("127.0.0.1", fmt.Sprint(addr.Port))
	server := &http.Server{Handler: newUIHandler(bundle, host), ReadHeaderTimeout: 5 * time.Second}
	url := "http://" + host + "/local"
	fmt.Fprintf(out, "Sveltos UI %s: %s\n", bundle.version, url)
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	if !noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Fprintf(errOut, "Could not open browser: %v\n", err)
		}
	}
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return fmt.Errorf("stop local UI: %w", err)
		}
		err := <-serveErr
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve local UI: %w", err)
	}
}

func openBrowser(target string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command, args = "open", []string{target}
	case "windows":
		command, args = "rundll32", []string{"url.dll,FileProtocolHandler", target}
	default:
		command, args = "xdg-open", []string{target}
	}
	cmd := exec.Command(command, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
