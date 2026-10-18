#!/usr/bin/env python3
"""What a Rust test lane actually ran.

    python3 tooling/rust/skip-report.py --lane NAME [--log SKIPS] [--junit JUNIT]
        [--cargo-log LOG] [--min-executed N]

Rust's test harness has no runtime skip: a test whose resource is missing
returns early and reports "passed". Tests that use paged-test-resources
(platform/shared/test-resources) print `unavailable: <resource>: <reason>` and
append one line to $PAGED_SKIP_LOG (binary id, test name, resource, message).
This script turns that log into what the lane reports:

- `--junit`: every logged test in nextest's JUnit gets a <skipped> element
  with the message, so evidence read from the JUnit counts it as skipped,
  not passed. The file is rewritten in place.
- `--cargo-log`: the output of `cargo test`, for lanes without nextest; the
  executed count is the sum of its "N passed; M failed" lines.
- The executed count (run, minus reported unavailable) must reach
  `--min-executed` (default 1): a lane that ran nothing fails.
- A summary goes to stdout and, under GitHub Actions, the job summary.

Standard library only. Exit 1 when the lane executed too few tests, 2 on bad
input.
"""

from __future__ import annotations

import argparse
import collections
import os
import re
import sys
import xml.etree.ElementTree as ET

CARGO_RESULT = re.compile(r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored")


def read_log(path):
    entries = []
    if not path or not os.path.exists(path):
        return entries
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t", 3)
            if len(parts) == 4:
                entries.append(dict(binary=parts[0], test=parts[1], resource=parts[2], message=parts[3]))
    return entries


def mark_junit(path, entries):
    """Adds <skipped> to every logged testcase that did not fail. Returns
    (testcases, executed, marked)."""
    tree = ET.parse(path)
    root = tree.getroot()
    by_case = {}
    for e in entries:
        by_case.setdefault((e["binary"], e["test"]), e["message"])
    total = executed = marked = 0
    for suite in root.iter("testsuite"):
        suite_skipped = 0
        for case in suite.findall("testcase"):
            total += 1
            failed = case.find("failure") is not None or case.find("error") is not None
            already = case.find("skipped") is not None
            message = by_case.get((case.get("classname", ""), case.get("name", "")))
            if message and not failed and not already:
                skipped = ET.SubElement(case, "skipped")
                skipped.set("message", message)
                marked += 1
                already = True
            if already:
                suite_skipped += 1
            else:
                executed += 1
        if suite_skipped:
            suite.set("skipped", str(suite_skipped))
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    return total, executed, marked


def cargo_counts(path):
    run = ignored = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for m in CARGO_RESULT.finditer(f.read()):
            run += int(m.group(1)) + int(m.group(2))
            ignored += int(m.group(3))
    return run, ignored


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--lane", required=True, help="the lane's name, for the summary")
    ap.add_argument("--log", default=os.environ.get("PAGED_SKIP_LOG"), help="the skip log (default $PAGED_SKIP_LOG)")
    ap.add_argument("--junit", help="nextest JUnit to mark (rewritten in place)")
    ap.add_argument("--cargo-log", help="`cargo test` output, when the lane has no JUnit")
    ap.add_argument("--min-executed", type=int, default=1)
    args = ap.parse_args()

    entries = read_log(args.log)
    unavailable = len({(e["binary"], e["test"]) for e in entries})
    if args.junit:
        if not os.path.exists(args.junit):
            print(f"skip-report: {args.junit} does not exist", file=sys.stderr)
            return 2
        total, executed, marked = mark_junit(args.junit, entries)
        counts = f"{total} in the JUnit, {executed} executed, {marked} marked skipped (unavailable)"
    elif args.cargo_log:
        run, ignored = cargo_counts(args.cargo_log)
        executed = run - unavailable
        counts = f"{run} run, {ignored} ignored, {unavailable} reported unavailable, {executed} executed"
    else:
        print("skip-report: give --junit or --cargo-log", file=sys.stderr)
        return 2

    by_resource = collections.Counter(e["resource"] for e in entries)
    lines = [f"### {args.lane}: {executed} tests executed", "", counts, ""]
    if entries:
        lines += ["| Resource | Tests reported unavailable |", "|---|---|"]
        lines += [f"| {r} | {n} |" for r, n in by_resource.most_common()]
        lines += ["", "<details><summary>Unavailable tests</summary>", "", "```"]
        lines += [f"{e['binary']} {e['test']}: {e['message']}" for e in entries[:200]]
        if len(entries) > 200:
            lines.append(f"... and {len(entries) - 200} more")
        lines += ["```", "</details>", ""]
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    if os.environ.get("GITHUB_ACTIONS") == "true" and entries:
        detail = ", ".join(f"{r} {n}" for r, n in by_resource.most_common())
        print(f"::notice title={args.lane}: {unavailable} tests unavailable::{detail} (skipped, not passed)")
    if executed < args.min_executed:
        print(f"::error title={args.lane} ran nothing::{executed} tests executed, fewer than {args.min_executed}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
