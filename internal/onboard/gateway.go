package onboard

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultGatewayHost is the registry of ConfigHub's hosted service,
// hub.confighub.com: the gateway a plan names when there is no login to ask.
const DefaultGatewayHost = "oci.hub.confighub.com"

// Gateway is the registry Sveltos fetches each variant's releases from: the
// OCI registry of the ConfigHub server the fleet is onboarded to, at the
// address the management cluster reaches it by.
type Gateway struct {
	// Host is host or host:port.
	Host string
	// PlainHTTP fetches over HTTP instead of TLS, as from a ConfigHub server
	// run on a laptop.
	PlainHTTP bool
}

// String is the gateway as --gateway takes it.
func (g Gateway) String() string {
	if g.PlainHTTP {
		return "http://" + g.Host
	}
	return g.Host
}

// reference is the gateway's reference to a Space's latest release.
func (g Gateway) reference(space string) string {
	return fmt.Sprintf("oci://%s/space/%s:%s", g.Host, space, releaseTag)
}

// remoteURL is a policyRefs entry's remoteURL for a Space's latest release,
// with the Secret that holds the gateway credential.
func (g Gateway) remoteURL(space, secretName string) *yaml.Node {
	n := mapping(
		scalar("url"), scalar(g.reference(space)),
		scalar("interval"), scalar(fetchInterval),
		scalar("secretRef"), mapping(scalar("name"), scalar(secretName), scalar("namespace"), scalar(secretNamespace)))
	if g.PlainHTTP {
		n.Content = append(n.Content, scalar("plainHTTP"), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	}
	return n
}

// serves says whether a reference is to one of this gateway's releases.
func (g Gateway) serves(ref string) bool {
	return strings.HasPrefix(ref, "oci://"+g.Host+"/")
}

// ParseGateway reads --gateway: host[:port] for a registry served over TLS,
// or http://host:port for one served over plain HTTP. An IPv6 address goes in
// brackets. The host is lowercased and a scheme's default port dropped, as for
// the advertised registry, so a profile written either way is recognised. A
// loopback or unspecified address is refused: Sveltos fetches from inside the
// management cluster, which cannot reach it.
func ParseGateway(s string) (Gateway, error) {
	s = strings.TrimSpace(s)
	want := fmt.Errorf("--gateway %s: want host[:port] for TLS or http://host:port for plain HTTP, with an IPv6 address in brackets", s)
	g := Gateway{}
	rest := s
	if scheme, after, ok := strings.Cut(s, "://"); ok {
		switch strings.ToLower(scheme) {
		case "http":
			g.PlainHTTP = true
		case "https":
		default:
			return Gateway{}, want
		}
		rest = after
	}
	rest = strings.ToLower(strings.TrimSuffix(rest, "/"))
	u, err := url.Parse("//" + rest)
	if err != nil || rest == "" || u.Host != rest || u.Hostname() == "" || strings.HasSuffix(rest, ":") {
		return Gateway{}, want
	}
	host, port := u.Hostname(), u.Port()
	if strings.Contains(host, ":") && !strings.HasPrefix(rest, "[") {
		return Gateway{}, want
	}
	if port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return Gateway{}, fmt.Errorf("--gateway %s: %s is not a port", s, port)
		}
	}
	if unreachable(host) {
		return Gateway{}, fmt.Errorf("--gateway %s is a loopback address your clusters cannot reach: Sveltos fetches from inside the management cluster. Name the address they reach it at, such as http://host.docker.internal:<port> for kind clusters on this machine with Docker Desktop", s)
	}
	g.Host = hostPort(host, port, g.PlainHTTP)
	return g, nil
}

// hostPort is host, or host:port when port is not the scheme's default, with
// an IPv6 host in brackets.
func hostPort(host, port string, plainHTTP bool) string {
	if port == "" || (port == "443" && !plainHTTP) || (port == "80" && plainHTTP) {
		if strings.Contains(host, ":") {
			return "[" + host + "]"
		}
		return host
	}
	return net.JoinHostPort(host, port)
}

// Registry is the OCI registry a ConfigHub server says it serves releases
// at, in GET /api/info.
type Registry struct {
	// Server is the server's URL; an http:// server serves its registry over
	// plain HTTP too.
	Server     string
	Host, Port string
}

// ResolveGateway is the gateway a plan names: the one --gateway gives, or else
// the registry of the ConfigHub server cub is logged in to, or else, with no
// login, ConfigHub's hosted registry, so a plan needs no account. registry is
// asked only without --gateway, and is nil when there is no login.
func ResolveGateway(flag string, registry func() (*Registry, error)) (Gateway, error) {
	if flag != "" {
		return ParseGateway(flag)
	}
	r, err := registry()
	if err != nil {
		return Gateway{}, fmt.Errorf("asking ConfigHub which registry Sveltos fetches its releases from: %w; name it with --gateway", err)
	}
	if r == nil {
		return Gateway{Host: DefaultGatewayHost}, nil
	}
	if r.Host == "" {
		return Gateway{}, fmt.Errorf("ConfigHub at %s names no registry to fetch its releases from; name the one your clusters reach with --gateway", r.Server)
	}
	g := Gateway{PlainHTTP: strings.HasPrefix(r.Server, "http://")}
	g.Host = hostPort(strings.ToLower(strings.Trim(r.Host, "[]")), r.Port, g.PlainHTTP)
	if unreachable(r.Host) {
		port := r.Port
		if port == "" {
			port = "<port>"
		}
		return Gateway{}, fmt.Errorf("ConfigHub at %s serves its releases at %s, a loopback address your clusters cannot reach: Sveltos fetches from inside the management cluster. Name the address they reach it at with --gateway, such as --gateway http://host.docker.internal:%s for kind clusters on this machine", r.Server, g.Host, port)
	}
	return g, nil
}

// unreachable is a loopback or unspecified address: one a cluster cannot
// fetch from.
func unreachable(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}
