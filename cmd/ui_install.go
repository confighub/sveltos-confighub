package cmd

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
)

const (
	uiArchiveName       = "confighub-plugin-ui.tar.gz"
	uiChecksumName      = uiArchiveName + ".sha256"
	uiInstallLimit      = int64(100 << 20)
	uiMaxArchiveEntries = 20000
)

var uiReleaseTagPattern = regexp.MustCompile(`^plugin-ui-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`)

func newUIInstallCommand() *cobra.Command {
	var version, archive, checksum string
	c := &cobra.Command{
		Use:   "install",
		Short: "Install an optional verified plugin UI bundle",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if (archive == "") != (checksum == "") {
				return errors.New("--archive and --sha256 must be supplied together")
			}
			if (archive != "") == (version != "") {
				return errors.New("choose either --version or both --archive and --sha256")
			}
			root, err := uiInstallRoot()
			if err != nil {
				return err
			}
			if version != "" {
				archive, checksum, err = downloadUIRelease(cmd, version)
				if err != nil {
					return err
				}
				defer os.Remove(archive)
			}
			if err := installUIArchive(archive, checksum, root); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Installed plugin UI bundle from %s\n", versionOrArchive(version, archive))
			return nil
		},
	}
	c.Flags().StringVar(&version, "version", "", "pinned confighub/ui release tag (plugin-ui-vX.Y.Z, optionally with a prerelease suffix)")
	c.Flags().StringVar(&archive, "archive", "", "local bundle archive for offline installation")
	c.Flags().StringVar(&checksum, "sha256", "", "expected SHA-256 digest for --archive")
	return c
}

func versionOrArchive(version, archive string) string {
	if version != "" {
		return version
	}
	return filepath.Base(archive)
}

func uiInstallRoot() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user config directory: %w", err)
	}
	return filepath.Join(base, "cub", "sveltos", "plugin-ui"), nil
}

func downloadUIRelease(cmd *cobra.Command, version string) (string, string, error) {
	if !uiReleaseTagPattern.MatchString(version) {
		return "", "", errors.New("--version must be a pinned plugin-ui-vX.Y.Z tag, optionally with a prerelease suffix")
	}
	tmp, err := os.MkdirTemp("", "cub-sveltos-ui-release-")
	if err != nil {
		return "", "", fmt.Errorf("create UI download directory: %w", err)
	}
	defer os.RemoveAll(tmp)
	gh, err := exec.LookPath("gh")
	if err != nil {
		return "", "", errors.New("installing a release requires the GitHub CLI (gh); authenticate with gh auth login")
	}
	args := []string{"release", "download", version, "--repo", "confighub/ui", "--pattern", uiArchiveName, "--pattern", uiChecksumName, "--dir", tmp}
	process := exec.CommandContext(cmd.Context(), gh, args...)
	process.Stdout, process.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
	if err := process.Run(); err != nil {
		return "", "", fmt.Errorf("download UI release %q with gh: %w", version, err)
	}
	archive := filepath.Join(tmp, uiArchiveName)
	checksumPath := filepath.Join(tmp, uiChecksumName)
	archiveInfo, err := os.Lstat(archive)
	if err != nil {
		return "", "", fmt.Errorf("inspect downloaded UI archive: %w", err)
	}
	if !archiveInfo.Mode().IsRegular() || archiveInfo.Size() < 0 || archiveInfo.Size() > uiInstallLimit {
		return "", "", fmt.Errorf("downloaded UI archive must be a regular file no larger than %d bytes", uiInstallLimit)
	}
	checksumInfo, err := os.Lstat(checksumPath)
	if err != nil {
		return "", "", fmt.Errorf("inspect downloaded UI checksum: %w", err)
	}
	if !checksumInfo.Mode().IsRegular() {
		return "", "", errors.New("downloaded UI checksum must be a regular file")
	}
	if checksumInfo.Size() > 4096 {
		return "", "", errors.New("downloaded UI checksum file exceeds 4096 bytes")
	}
	checksumFile, err := os.Open(checksumPath)
	if err != nil {
		return "", "", fmt.Errorf("read downloaded UI checksum: %w", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(checksumFile, 4097))
	closeErr := checksumFile.Close()
	if readErr == nil {
		readErr = closeErr
	}
	if readErr != nil {
		return "", "", fmt.Errorf("read downloaded UI checksum: %w", readErr)
	}
	if len(data) > 4096 {
		return "", "", errors.New("downloaded UI checksum file exceeds 4096 bytes")
	}
	digest, err := parseUIChecksum(data)
	if err != nil {
		return "", "", err
	}
	// Copy the archive out of the temporary download directory. The caller owns
	// and removes this private temporary file after installation.
	owned, err := os.CreateTemp("", "cub-sveltos-ui-*.tar.gz")
	if err != nil {
		return "", "", fmt.Errorf("create temporary UI archive: %w", err)
	}
	defer owned.Close()
	source, err := os.Open(archive)
	if err != nil {
		_ = os.Remove(owned.Name())
		return "", "", fmt.Errorf("open downloaded UI archive: %w", err)
	}
	_, copyErr := io.Copy(owned, io.LimitReader(source, uiInstallLimit+1))
	closeErr = source.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		copyErr = owned.Close()
	}
	if copyErr != nil {
		_ = os.Remove(owned.Name())
		return "", "", fmt.Errorf("copy downloaded UI archive: %w", copyErr)
	}
	return owned.Name(), digest, nil
}

