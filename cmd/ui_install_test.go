package cmd

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func makeUIArchive(t *testing.T, entries map[string][]byte) (string, string) {
	t.Helper()
	name := filepath.Join(t.TempDir(), "bundle.tar.gz")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for path, body := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: path, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	return name, hex.EncodeToString(sum[:])
}

func goodUIArchive(t *testing.T, version string) (string, string) {
	t.Helper()
	body := []byte("<h1>" + version + "</h1>")
	sum := sha256.Sum256(body)
	manifest, err := json.Marshal(uiBundleManifest{APIVersion: uiManifestVersion, Version: version, Files: map[string]string{"index.html": hex.EncodeToString(sum[:])}})
	if err != nil {
		t.Fatal(err)
	}
	return makeUIArchive(t, map[string][]byte{"index.html": body, uiManifestName: manifest})
}

func TestInstallUIArchiveRejectsTamperingBeforeExtraction(t *testing.T) {
	archive, digest := goodUIArchive(t, "valid")
	if err := os.WriteFile(archive, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := installUIArchive(archive, digest, filepath.Join(t.TempDir(), "install"))
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("tampered archive error = %v", err)
	}
}

func TestExtractUIArchiveRejectsTraversalDuplicateLinksAndBombs(t *testing.T) {
	tests := []struct {
		name    string
		entries []struct {
			name string
			body []byte
			typ  byte
			size int64
		}
		want string
	}{
		{name: "traversal", entries: []struct {
			name string
			body []byte
			typ  byte
			size int64
		}{{"../outside", []byte("x"), tar.TypeReg, 1}}, want: "invalid relative"},
		{name: "duplicate", entries: []struct {
			name string
			body []byte
			typ  byte
			size int64
		}{{"index.html", []byte("a"), tar.TypeReg, 1}, {"index.html", []byte("b"), tar.TypeReg, 1}}, want: "duplicate"},
		{name: "symlink", entries: []struct {
			name string
			body []byte
			typ  byte
			size int64
		}{{"index.html", nil, tar.TypeSymlink, 0}}, want: "unsupported type"},
		{name: "oversize", entries: []struct {
			name string
			body []byte
			typ  byte
			size int64
		}{{"large", nil, tar.TypeReg, uiInstallLimit + 1}}, want: "exceeds"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			archive := filepath.Join(t.TempDir(), "bad.tar.gz")
			f, err := os.Create(archive)
			if err != nil {
				t.Fatal(err)
			}
			gz := gzip.NewWriter(f)
			tw := tar.NewWriter(gz)
			for _, e := range tc.entries {
				if err := tw.WriteHeader(&tar.Header{Name: e.name, Typeflag: e.typ, Mode: 0o644, Size: e.size, Linkname: "target"}); err != nil {
					t.Fatal(err)
				}
				if len(e.body) > 0 {
					if _, err := tw.Write(e.body); err != nil {
						t.Fatal(err)
					}
				}
			}
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			err = extractUIArchive(archive, t.TempDir())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("extract error = %v; want %q", err, tc.want)
			}
		})
	}
}

func TestInstallUIArchiveRequiresValidManifestAndRetainsPriorDefaultOnFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	first, firstDigest := goodUIArchive(t, "v1")
	if err := installUIArchive(first, firstDigest, root); err != nil {
		t.Fatal(err)
	}
	firstDir, err := installedUIBundleDirAt(root)
	if err != nil {
		t.Fatal(err)
	}
	badManifest, badDigest := makeUIArchive(t, map[string][]byte{"index.html": []byte("missing manifest")})
	err = installUIArchive(badManifest, badDigest, root)
	if err == nil || !strings.Contains(err.Error(), "manifest validation") {
		t.Fatalf("missing manifest error = %v", err)
	}
	current, err := installedUIBundleDirAt(root)
	if err != nil {
		t.Fatal(err)
	}
	if current != firstDir {
		t.Fatalf("failed install changed default: got %q, want %q", current, firstDir)
	}
}

func TestInstallUIArchivePublishesValidBundleAsDefault(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	archive, digest := goodUIArchive(t, "plugin-ui-v0.1.0")
	if err := installUIArchive(archive, digest, root); err != nil {
		t.Fatal(err)
	}
	dir, err := installedUIBundleDirAt(root)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := loadUIBundle(dir)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.version != "plugin-ui-v0.1.0" {
		t.Fatalf("installed version = %q", bundle.version)
	}
	if !strings.Contains(dir, digest) {
		t.Fatalf("bundle cache path %q does not use archive digest %s", dir, digest)
	}
}

func TestUIInstallFlagsRequireOneCompleteMode(t *testing.T) {
	cases := [][]string{{}, {"--version", "v1", "--archive", "a", "--sha256", strings.Repeat("a", 64)}, {"--archive", "a"}, {"--sha256", strings.Repeat("a", 64)}}
	for _, args := range cases {
		t.Run(fmt.Sprint(args), func(t *testing.T) {
			cmd := newUIInstallCommand()
			cmd.SilenceUsage, cmd.SilenceErrors = true, true
			cmd.SetArgs(args)
			if err := cmd.Execute(); err == nil {
				t.Fatalf("flags %v unexpectedly succeeded", args)
			}
		})
	}
}

