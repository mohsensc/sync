package relaysrv

import "testing"

// Issue #4 of the system-seams audit: ParsePriority's error dropped the
// "expected one of background, normal, elevated, critical" hint python's
// parse_priority includes, so the same malformed principals.toml produced
// two different operator-facing messages depending on which relay read it.

func TestParsePriorityUnknownNameNamesTheValidTiers(t *testing.T) {
	_, err := ParsePriority("elevatd")
	if err == nil {
		t.Fatal("expected an error for an unknown tier name")
	}
	// Single-quoted, matching python's f"{value!r}" — python's repr(str)
	// quotes with ', not ". A test that only checked the wording, not the
	// quote character, would still pass with Go's %q (double quotes) and
	// miss the actual parity bug.
	want := `unknown priority tier 'elevatd'; expected one of background, normal, elevated, critical`
	if err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}

func TestParsePriorityOutOfRangeNamesTheValidTiers(t *testing.T) {
	_, err := ParsePriority("7")
	if err == nil {
		t.Fatal("expected an error for an out-of-range priority")
	}
	want := "priority 7 is out of range; expected 0..3 or one of background, normal, elevated, critical"
	if err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}

// pyRepr's whole job is matching CPython's unicode_repr for the handful of
// strings ParsePriority ever feeds it (a tier name typo, a short number).
// One case per branch: the plain no-quote case, each single-vs-double
// delimiter choice, both quote characters present at once, and a
// backslash. Anything pyRepr does that isn't proven by one of these is an
// untested branch by definition — see its doc comment on why that's a
// hard line, not an oversight.
func TestPyRepr(t *testing.T) {
	cases := []struct {
		name string
		s    string
		want string
	}{
		{"no quotes, single-quote wrapped", "elevatd", `'elevatd'`},
		{"contains a single quote, no double quote: switches to double", "it's", `"it's"`},
		{"contains a double quote, no single quote: stays single", `she said "hi"`, `'she said "hi"'`},
		{"contains both: stays single, escapes the internal single quote", `both ' and "`, `'both \' and "'`},
		{"backslash is escaped", `back\slash`, `'back\\slash'`},
		{"empty string", "", `''`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pyRepr(tc.s); got != tc.want {
				t.Fatalf("pyRepr(%q) = %s, want %s", tc.s, got, tc.want)
			}
		})
	}
}

// ParsePriority intentionally accepts a numeric string ("1", "7") as well
// as a tier name — its own doc comment says "a name or a number" — because
// principals.go's parsePriorityAny reuses it for TOML int values too, by
// formatting an int64/int back to a string before calling in (its `case
// int64`/`case int` branches). That reuse is where the second divergence
// review leftover #3 asked about actually lives: `priority = "1"`, a
// genuinely string-typed TOML value, decodes to a Go string identical to
// what `priority = 1` produces after formatting, so this function cannot
// tell a real TOML string from a reformatted TOML int and accepts both.
//
// python's parse_priority can tell them apart, because it dispatches on
// the python type *before* touching the value as text (priority.py's
// isinstance checks, in order: bool, int, str) — its str branch only ever
// checks PRIORITY_NAMES and never attempts int(value). So a quoted
// `priority = "1"` in principals.toml is accepted here as PriorityNormal
// and rejected by the python relay as `unknown priority tier '1'`; a
// quoted `priority = "7"` is rejected by both, but through different
// branches — Go's out-of-range numeric error, python's unknown-tier error
// — which was the review's original framing, but "Go accepts a roster
// python rejects" (the "1" case) is the sharper version of the same bug.
//
// This function is not where that gets fixed: the type information that
// would let a caller ask for "names only" is already gone by the time a
// string reaches here, and ParsePriority's numeric-string acceptance is
// exactly what its int64/int callers rely on. The fix belongs in
// principals.go's parsePriorityAny (not owned by this review pass): its
// `case string` would need to check priorityValues directly instead of
// delegating to ParsePriority, the same way its own `case bool` already
// bypasses it rather than routing through a shared string parser.
func TestParsePriorityAcceptsNumericStringsWhichIsWhereThePythonDivergenceLives(t *testing.T) {
	got, err := ParsePriority("1")
	if err != nil || got != PriorityNormal {
		t.Fatalf("got (%d, %v), want (%d, <nil>)", got, err, PriorityNormal)
	}
}