func parseUIChecksum(data []byte) (string, error) {
	fields := strings.Fields(string(data))
	if len(fields) != 2 || len(fields[0]) != sha256.Size*2 || fields[1] != uiArchiveName && fields[1] != "*"+uiArchiveName {
		return "", errors.New("UI checksum file must contain a SHA-256 digest and confighub-plugin-ui.tar.gz filename")
	}
	if _, err := hex.DecodeString(fields[0]); err != nil {
		return "", errors.New("UI checksum file has an invalid SHA-256 digest")
	}
	return strings.ToLower(fields[0]), nil
}

// installedUIBundleDir resolves the atomically published pointer, while
// leaving explicit --assets-dir and CUB_UI_DIR overrides to the caller.
func installedUIBundleDir() (string, error) {
	root, err := uiInstallRoot()
	if err != nil {
		return "", err
	}
	return installedUIBundleDirAt(root)
}

func installedUIBundleDirAt(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "current"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read installed UI selection: %w", err)
	}
	digest := strings.TrimSpace(string(data))
	if len(digest) != sha256.Size*2 || strings.ToLower(digest) != digest {
		return "", errors.New("installed UI selection is invalid")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", errors.New("installed UI selection is invalid")
	}
	dir := filepath.Join(root, "bundles", digest)
	if _, err := loadUIBundle(dir); err != nil {
		return "", fmt.Errorf("installed UI bundle is invalid: %w", err)
	}
	return dir, nil
}

