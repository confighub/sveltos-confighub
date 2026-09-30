package onboard

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// With --management-release the management record is delivered from
// ConfigHub: the Space releases to the management cluster's Target, each
// profile's delivery profiles join the record once its variants have
// releases, and one root profile fetches the record.
func TestManagementRelease(t *testing.T) {
	opts := exampleOpts
	opts.ManagementRelease = true
	plan := mustPlan(t, exampleDocs(t), opts)
	dir := t.TempDir()
	if _, err := WriteApply(plan, dir); err != nil {
		t.Fatal(err)
	}
	root, err := os.ReadFile(filepath.Join(dir, "management", "root.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"kind: ClusterProfile", "name: sveltos-management", "kind: SveltosCluster", "namespace: mgmt",
		"stopMatchingBehavior: LeavePolicies", "url: oci://oci.hub.confighub.com/space/sveltos-management:latest", "name: confighub-sveltos-targets"} {
		if !strings.Contains(string(root), want) {
			t.Errorf("root.yaml lacks %q:\n%s", want, root)
		}
	}
	script, _ := os.ReadFile(filepath.Join(dir, "apply.sh"))
	s := string(script)
	for _, want := range []string{"MANAGEMENT=sveltos-management", "cub space update sveltos-management --release-target sveltos-targets/mgmt --quiet",
		"record() {", "publish_record() {", "record kyverno delivery-kyverno health-kyverno sveltos-kyverno-staging-eu", "\npublish_record\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("apply.sh lacks %q", want)
		}
	}
	if strings.Contains(s, "cub unit update --space sveltos-management delivery-kyverno management/kyverno.yaml --change-desc 'The delivery profiles for every kyverno variant this plan holds'") {
		t.Errorf("step 4 must not put every delivery profile in the record before its variant has a release")
	}
	if strings.Contains(s, "\ndeliver kyverno") {
		t.Errorf("the delivery profiles reach the management cluster through the record, not kubectl")
	}
	if !strings.Contains(RenderPlan(plan, true), "  root     management/root.yaml, applied once") {
		t.Errorf("the plan says the record is delivered from ConfigHub")
	}
	if out, err := exec.Command("bash", "-n", filepath.Join(dir, "apply.sh")).CombinedOutput(); err != nil {
		t.Errorf("apply.sh does not parse: %s", out)
	}
	// Without the option, nothing changes: no root, and no record helpers.
	plain := mustPlan(t, exampleDocs(t), exampleOpts)
	dir = t.TempDir()
	if _, err := WriteApply(plain, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "management", "root.yaml")); err == nil {
		t.Errorf("no root profile without --management-release")
	}
	if script, _ := os.ReadFile(filepath.Join(dir, "apply.sh")); strings.Contains(string(script), "record()") {
		t.Errorf("no record helpers without --management-release")
	}
}
