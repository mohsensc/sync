package relaysrv

// regionPayload is a region on its way out, in the shape
// cpp/daemon/relay_client.cpp and go/internal/relay/client.go read: path
// and symbol always spelled out, a nil symbol as explicit null (which is
// how the daemon spells "the whole file"). Mirrors relay.py's
// _region_payload, including the opaque mark so a region that arrived
// already hashed doesn't get hashed a second time by the outbound pass.
func regionPayload(r Region) Frame {
	f := regionPayloadUnmarked(r)
	if OpaqueEnabled() {
		f[OpaqueMark] = true
	}
	return f
}

// regionPayloadUnmarked builds the path/symbol/lines body with no opaque
// mark, whatever the region's contents are. Every caller of regionPayload
// hands it an already-hashed Region when opaque mode is on (see
// CleanRegionDict, called at ingest) and wants the mark set so the
// outbound blanket pass in redact.go doesn't hash it a second time — that
// is what regionPayload above does. RedactEvent is the one exception: it
// defers all hashing to that same blanket pass (see its own comment) and
// builds this dict from an *unhashed* Region, so marking it here would be
// a real bug — the blanket pass would see the mark, skip it, and a
// cleartext path would reach the wire under opaque mode. Kept as a
// separate function rather than a bool parameter so that mistake can't
// be made by passing the wrong argument at a call site that forgot which
// case it's in.
func regionPayloadUnmarked(r Region) Frame {
	var symbol any
	if r.Symbol != nil {
		symbol = *r.Symbol
	}
	var lines any
	if len(r.Lines) > 0 {
		arr := make([]any, len(r.Lines))
		for i, v := range r.Lines {
			arr[i] = v
		}
		lines = arr
	}
	return Frame{"path": r.Path, "symbol": symbol, "lines": lines}
}

// leaseFrame is the body shared by "lease" (state=held), the elements of
// "leases", and "claim_result" — the daemon parses all three the same way.
// Mirrors relay.py's _lease_entry.
func leaseFrame(c *Claim, now float64) Frame {
	f := Frame{
		"agent":         c.Agent,
		"human":         c.Human,
		"intent":        c.Intent,
		"priority":      PriorityName(c.Priority),
		"region":        regionPayload(c.Scope),
		"expires_in_ms": msRemaining(c.ExpiresAt, now),
		"expires_at":    c.ExpiresAt,
	}
	winner := c.HandoverWinner()
	if c.HandoverAt != nil && winner != nil {
		f["handover_in_ms"] = msRemaining(*c.HandoverAt, now)
		f["handover_at"] = *c.HandoverAt
		f["handover_to"] = winner.Agent
		f["handover_to_human"] = winner.Human
		f["handover_to_priority"] = PriorityName(winner.Priority)
		f["waiting"] = len(c.Contenders)
	}
	return f
}

func msRemaining(deadline, now float64) int {
	ms := int((deadline - now) * 1000)
	if ms < 0 {
		return 0
	}
	return ms
}

// departureFrame is what a claim's departure produces, plain or upgraded
// to a handover if a reservation is waiting for it. Shared by lazy-expiry
// and explicit release so a lease that leaves the table by either door is
// described the same way. Mirrors relay.py's _departure_frame (PR #37).
func departureFrame(room, human, agent string, scope Region, now float64, state string, winner *Contender, reservation *Reservation) Frame {
	frame := Frame{
		"type": "lease", "state": state, "agent": agent,
		"region": regionPayload(scope),
	}
	if reservation != nil && reservation.FromAgent == agent {
		frame["state"] = "handover"
		frame["to"] = reservation.Agent
		frame["to_human"] = reservation.Human
		frame["to_priority"] = PriorityName(reservation.Priority)
		frame["reserved_for_ms"] = msRemaining(reservation.ExpiresAt, now)
		frame["from"] = agent
		frame["from_human"] = human
		if winner != nil {
			waited := now - winner.FirstAskedAt
			if waited < 0 {
				waited = 0
			}
			frame["waited_s"] = waited
		}
	}
	return frame
}