func installUIArchive(archive, expectedSHA256, root string) error {
	if len(expectedSHA256) != sha256.Size*2 || strings.ToLower(expectedSHA256) != expectedSHA256 {
		return errors.New("--sha256 must be a 64-character lowercase SHA-256 digest")
	}
	if _, err := hex.DecodeString(expectedSHA256); err != nil {
		return errors.New("--sha256 must be a 64-character lowercase SHA-256 digest")
	}
	f, err := os.Open(archive)
	if err != nil {
		return fmt.Errorf("open UI archive: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("inspect UI archive: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > uiInstallLimit {
		_ = f.Close()
		return fmt.Errorf("UI archive must be a regular file no larger than %d bytes", uiInstallLimit)
	}
	snapshot, err := os.CreateTemp("", "cub-sveltos-ui-archive-*.tar.gz")
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("create temporary UI archive snapshot: %w", err)
	}
	snapshotPath := snapshot.Name()
	defer os.Remove(snapshotPath)
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(h, snapshot), io.LimitReader(f, uiInstallLimit+1))
	if err == nil {
		err = f.Close()
	} else {
		_ = f.Close()
	}
	if closeErr := snapshot.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("hash UI archive: %w", err)
	}
	if n > uiInstallLimit {
		return fmt.Errorf("UI archive exceeds %d bytes", uiInstallLimit)
	}
	if n != info.Size() {
		return errors.New("UI archive changed while it was read")
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if digest != expectedSHA256 {
		return errors.New("UI archive does not match the supplied SHA-256 digest")
	}
	if err := os.MkdirAll(filepath.Join(root, "bundles"), 0o755); err != nil {
		return fmt.Errorf("create UI install directory: %w", err)
	}
	stage, err := os.MkdirTemp(root, ".staging-")
	if err != nil {
		return fmt.Errorf("create UI staging directory: %w", err)
	}
	defer os.RemoveAll(stage)
	if err := extractUIArchive(snapshotPath, stage); err != nil {
		return err
	}
	if _, err := loadUIBundle(stage); err != nil {
		return fmt.Errorf("downloaded UI bundle failed manifest validation: %w", err)
	}
	target := filepath.Join(root, "bundles", digest)
	if _, err := os.Lstat(target); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(stage, target); err != nil {
			return fmt.Errorf("activate UI bundle files: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("inspect cached UI bundle: %w", err)
	} else {
		if _, err := loadUIBundle(target); err != nil {
			return fmt.Errorf("cached UI bundle is invalid: %w", err)
		}
	}
	return publishUIDefault(root, digest)
}

func publishUIDefault(root, digest string) error {
	tmp, err := os.CreateTemp(root, ".current-")
	if err != nil {
		return fmt.Errorf("create UI selection file: %w", err)
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := io.WriteString(tmp, digest+"\n"); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write UI selection file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync UI selection file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close UI selection file: %w", err)
	}
	if err := os.Rename(name, filepath.Join(root, "current")); err != nil {
		return fmt.Errorf("activate UI bundle: %w", err)
	}
	return nil
}

func extractUIArchive(archive, destination string) error {
	f, err := os.Open(archive)
	if err != nil {
		return fmt.Errorf("open UI archive: %w", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("open compressed UI archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	var total int64
	entries := 0
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read UI archive: %w", err)
		}
		entries++
		if entries > uiMaxArchiveEntries {
			return fmt.Errorf("UI archive exceeds %d entries", uiMaxArchiveEntries)
		}
		rel := h.Name
		isDir := h.Typeflag == tar.TypeDir
		if isDir {
			rel = strings.TrimSuffix(rel, "/")
		}
		if err := validateBundlePath(rel); err != nil {
			return fmt.Errorf("invalid UI archive path %q: %w", h.Name, err)
		}
		if seen[rel] {
			return fmt.Errorf("duplicate UI archive path %q", rel)
		}
		seen[rel] = true
		if isDir {
			if h.Size != 0 {
				return fmt.Errorf("UI archive directory %q has data", rel)
			}
			if err := os.MkdirAll(filepath.Join(destination, filepath.FromSlash(rel)), 0o755); err != nil {
				return fmt.Errorf("create UI archive directory %q: %w", rel, err)
			}
			continue
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return fmt.Errorf("UI archive entry %q has unsupported type", rel)
		}
		if h.Size < 0 || h.Size > uiInstallLimit || total+h.Size > uiInstallLimit {
			return fmt.Errorf("extracted UI bundle exceeds %d bytes", uiInstallLimit)
		}
		full := filepath.Join(destination, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return fmt.Errorf("create UI asset parent: %w", err)
		}
		out, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return fmt.Errorf("create UI archive file %q: %w", rel, err)
		}
		written, copyErr := io.CopyN(out, tr, h.Size)
		closeErr := out.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return fmt.Errorf("extract UI archive file %q: %w", rel, copyErr)
		}
		if written != h.Size {
			return fmt.Errorf("extract UI archive file %q: truncated entry", rel)
		}
		total += written
	}
	return nil
}
