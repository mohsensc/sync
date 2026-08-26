package mcptools

import (
	"context"
	"fmt"
	"time"
)

// Dispatch routes a tool call to the matching method. Returns an error on
// an unknown tool name — the one case a Claude Code client can name a tool
// this server never registered — mirroring mcp_server.py's dispatch, which
// raises KeyError for the same case. A required argument that's missing
// errors the same way: mcp.Server.AddTool leaves schema validation to the
// caller (go-sdk mcp/server.go's AddTool doc comment), so this is the only
// place a missing "path" or "intent" gets caught before it turns into a
// real claim on an empty-string region. Tool calls themselves never error
// once their required arguments are in hand: an invented negotiation move
// comes back as a refusal carrying the valid moves, not a Go error.
func Dispatch(ctx context.Context, tools *Tools, name string, args map[string]any) (any, error) {
	start := time.Now()
	switch name {
	case "who_else_is_here":
		return tools.WhoElseIsHere(ctx), nil
	case "claim_work":
		path, err := requirePath(args)
		if err != nil {
			// The call never reaches ClaimWork, so it never records
			// itself; this is the one place that gets to. The tool name
			// is one of the switch's own literals, not client input, so
			// it's safe as a label without going through mcpToolUnknown.
			tools.recordCall(mcpToolClaimWork, mcpOutcomeError, start)
			return nil, err
		}
		intent, err := requireStr(args, "intent")
		if err != nil {
			tools.recordCall(mcpToolClaimWork, mcpOutcomeError, start)
			return nil, err
		}
		return tools.ClaimWork(ctx, path, symbolArg(args), intent), nil
	case "release":
		path, err := requirePath(args)
		if err != nil {
			tools.recordCall(mcpToolRelease, mcpOutcomeError, start)
			return nil, err
		}
		return tools.Release(ctx, path, symbolArg(args)), nil
	case "respond":
		path, err := requirePath(args)
		if err != nil {
			tools.recordCall(mcpToolRespond, mcpOutcomeError, start)
			return nil, err
		}
		move, err := requireStr(args, "move")
		if err != nil {
			tools.recordCall(mcpToolRespond, mcpOutcomeError, start)
			return nil, err
		}
		return tools.Respond(ctx, path, symbolArg(args), move, strOf(args["reason"])), nil
	}
	// name came from the caller and was never one of ours — bucketed to
	// mcpToolUnknown rather than recorded as-is, or a client could mint an
	// unbounded number of ap_mcp_calls_total series just by asking for
	// tools that don't exist.
	tools.recordCall(mcpToolUnknown, mcpOutcomeError, start)
	return nil, fmt.Errorf("unknown tool: %q", name)
}

// requireStr reads a required string argument, erroring the way Python's
// arguments["path"] raised KeyError on a missing key — except a Go map
// index can't raise, so this is the explicit stand-in. A present-but-
// wrong-typed value errors too: a schema-violating call, same as a
// missing one, not a quiet fallback to "".
func requireStr(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok {
		return "", fmt.Errorf("missing required argument %q", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("argument %q must be a string, got %T", key, v)
	}
	return s, nil
}

// requirePath is requireStr for "path", with the empty string rejected too.
//
// "" passes a plain string check, and RegionKey returns "" for an empty
// path, so an empty path used to become a real lease keyed on the empty
// region — collidable with any other client that made the same mistake,
// and releasable by a third that never knew what it was freeing. None of
// those agents were talking about the same file. Dispatch's own doc
// comment claims this is where that gets caught; this is what makes the
// claim true.
//
// Scoped to "path" rather than every requireStr: "intent" is free text
// with no keying role, and an empty "move" is already caught by
// negotiation's normalize, so widening it would change their behaviour for
// no safety gained.
func requirePath(args map[string]any) (string, error) {
	s, err := requireStr(args, "path")
	if err != nil {
		return "", err
	}
	if s == "" {
		return "", fmt.Errorf("argument %q must not be empty", "path")
	}
	return s, nil
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
