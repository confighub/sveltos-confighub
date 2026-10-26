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
// or http://host:port for one served over plain HTTP.
func ParseGateway(s string) (Gateway, error) {
	s = strings.TrimSpace(s)
	g := Gateway{}
	rest := s
	if scheme, after, ok := strings.Cut(s, "://"); ok {
		switch scheme {
		case "http":
			g.PlainHTTP = true
		case "https":
		default:
			return Gateway{}, fmt.Errorf("--gateway %s: want host[:port] for TLS or http://host:port for plain HTTP", s)
		}
		rest = strings.TrimSuffix(after, "/")
	}
	u, err := url.Parse("//" + rest)
	if err != nil || rest == "" || u.Host != rest || u.Hostname() == "" {
		return Gateway{}, fmt.Errorf("--gateway %s: want host[:port] for TLS or http://host:port for plain HTTP", s)
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return Gateway{}, fmt.Errorf("--gateway %s: %s is not a port", s, p)
		}
	}
	g.Host = rest
	return g, nil
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
	g := Gateway{Host: r.Host, PlainHTTP: strings.HasPrefix(r.Server, "http://")}
	if r.Port != "" && !(r.Port == "443" && !g.PlainHTTP) && !(r.Port == "80" && g.PlainHTTP) {
		g.Host = net.JoinHostPort(r.Host, r.Port)
	}
	if loopback(r.Host) {
		port := r.Port
		if port == "" {
			port = "<port>"
		}
		return Gateway{}, fmt.Errorf("ConfigHub at %s serves its releases at %s, a loopback address your clusters cannot reach: Sveltos fetches from inside the management cluster. Name the address they reach it at with --gateway, such as --gateway http://host.docker.internal:%s for kind clusters on this machine", r.Server, g.Host, port)
	}
	return g, nil
}

func loopback(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
