// Package envflag is the one place a boolean environment variable gets
// read.
//
// It exists because there were three of these. presenced matched a fixed
// list of literals ("1", "true", "TRUE", "True", "yes", "on"), the MCP
// server lowercased and trimmed first, and python's principals.py did the
// same as the MCP server — so `AGENT_PRESENCE_UNATTENDED=YES` promoted
// ask to deny in two of the three, and the one that disagreed was the
// daemon, the only one that actually gates a tool call. A trailing space
// from a .env file did the same thing.
//
// Truthy is the MCP server's and python's rule, because that is the
// forgiving one and nothing is made worse by accepting "Yes ".
package envflag

import "strings"

// Truthy reports whether an environment value means yes. Case and
// surrounding whitespace are ignored; anything not in the set — including
// the empty string — is no.
//
// Kept byte-identical to python/src/agent_presence/principals.py's
// unattended_flag. A divergence here means the CLI tells an operator one
// thing about their own policy and the daemon does another.
func Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
