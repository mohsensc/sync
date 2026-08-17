#!/usr/bin/env python3
"""Checks that every metric name in the dashboard and alert rules actually
exists in go/internal/metrics/metrics.go.

A dashboard panel or alert querying a metric nobody emits is the normal way
these rot: the metrics package changes, nobody remembers the JSON file 400
lines away, and the panel just goes blank (or worse, the alert silently
never fires). This is the guard — it fails the build instead.

Stdlib only, on purpose: this runs as its own ci-local.sh job, independent
of the python venv or any Grafana/Prometheus install, neither of which
this repo can assume is present.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
METRICS_GO = REPO / "go" / "internal" / "metrics" / "metrics.go"
DASHBOARD = REPO / "ops" / "grafana" / "agent-presence.json"
ALERTS = REPO / "ops" / "prometheus" / "alerts.yml"
MONITORING_DOC = REPO / "docs" / "monitoring.md"

# Every metric this package emits is either declared as an "ap_..." string
# literal in metrics.go, or comes from the two stock library collectors
# wired up in New() (go_*, process_*), or is Prometheus's own synthetic
# per-scrape-target "up". Those three are the whole vocabulary a PromQL expr
# in this repo is allowed to reference.
OWN_METRIC_RE = re.compile(r'"(ap_[a-zA-Z0-9_]+)"')
CANDIDATE_RE = re.compile(r'\b(ap_[a-zA-Z0-9_]+|go_[a-zA-Z0-9_]+|process_[a-zA-Z0-9_]+|up)\b')

# A histogram's base name (the literal in metrics.go) never appears on the
# wire by itself — Prometheus expands it into _bucket/_sum/_count. Strip
# those before comparing against the declared set.
HISTOGRAM_SUFFIXES = ("_bucket", "_sum", "_count")


def declared_metric_names(text: str) -> set[str]:
    return set(OWN_METRIC_RE.findall(text))


def candidate_names(text: str) -> set[str]:
    return set(CANDIDATE_RE.findall(text))


def is_known(name: str, declared: set[str]) -> bool:
    if name == "up" or name.startswith("go_") or name.startswith("process_"):
        return True
    if name in declared:
        return True
    for suf in HISTOGRAM_SUFFIXES:
        if name.endswith(suf) and name[: -len(suf)] in declared:
            return True
    return False


def exprs_from_dashboard(path: Path) -> list[str]:
    doc = json.loads(path.read_text())
    exprs = []

    def walk(node):
        if isinstance(node, dict):
            if "expr" in node and isinstance(node["expr"], str):
                exprs.append(node["expr"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    return exprs


def exprs_from_alerts(path: Path) -> list[str]:
    # alerts.yml is plain enough (every expr on one line) that a real YAML
    # parser isn't worth a dependency this script otherwise doesn't need.
    exprs = []
    for line in path.read_text().splitlines():
        m = re.match(r"\s*expr:\s*(.+?)\s*$", line)
        if m:
            exprs.append(m.group(1).strip("'\""))
    return exprs


def main() -> int:
    declared = declared_metric_names(METRICS_GO.read_text())
    if not declared:
        print(f"error: found no ap_* metric names in {METRICS_GO}", file=sys.stderr)
        return 1

    problems = []
    sources = [
        ("dashboard", DASHBOARD, exprs_from_dashboard(DASHBOARD)),
        ("alerts", ALERTS, exprs_from_alerts(ALERTS)),
    ]
    checked = 0
    for label, path, exprs in sources:
        if not exprs:
            problems.append(f"{path}: found no PromQL exprs at all — check the extraction, not just the file")
            continue
        for expr in exprs:
            for name in candidate_names(expr):
                checked += 1
                if not is_known(name, declared):
                    problems.append(f"{label} {path.name}: {name!r} is not a metric metrics.go emits (expr: {expr!r})")

    # The inverse rot: a metric lands in metrics.go and nobody ever writes
    # down what a bad value looks like. docs/monitoring.md is either
    # explaining a metric on the dashboard or explaining why it isn't one
    # (see "In the catalogue, not on the dashboard") — either way its name
    # should appear in the doc somewhere, or it's just missing.
    doc_text = MONITORING_DOC.read_text()
    for name in sorted(declared):
        if name not in doc_text:
            problems.append(f"{MONITORING_DOC.name}: {name!r} is declared in metrics.go but never mentioned")

    if problems:
        print(f"{len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    print(f"ok: {checked} metric references across {len(sources)} files all trace back to "
          f"{len(declared)} declared metrics in {METRICS_GO.relative_to(REPO)}, "
          f"all {len(declared)} documented in {MONITORING_DOC.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