func TestUIReleaseTagMustBePinnedPluginUIVersion(t *testing.T) {
	for _, tag := range []string{"plugin-ui-v0.1.0", "plugin-ui-v1.2.3-rc.1", "plugin-ui-v2.0.0-preview-2"} {
		if !uiReleaseTagPattern.MatchString(tag) {
			t.Errorf("valid release tag rejected: %q", tag)
		}
	}
	for _, tag := range []string{"latest", "v0.1.0", "plugin-ui-v0.1", "plugin-ui-v0.1.0/../../other", " plugin-ui-v0.1.0", "plugin-ui-v0.1.0 "} {
		if uiReleaseTagPattern.MatchString(tag) {
			t.Errorf("unpinned or malformed release tag accepted: %q", tag)
		}
	}
}

func TestUIReleaseInstallThroughFakeGHSelectsDefaultBundle(t *testing.T) {
	archive, digest := goodUIArchive(t, "plugin-ui-v0.1.0")
	checksumPath := filepath.Join(t.TempDir(), uiChecksumName)
	if err := os.WriteFile(checksumPath, []byte(digest+"  "+uiArchiveName+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	argsFile := filepath.Join(t.TempDir(), "gh-args")
	ghPath := filepath.Join(binDir, "gh")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$@\" > \"$FAKE_GH_ARGS\"\n" +
		"out=''\n" +
		"while [ $# -gt 0 ]; do\n" +
		"  if [ \"$1\" = '--dir' ]; then shift; out=$1; fi\n" +
		"  shift\n" +
		"done\n" +
		"cp \"$FAKE_UI_ARCHIVE\" \"$out/" + uiArchiveName + "\"\n" +
		"cp \"$FAKE_UI_CHECKSUM\" \"$out/" + uiChecksumName + "\"\n"
	if err := os.WriteFile(ghPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_UI_ARCHIVE", archive)
	t.Setenv("FAKE_UI_CHECKSUM", checksumPath)
	t.Setenv("FAKE_GH_ARGS", argsFile)
	configHome := t.TempDir()
	t.Setenv("HOME", configHome)
	t.Setenv("XDG_CONFIG_HOME", configHome)

	install := newUICommand()
	var installOutput bytes.Buffer
	install.SetOut(&installOutput)
	install.SetErr(&installOutput)
	install.SetArgs([]string{"install", "--version", "plugin-ui-v0.1.0"})
	if err := install.Execute(); err != nil {
		t.Fatalf("release installation failed: %v\n%s", err, installOutput.String())
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"release\ndownload\nplugin-ui-v0.1.0", "--repo\nconfighub/ui", "--pattern\n" + uiArchiveName, "--pattern\n" + uiChecksumName} {
		if !bytes.Contains(args, []byte(expected)) {
			t.Errorf("gh arguments omit %q:\n%s", expected, args)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	serve := newUICommand()
	var serveOutput bytes.Buffer
	serve.SetOut(&serveOutput)
	serve.SetErr(&serveOutput)
	serve.SetArgs([]string{"--no-browser"})
	if err := serve.ExecuteContext(ctx); err != nil {
		t.Fatalf("default installed UI launch failed: %v\n%s", err, serveOutput.String())
	}
	if !strings.Contains(serveOutput.String(), "Sveltos UI plugin-ui-v0.1.0: http://127.0.0.1:") {
		t.Fatalf("default UI did not serve the installed release: %q", serveOutput.String())
	}
}

func TestDownloadUIReleaseRejectsOversizedChecksumFile(t *testing.T) {
	archive, _ := goodUIArchive(t, "plugin-ui-v0.1.0")
	checksumPath := filepath.Join(t.TempDir(), uiChecksumName)
	if err := os.WriteFile(checksumPath, bytes.Repeat([]byte("x"), 4097), 0o600); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	ghPath := filepath.Join(binDir, "gh")
	script := "#!/bin/sh\n" +
		"while [ $# -gt 0 ]; do if [ \"$1\" = '--dir' ]; then shift; out=$1; fi; shift; done\n" +
		"cp \"$FAKE_UI_ARCHIVE\" \"$out/" + uiArchiveName + "\"\n" +
		"cp \"$FAKE_UI_CHECKSUM\" \"$out/" + uiChecksumName + "\"\n"
	if err := os.WriteFile(ghPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_UI_ARCHIVE", archive)
	t.Setenv("FAKE_UI_CHECKSUM", checksumPath)
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	_, _, err := downloadUIRelease(cmd, "plugin-ui-v0.1.0")
	if err == nil || !strings.Contains(err.Error(), "4096 bytes") {
		t.Fatalf("oversized checksum error = %v", err)
	}
}
