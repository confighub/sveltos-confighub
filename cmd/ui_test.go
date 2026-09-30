package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeUIBundle(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	manifest := uiBundleManifest{APIVersion: uiManifestVersion, Version: "test-1", Files: map[string]string{}}
	for name, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(body))
		manifest.Files[name] = hex.EncodeToString(sum[:])
	}
	b, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, uiManifestName), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadUIBundleRequiresManifestIndexAndMatchingDigests(t *testing.T) {
	if _, err := loadUIBundle(t.TempDir()); err == nil {
		t.Fatal("missing manifest was accepted")
	}
	dir := writeUIBundle(t, map[string]string{"app.js": "console.log(1)"})
	if _, err := loadUIBundle(dir); err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Fatalf("missing index: %v", err)
	}
	dir = writeUIBundle(t, map[string]string{"index.html": "<main>verified</main>"})
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadUIBundle(dir); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("digest mismatch: %v", err)
	}
}

func TestLoadUIBundleRejectsSymlinksAndTraversalManifest(t *testing.T) {
	dir := writeUIBundle(t, map[string]string{"index.html": "ok", "assets/app.js": "app"})
	if err := os.Remove(filepath.Join(dir, "assets", "app.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "index.html"), filepath.Join(dir, "assets", "app.js")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := loadUIBundle(dir); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink accepted: %v", err)
	}
	if err := validateBundlePath("../outside"); err == nil {
		t.Fatal("traversal manifest path accepted")
	}
}

func testUIHandler(t *testing.T) (http.Handler, string) {
	t.Helper()
	bundle, err := loadUIBundle(writeUIBundle(t, map[string]string{
		"index.html":           "<html><script src=\"/assets/app.js\"></script><a href=\"/examples/sample.json\"></a><img src=\"/confighub.png\"></html>",
		"assets/app.js":        "window.app=1",
		"examples/sample.json": `{"sample":true}`,
		"confighub.png":        "image-bytes",
		"api/state.json":       `{"must":"not be served"}`,
		"auth/callback":        "must not be served",
	}))
	if err != nil {
		t.Fatal(err)
	}
	host := "127.0.0.1:32123"
	return newUIHandler(bundle, host), host
}

func uiRequest(handler http.Handler, host, method, target, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestUIHandlerServesOnlyVerifiedAssetsAndSPA(t *testing.T) {
	handler, host := testUIHandler(t)
	index := `<html><script src="/assets/app.js"></script><a href="/examples/sample.json"></a><img src="/confighub.png"></html>`
	for _, target := range []string{"/local", "/local/"} {
		w := uiRequest(handler, host, http.MethodGet, target, "")
		if w.Code != http.StatusOK || w.Body.String() != index {
			t.Errorf("%s => %d %q", target, w.Code, w.Body.String())
		}
	}
	for target, body := range map[string]string{"/assets/app.js": "window.app=1", "/examples/sample.json": `{"sample":true}`, "/confighub.png": "image-bytes"} {
		w := uiRequest(handler, host, http.MethodGet, target, "http://"+host)
		if w.Code != http.StatusOK || w.Body.String() != body {
			t.Fatalf("asset %s response: %d %q", target, w.Code, w.Body.String())
		}
	}
	for _, target := range []string{"/assets/missing.js", "/local/preview/space"} {
		w := uiRequest(handler, host, http.MethodGet, target, "")
		if w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), "<html>") {
			t.Errorf("missing file %s fell back to index: %d %q", target, w.Code, w.Body.String())
		}
	}
	w := uiRequest(handler, host, http.MethodHead, "/assets/app.js", "")
	if w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Fatalf("HEAD response: %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing nosniff: %v", w.Header())
	}
}

func TestUIHandlerRejectsMethodsAPIsTraversalHostAndCrossOrigin(t *testing.T) {
	handler, host := testUIHandler(t)
	tests := []struct {
		name, method, target, requestHost, origin string
		status                                    int
	}{
		{"post", "POST", "/local", host, "", http.StatusMethodNotAllowed},
		{"api", "GET", "/api/status", host, "", http.StatusNotFound},
		{"api listed in bundle", "GET", "/api/state.json", host, "", http.StatusNotFound},
		{"auth listed in bundle", "GET", "/auth/callback", host, "", http.StatusNotFound},
		{"local api", "GET", "/local/api/status", host, "", http.StatusNotFound},
		{"host", "GET", "/local", "attacker.example", "", http.StatusMisdirectedRequest},
		{"cross origin", "GET", "/local", host, "https://attacker.example", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := uiRequest(handler, tc.requestHost, tc.method, tc.target, tc.origin)
			if w.Code != tc.status {
				t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body.String())
			}
		})
	}
	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/", nil)
	req.Host = host
	req.URL = &url.URL{Path: "/local/../secret"}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("traversal was not rejected: %d", w.Code)
	}
}

func TestRunUIContextShutdown(t *testing.T) {
	dir := writeUIBundle(t, map[string]string{"index.html": "running"})
	ctx, cancel := context.WithCancel(context.Background())
	output := &lockedBuffer{}
	done := make(chan error, 1)
	go func() { done <- runUI(ctx, dir, 0, true, output, &strings.Builder{}) }()
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(output.String(), "http://127.0.0.1:") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	line := strings.TrimSpace(output.String())
	if line == "" {
		cancel()
		t.Fatal("server did not print its URL")
	}
	var port int
	if _, err := fmt.Sscanf(line, "Sveltos UI test-1: http://127.0.0.1:%d/local", &port); err != nil {
		cancel()
		t.Fatalf("unexpected output %q: %v", line, err)
	}
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/local", port))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("server status %d", resp.StatusCode)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not shut down")
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }
