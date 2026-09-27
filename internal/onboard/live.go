package onboard

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/confighub/sveltos-confighub/chartrender"
)

// Runner runs a command and returns what it printed; tests stand in for
// kubectl and cub with one.
type Runner func(name string, args ...string) ([]byte, error)

// Run runs a command on this machine.
func Run(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		text := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(text, "\n"); i >= 0 {
			text = text[i+1:]
		}
		return nil, fmt.Errorf("%s %s: %s", name, strings.Join(args[:min(len(args), 3)], " "), text)
	}
	return out, nil
}

// LiveCheck names one chart on one cluster: the Helm release a live profile
// installed there, and the variant unit whose releases replace it.
type LiveCheck struct {
	// Context is the management cluster's kubectl context; empty for the
	// current one.
	Context string
	// KubeconfigDir, when set, holds a <cluster>.kubeconfig for a cluster
	// whose Sveltos kubeconfig names an address only the management cluster
	// can reach.
	KubeconfigDir                          string
	ClusterKind, ClusterNamespace, Cluster string
	ReleaseNamespace, Release              string
	Space, Unit                            string
}

// LiveResult is what the check found: a comparison, or why there was nothing
// to compare.
type LiveResult struct {
	Comparison chartrender.Comparison
	Skipped    string
}

// CompareLive compares what ConfigHub last released for a variant's unit with
// the manifest Helm recorded for the release on the cluster, reaching the
// cluster the way Sveltos does, through its kubeconfig Secret on the
// management cluster.
func CompareLive(run Runner, c LiveCheck) (LiveResult, error) {
	kubectl := func(args ...string) ([]byte, error) {
		if c.Context != "" {
			args = append([]string{"--context", c.Context}, args...)
		}
		return run("kubectl", args...)
	}
	path := ""
	if c.KubeconfigDir != "" {
		if p := filepath.Join(c.KubeconfigDir, c.Cluster+".kubeconfig"); fileExists(p) {
			path = p
		}
	}
	if path == "" {
		p, done, err := sveltosKubeconfig(kubectl, c)
		if err != nil || done.Skipped != "" {
			return done, err
		}
		defer os.Remove(p)
		path = p
	}

	out, err := run("kubectl", "--kubeconfig", path, "get", "secret", "-n", c.ReleaseNamespace, "-l", "owner=helm,name="+c.Release+",status=deployed", "-o", "json")
	if err != nil {
		return LiveResult{}, fmt.Errorf("reading Helm's record on the cluster: %w. If the cluster's API server is at an address only the management cluster reaches, put a kubeconfig that reaches it at <dir>/%s.kubeconfig and set CLUSTER_KUBECONFIGS=<dir>", err, c.Cluster)
	}
	return compareRelease(run, c, out)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// sveltosKubeconfig writes, to a file only this user reads, the kubeconfig
// Sveltos reaches the cluster with: the SveltosCluster's kubeconfigName, or
// <name>-sveltos-kubeconfig, under its kubeconfigKeyName or its one key; a
// Cluster API cluster's <name>-kubeconfig, under value.
func sveltosKubeconfig(kubectl func(...string) ([]byte, error), c LiveCheck) (string, LiveResult, error) {
	secret, key := c.Cluster+"-kubeconfig", "value"
	if c.ClusterKind == "SveltosCluster" {
		out, err := kubectl("get", "sveltoscluster", "-n", c.ClusterNamespace, c.Cluster, "-o", "json")
		if err != nil {
			return "", LiveResult{}, err
		}
		var sc struct {
			Spec struct {
				KubeconfigName    string `json:"kubeconfigName"`
				KubeconfigKeyName string `json:"kubeconfigKeyName"`
				PullMode          bool   `json:"pullMode"`
			} `json:"spec"`
		}
		if err := json.Unmarshal(out, &sc); err != nil {
			return "", LiveResult{}, err
		}
		if sc.Spec.PullMode {
			return "", LiveResult{Skipped: "the cluster is in pull mode: Sveltos reaches it through its agent, so its Helm record cannot be read from the management cluster"}, nil
		}
		secret, key = c.Cluster+"-sveltos-kubeconfig", sc.Spec.KubeconfigKeyName
		if sc.Spec.KubeconfigName != "" {
			secret = sc.Spec.KubeconfigName
		}
	}
	out, err := kubectl("get", "secret", "-n", c.ClusterNamespace, secret, "-o", "json")
	if err != nil {
		return "", LiveResult{}, err
	}
	var s struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(out, &s); err != nil {
		return "", LiveResult{}, err
	}
	encoded := s.Data[key]
	if key == "" {
		for _, v := range s.Data {
			encoded = v
			break
		}
	}
	kubeconfig, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(kubeconfig) == 0 {
		return "", LiveResult{}, fmt.Errorf("no kubeconfig in Secret %s/%s", c.ClusterNamespace, secret)
	}
	f, err := os.CreateTemp("", "cluster-kubeconfig-*")
	if err != nil {
		return "", LiveResult{}, err
	}
	err = f.Chmod(0o600)
	if err == nil {
		_, err = f.Write(kubeconfig)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", LiveResult{}, err
	}
	return f.Name(), LiveResult{}, nil
}

// compareRelease compares Helm's deployed record of the release with what
// ConfigHub last released for the variant's unit.
func compareRelease(run Runner, c LiveCheck, out []byte) (LiveResult, error) {
	var releases struct {
		Items []struct {
			Data map[string]string `json:"data"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &releases); err != nil {
		return LiveResult{}, err
	}
	if len(releases.Items) == 0 {
		return LiveResult{Skipped: "Helm has no deployed record of the release there: it was handed over already, or Helm did not install it"}, nil
	}
	manifest, err := chartrender.ReleaseManifest(releases.Items[0].Data["release"])
	if err != nil {
		return LiveResult{}, err
	}

	out, err = run("cub", "unit", "get", "--space", c.Space, c.Unit, "-o", "jq=.Unit.LastReleasedRevisionNum")
	if err != nil {
		return LiveResult{}, err
	}
	released, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || released == 0 {
		return LiveResult{}, errors.New(c.Space + "/" + c.Unit + " has not been released yet: run apply.sh first")
	}
	stored, err := run("cub", "revision", "data", "--space", c.Space, c.Unit, strconv.Itoa(released))
	if err != nil {
		return LiveResult{}, err
	}
	cmp, err := chartrender.Compare([]byte(manifest), stored, c.ReleaseNamespace)
	if err != nil {
		return LiveResult{}, err
	}
	return LiveResult{Comparison: cmp}, nil
}
