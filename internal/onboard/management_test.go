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
	for _, want := range []string{"MANAGEMENT=sveltos-management MANAGEMENT_TARGET=sveltos-targets/mgmt", "cub space update sveltos-management --release-target sveltos-targets/mgmt --quiet",
		"record() {", "publish_record() {", "record kyverno delivery-kyverno health-kyverno sveltos-kyverno-staging-eu", "\npublish_record\n",
		`cat "management/variants/$s.yaml"`, `*"no changes were made since :latest bundle"*`} {
		if !strings.Contains(s, want) {
			t.Errorf("apply.sh lacks %q", want)
		}
	}
	if strings.Contains(s, "cub unit create --space sveltos-management delivery-") || strings.Contains(s, "cub unit create --space sveltos-management health-") {
		t.Errorf("step 4 must not put delivery profiles in the record before their variants have releases")
	}
	if _, err := os.Stat(filepath.Join(dir, "management", "variants", "sveltos-kyverno-staging-eu.yaml")); err != nil {
		t.Errorf("one delivery profile file per variant, for the record to take once it has a release: %v", err)
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

// With live profiles, apply.sh leaves their delivery profiles out of the
// record, and handover.sh puts them in once it has stepped the live profiles
// aside, then publishes, even when the record has nothing new.
func TestManagementReleaseHandover(t *testing.T) {
	live := mgmt + cluster("a", "projectsveltos", "env", "prod") + "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: pols, namespace: default, uid: \"9\"}\ndata: {p.yaml: \"apiVersion: kyverno.io/v1\\nkind: ClusterPolicy\\nmetadata: {name: x}\"}\n---\napiVersion: config.projectsveltos.io/v1beta1\nkind: ClusterProfile\nmetadata: {name: p, uid: \"1\"}\nspec:\n  clusterSelector: {matchLabels: {env: prod}}\n  policyRefs: [{kind: ConfigMap, namespace: default, name: pols}]\n"
	plan := mustPlan(t, parse(t, live), Options{ManagementRelease: true})
	apply := ApplyScript(plan)
	if strings.Contains(apply, "\nrecord p ") {
		t.Errorf("apply.sh must not record a live profile's delivery profiles: they wait for handover.sh")
	}
	handover := HandoverScript(plan)
	for _, want := range []string{"cub unit create --space sveltos-management delivery-p management/p.yaml --target sveltos-targets/mgmt",
		"cub unit update --space sveltos-management delivery-p management/p.yaml", "cub release publish sveltos-management --quiet",
		`*"no changes were made since :latest bundle"*`, "k apply -f management/root.yaml"} {
		if !strings.Contains(handover, want) {
			t.Errorf("handover.sh lacks %q", want)
		}
	}
	if i, j := strings.Index(handover, "delete clusterprofile p"), strings.Index(handover, "cub release publish sveltos-management"); i < 0 || j < i {
		t.Errorf("the record is published only after the live profile is stepped aside")
	}
	dir := t.TempDir()
	if _, err := WriteApply(plan, dir); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"apply.sh", "handover.sh"} {
		if out, err := exec.Command("bash", "-n", filepath.Join(dir, f)).CombinedOutput(); err != nil {
			t.Errorf("%s does not parse: %s", f, out)
		}
	}
}
