#!/usr/bin/env python3
"""Prove that merging test binaries kept every test (and every Cockpit mapping).

  test-ids.py dump <workspace dir> <out.json>
      `cargo nextest list` of the workspace (ignored tests included) as a
      sorted list of {binary_id, name, ignored}. Builds the test binaries.

  test-ids.py compare <before.json> <after.json> <report.json>
      Maps every `before` id through the merge report
      (`<pkg>::<file>` + `<test>` -> `<pkg>::it` + `<file>::<test>`) and
      requires the result to equal `after` exactly, ignored flags included.

  test-ids.py cockpit <test-map.yaml> <out.yaml> <report.json> <before.json>... -- <after.json>...
      Rewrites the test-map keys that name merged binaries and checks, entry
      by entry, that each matches exactly the tests it matched before (under
      the id mapping), using Cockpit's matching rules: `file` is a substring
      of the source path, classname or `classname::name` key; `title` of the
      name or key; `classname` of the classname. Writes the rewritten map and
      exits 1 if any entry can't be kept equal.
"""

import json
import re
import subprocess
import sys
from pathlib import Path


def dump(ws: str, out: str) -> None:
    res = subprocess.run(
        ["cargo", "nextest", "list", "--workspace", "--locked", "--run-ignored", "all",
         "--message-format", "json"],
        cwd=ws, capture_output=True, text=True,
    )
    if res.returncode != 0:
        sys.stderr.write(res.stderr[-4000:])
        sys.exit(res.returncode)
    data = json.loads(res.stdout)
    tests = []
    for suite in data["rust-suites"].values():
        for name, case in suite["testcases"].items():
            tests.append({"binary_id": suite["binary-id"], "name": name, "ignored": case["ignored"]})
    tests.sort(key=lambda t: (t["binary_id"], t["name"]))
    Path(out).write_text(json.dumps(tests, indent=1) + "\n")
    print(f"{ws}: {len(tests)} tests in {len({t['binary_id'] for t in tests})} binaries")


def load_report(path: str):
    merged = {}
    pkg_dirs = {}
    for e in json.loads(Path(path).read_text()):
        pkg_dirs[e["package"]] = e["dir"]
        if not e.get("skipped"):
            merged[e["package"]] = set(e["merged"])
    return merged, pkg_dirs


def translate(t, merged):
    pkg, _, binary = t["binary_id"].partition("::")
    if binary and binary in merged.get(pkg, ()):
        return {**t, "binary_id": f"{pkg}::it", "name": f"{binary}::{t['name']}"}
    return t


def as_key(t):
    return (t["binary_id"], t["name"], t["ignored"])


def compare(before: str, after: str, report: str) -> None:
    merged, _ = load_report(report)
    b = {as_key(translate(t, merged)) for t in json.loads(Path(before).read_text())}
    a = {as_key(t) for t in json.loads(Path(after).read_text())}
    lost, gained = sorted(b - a), sorted(a - b)
    print(f"before {len(b)} tests, after {len(a)}: lost {len(lost)}, gained {len(gained)}")
    for k in lost[:20]:
        print("  lost  ", *k)
    for k in gained[:20]:
        print("  gained", *k)
    sys.exit(1 if lost or gained else 0)


# ── Cockpit ──────────────────────────────────────────────────────────────

AC_RE = re.compile(r"\bAC-[A-Z0-9][A-Z0-9-]*")
MATCH_LINE = re.compile(r"^(?P<pre>\s*-\s*match:\s*\{)(?P<body>[^}]*)(?P<post>\}.*)$")
FIELD = re.compile(r'(?P<key>\w+)\s*:\s*"(?P<val>[^"]*)"')


def source_path(t, merged, pkg_dirs, after: bool):
    pkg, _, binary = t["binary_id"].partition("::")
    d = pkg_dirs.get(pkg, pkg)
    if not binary:
        return f"{d}/src"
    if after and binary == "it":
        return f"{d}/tests/it/main.rs"
    return f"{d}/tests/{binary}.rs"


