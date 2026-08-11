package mcptools

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// BuildServer registers the four tools on a new MCP server bound to tools.
// Low-level Server.AddTool rather than the generic AddTool helper: the
// input schema here has to be exactly ToolDescriptors()' shape, and the
// argument parsing mirrors mcp_server.py's dispatch — total, so a bad
// argument becomes part of the tool's own reply (an unknown move, an
// empty path) rather than a protocol-level error.
func BuildServer(tools *Tools) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "agent-presence"}, nil)
	for _, d := range ToolDescriptors() {
		name := d.Name
		server.AddTool(&mcp.Tool{
			Name:        d.Name,
			Description: d.Description,
			InputSchema: d.InputSchema,
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var args map[string]any
			if len(req.Params.Arguments) > 0 {
				// A malformed arguments blob is an empty call, not a
				// crash: dispatch treats every field as optional-or-typed
				// already, so this just means every field reads as its
				// zero value.
				_ = json.Unmarshal(req.Params.Arguments, &args)
			}
			result, err := Dispatch(ctx, tools, name, args)
			if err != nil {
				return nil, err
			}
			text, err := json.Marshal(result)
			if err != nil {
				return nil, err
			}
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: string(text)}},
			}, nil
		})
	}
	return server
}

// RunStdio serves MCP over stdin/stdout until the client closes the
// stream — the shape Claude Code launches: one process per session, the
// protocol on stdout, nothing else allowed there. Mirrors mcp_server.py's
// run_stdio.
func RunStdio(ctx context.Context, tools *Tools) error {
	server := BuildServer(tools)
	return server.Run(ctx, &mcp.StdioTransport{})
}
