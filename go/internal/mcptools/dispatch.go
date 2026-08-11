package mcptools

import (
	"context"
	"fmt"
)

// Dispatch routes a tool call to the matching method. Returns an error on
// an unknown tool name — the one case a Claude Code client can name a tool
// this server never registered — mirroring mcp_server.py's dispatch, which
// raises KeyError for the same case. Tool calls themselves never error:
// an invented negotiation move comes back as a refusal carrying the valid
// moves, not a Go error.
func Dispatch(ctx context.Context, tools *Tools, name string, args map[string]any) (any, error) {
	switch name {
	case "who_else_is_here":
		return tools.WhoElseIsHere(ctx), nil
	case "claim_work":
		return tools.ClaimWork(ctx, strOf(args["path"]), symbolArg(args), strOf(args["intent"])), nil
	case "release":
		return tools.Release(ctx, strOf(args["path"]), symbolArg(args)), nil
	case "respond":
		return tools.Respond(ctx, strOf(args["path"]), symbolArg(args), strOf(args["move"]), strOf(args["reason"])), nil
	}
	return nil, fmt.Errorf("unknown tool: %q", name)
}

// symbolArg reads the optional "symbol" argument, nil when absent or not a
// string — the same optionality claim_work/release/respond's schemas give
// it.
func symbolArg(args map[string]any) *string {
	v, ok := args["symbol"]
	if !ok || v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return &s
}

// ToolDescriptors is the four tools as plain data, matching
// mcp_server.py's tool_descriptors() — kept separate from the MCP SDK
// wiring in server.go so the schemas stay testable without a transport.
func ToolDescriptors() []ToolDescriptor {
	return []ToolDescriptor{
		{
			Name:        "who_else_is_here",
			Description: "List other agents currently active in this repo.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
		{
			Name:        "claim_work",
			Description: "Declare intent to modify a region before editing it.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":   map[string]any{"type": "string"},
					"symbol": map[string]any{"type": "string"},
					"intent": map[string]any{"type": "string"},
				},
				"required": []string{"path", "intent"},
			},
		},
		{
			Name:        "release",
			Description: "Release a previously claimed region.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":   map[string]any{"type": "string"},
					"symbol": map[string]any{"type": "string"},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "respond",
			Description: "Reply to a contested claim with DEFER, SPLIT, HANDOFF or PROCEED.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":   map[string]any{"type": "string"},
					"symbol": map[string]any{"type": "string"},
					"move":   map[string]any{"type": "string"},
					"reason": map[string]any{"type": "string"},
				},
				"required": []string{"path", "move"},
			},
		},
	}
}

// ToolDescriptor is a tool's name, description and JSON Schema, in the raw
// shape mcp.Tool.InputSchema accepts directly.
type ToolDescriptor struct {
	Name        string
	Description string
	InputSchema map[string]any
}
