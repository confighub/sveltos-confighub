package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOptionalUIInstallScript(t *testing.T) {
	for _, tt := range []struct {
		name string
		args []string
		want string
		fail bool
	}{
		{"CLI only", nil, "plugin install confighub/sveltos-confighub\n", false},
		{"opt in", []string{"--with-ui", "plugin-ui-v0.1.0"}, "plugin install confighub/sveltos-confighub\nsveltos ui install --version plugin-ui-v0.1.0\n", false},
		{"invalid tag", []string{"--with-ui", "latest"}, "", true},
		{"missing tag", []string{"--with-ui"}, "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			log := filepath.Join(dir, "calls")
			if err := os.WriteFile(filepath.Join(dir, "cub"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TEST_CALLS\"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			c := exec.Command("bash", append([]string{"../scripts/install-plugin.sh"}, tt.args...)...)
			c.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "TEST_CALLS="+log)
			out, err := c.CombinedOutput()
			if (err != nil) != tt.fail {
				t.Fatalf("err=%v output=%s", err, out)
			}
			data, err := os.ReadFile(log)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(data)) != strings.TrimSpace(tt.want) {
				t.Fatalf("calls=%q want=%q", data, tt.want)
			}
		})
	}
}
