package mcptools

// Small, loose coercions for reading a relay reply that arrived as
// map[string]any off encoding/json — the Go equivalent of Python's
// dict.get() reading whatever type happened to be there. A field of the
// wrong (or missing) shape reads as the zero value rather than panicking:
// relay.py is the authority on these shapes, this is just a client.

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

func numOf(v any) float64 {
	f, _ := v.(float64) // encoding/json decodes every JSON number as float64
	return f
}

func intOf(v any) int {
	return int(numOf(v))
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// decisionOr mirrors `reply.get("decision", "abort")`: only a missing key
// falls back, not a present-but-empty one — though relay.py always sends a
// real wait-die verdict here, never an empty string.
func decisionOr(v any) string {
	if v == nil {
		return "abort"
	}
	return strOf(v)
}
