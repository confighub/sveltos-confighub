package onboard

import (
	"bytes"
	"errors"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

// Doc is one Kubernetes object from the input, kept twice: as a value for the
// plan's logic, and as a YAML node so what the plan writes keeps the user's own
// key order and formatting.
type Doc struct {
	Node  *yaml.Node
	Value map[string]any
}

// ParseDocs reads every object in a multi-document YAML or JSON stream,
// flattening kubectl's List output into its items.
func ParseDocs(data []byte) ([]Doc, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var out []Doc
	for {
		var root yaml.Node
		err := dec.Decode(&root)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("reading YAML: %w", err)
		}
		if len(root.Content) == 0 {
			continue
		}
		docs, err := flatten(root.Content[0])
		if err != nil {
			return nil, err
		}
		out = append(out, docs...)
	}
}

func flatten(node *yaml.Node) ([]Doc, error) {
	if node.Kind != yaml.MappingNode {
		return nil, nil
	}
	var value map[string]any
	if err := node.Decode(&value); err != nil {
		return nil, fmt.Errorf("reading an object: %w", err)
	}
	if value["kind"] == "List" {
		items := mapGet(node, "items")
		if items == nil || items.Kind != yaml.SequenceNode {
			return nil, nil
		}
		var out []Doc
		for _, item := range items.Content {
			docs, err := flatten(item)
			if err != nil {
				return nil, err
			}
			out = append(out, docs...)
		}
		return out, nil
	}
	return []Doc{{Node: node, Value: value}}, nil
}

func mapGet(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func scalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func mapping(pairs ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: pairs}
}

func emptySeq() *yaml.Node {
	return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
}

func deepCopy(node *yaml.Node) *yaml.Node {
	if node == nil {
		return nil
	}
	out := *node
	out.Content = make([]*yaml.Node, len(node.Content))
	for i, child := range node.Content {
		out.Content[i] = deepCopy(child)
	}
	return &out
}

// EncodeYAML writes nodes or values as YAML documents with two-space indents.
func EncodeYAML(docs ...any) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, doc := range docs {
		if err := enc.Encode(doc); err != nil {
			return nil, err
		}
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