def matches(fields, t, spath):
    cls = t["binary_id"]
    key = f"{cls}::{t['name']}"
    if "file" in fields and not (fields["file"] in spath or fields["file"] in cls or fields["file"] in key):
        return False
    if "title" in fields and not (fields["title"] in t["name"] or fields["title"] in key):
        return False
    if "classname" in fields and fields["classname"] not in cls:
        return False
    if "ac_prefix" in fields and not any(
        c.startswith(fields["ac_prefix"]) for c in AC_RE.findall(t["name"])
    ):
        return False
    return any(k in fields for k in ("file", "title", "classname", "ac_prefix"))


def variants(fields, merged, pkg_dirs):
    """Candidate rewrites of one entry, the unchanged one first."""
    yield fields
    for k in ("file", "classname"):
        v = fields.get(k)
        if not v:
            continue
        m = re.match(r"^([\w-]+)::(.*)$", v)
        if m and m.group(1) in merged:
            new = {**fields}
            new.pop(k)
            new["file"] = f"{m.group(1)}::it::{m.group(2)}"
            yield new
        m = re.match(r"^(?:.*/)?([\w-]+)/tests/(\w+)\.rs$", v)
        if m:
            for pkg, d in pkg_dirs.items():
                if d.rstrip("/").endswith(m.group(1)) and m.group(2) in merged.get(pkg, ()):
                    new = {**fields}
                    new.pop(k)
                    new["file"] = f"{pkg}::it::{m.group(2)}::"
                    yield new


def render(fields, original_body):
    order = [m.group("key") for m in FIELD.finditer(original_body)]
    keys = [k for k in order if k in fields] + [k for k in fields if k not in order]
    return " " + ", ".join(f'{k}: "{fields[k]}"' for k in keys) + " "


def cockpit(test_map: str, out: str, report: str, before: list[str], after: list[str]) -> None:
    merged, pkg_dirs = load_report(report)
    b_tests = [t for f in before for t in json.loads(Path(f).read_text())]
    a_tests = [t for f in after for t in json.loads(Path(f).read_text())]
    b_index = [(as_key(translate(t, merged)), t, source_path(t, merged, pkg_dirs, False)) for t in b_tests]
    a_index = [(as_key(t), t, source_path(t, merged, pkg_dirs, True)) for t in a_tests]

    lines = Path(test_map).read_text().splitlines(keepends=True)
    changed = failed = 0
    for i, line in enumerate(lines):
        m = MATCH_LINE.match(line.rstrip("\n"))
        if not m:
            continue
        fields = {f.group("key"): f.group("val") for f in FIELD.finditer(m.group("body"))}
        want = {k for k, t, p in b_index if matches(fields, t, p)}
        if not want:
            continue  # matches nothing in these workspaces: not ours to judge
        for cand in variants(fields, merged, pkg_dirs):
            got = {k for k, t, p in a_index if matches(cand, t, p)}
            if got == want:
                if cand is not fields:
                    lines[i] = m.group("pre") + render(cand, m.group("body")) + m.group("post") + "\n"
                    changed += 1
                break
        else:
            failed += 1
            print(f"line {i + 1}: no rewrite keeps {len(want)} matches: {line.strip()}")
    Path(out).write_text("".join(lines))
    print(f"cockpit: {changed} entries rewritten, {failed} could not be kept equal")
    sys.exit(1 if failed else 0)


def main():
    cmd, *rest = sys.argv[1:] or ["help"]
    if cmd == "dump" and len(rest) == 2:
        dump(*rest)
    elif cmd == "compare" and len(rest) == 3:
        compare(*rest)
    elif cmd == "cockpit" and "--" in rest:
        sep = rest.index("--")
        test_map, out, report, *before = rest[:sep]
        cockpit(test_map, out, report, before, rest[sep + 1:])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
