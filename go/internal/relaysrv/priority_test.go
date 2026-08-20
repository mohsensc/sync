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

// The out-of-range message lives behind ParsePriorityInt now — an unquoted
// principals.toml integer like `attended = 7` is the only thing that still
// reaches it. Asserted byte-for-byte so this stays the same message the
// old Atoi fallback produced; only the entry point moved.
func TestParsePriorityIntOutOfRangeNamesTheValidTiers(t *testing.T) {
	_, err := ParsePriorityInt(7)
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

// #95: ParsePriority used to fall back to strconv.Atoi, so a quoted
// numeral in principals.toml (attended = "3") parsed as a tier here and
// as unknown in python's parse_priority — the same roster line meant
// "critical" to one relay and "default" to the other. Names are the
// documented interface (docs/policy-design.md §4 has no numeral example);
// a bare TOML integer is still a tier, but only through ParsePriorityInt,
// which parsePriorityAny now reaches directly instead of via
// fmt.Sprintf into this function.
//
// This case list is mirrored exactly in
// python/tests/test_priority.py::test_parse_priority_parity — same
// inputs, same order — so a change to one side that silently drifts from
// the other fails a diff, not just a test.
func TestParsePriorityParity(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    int
		wantErr string
	}{
		{"background", "background", PriorityBackground, ""},
		{"normal", "normal", PriorityNormal, ""},
		{"elevated", "elevated", PriorityElevated, ""},
		{"critical", "critical", PriorityCritical, ""},
		{"mixed case and whitespace", " Critical ", PriorityCritical, ""},
		{"uppercase", "NORMAL", PriorityNormal, ""},
		{"numeral in range is not a name", "1",
			0, `unknown priority tier '1'; expected one of background, normal, elevated, critical`},
		{"numeral out of range is still just an unknown name", "7",
			0, `unknown priority tier '7'; expected one of background, normal, elevated, critical`},
		{"junk", "elevatd",
			0, `unknown priority tier 'elevatd'; expected one of background, normal, elevated, critical`},
		{"empty", "",
			0, `unknown priority tier ''; expected one of background, normal, elevated, critical`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePriority(tc.input)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("got error %v, want (%d, <nil>)", err, tc.want)
				}
				if got != tc.want {
					t.Fatalf("got %d, want %d", got, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("got (%d, <nil>), want error %q", got, tc.wantErr)
			}
			if err.Error() != tc.wantErr {
				t.Fatalf("got error %q, want %q", err.Error(), tc.wantErr)
			}
		})
	}
}
