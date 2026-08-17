package envflag

import "testing"

func TestTruthy(t *testing.T) {
	yes := []string{"1", "true", "TRUE", "True", "yes", "YES", "Yes", "on", "ON", "On",
		" true", "true ", "  yes  ", "\ttrue\n"}
	no := []string{"", " ", "0", "false", "FALSE", "no", "off", "2", "y", "t", "enabled",
		"true false", "1 1"}
	for _, v := range yes {
		if !Truthy(v) {
			t.Errorf("Truthy(%q) = false, want true", v)
		}
	}
	for _, v := range no {
		if Truthy(v) {
			t.Errorf("Truthy(%q) = true, want false", v)
		}
	}
}
