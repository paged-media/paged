#!/usr/bin/env python3
"""Prove that B7 (vitest -> bun test) kept every test and every Cockpit mapping.

    bun-test-ids.py cockpit <test-map.yaml> <out.yaml> <suites.json>

suites.json lists the TypeScript suites the feature registry reads:

    [{"source": "<evidence source id>", "dir": "<package dir>",
      "before": ["<vitest JUnit>"...], "after": ["<bun JUnit, rewritten by bun-junit.mjs>"...],
      "renames": {"<old spec path>": "<new spec path>"}}]

A test's id is `classname > name` (the vitest shape: classname = the spec path relative
to the package). Per suite the script requires the `after` ids to equal the `before` ids
once `renames` is applied to the classnames (a renamed spec file), and it reports any
other difference.

Then it checks every test-map entry the way Cockpit matches one (test-ids.py's rules:
`file` a substring of the source path, classname or `classname::name`; `title` of the
name or key; `classname` of the classname; `source` the evidence source or its prefix)
and requires each to match exactly the same tests before and after, by id under the
renames. An entry whose `file`/`classname` names a renamed spec is rewritten to the new
path when that makes it equal, or (when it also matched an unchanged spec) kept with a
rewritten copy beside it. Writes the (possibly) rewritten map to <out.yaml>, prints
counts only, and exits 1 if any suite or entry can't be kept equal. Entries that match no
TypeScript test are not this script's to judge (the Rust ids did not change in B7).
"""

import importlib.util
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("test_ids", HERE / "test-ids.py")
tid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tid)


def cases(path: str):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    for doc in (d for d in re.split(r"(?=<\?xml)", text) if d.strip()):
        root = ET.fromstring(doc.encode())
        for suite in root.iter("testsuite"):
            for tc in suite.findall("testcase"):
                yield tc.get("classname") or suite.get("name", ""), tc.get("name", "")


def load(suites):
    before, after, problems = [], [], 0
    for s in suites:
        ren = s.get("renames", {})
        b = {(c, n) for f in s["before"] for c, n in cases(f)}
        a = {(c, n) for f in s["after"] for c, n in cases(f)}
        b_mapped = {(ren.get(c, c), n) for c, n in b}
        lost, gained = b_mapped - a, a - b_mapped
        print(f"{s['dir']}: before {len(b)}, after {len(a)}, renamed {sum(1 for c, _ in b if c in ren)}"
              f"; lost {len(lost)}, gained {len(gained)}")
        if lost:
            problems += 1
        for c, n in b:
            before.append(dict(source=s["source"], cls=c, name=n, dir=s["dir"], id=(ren.get(c, c), n)))
        for c, n in a:
            after.append(dict(source=s["source"], cls=c, name=n, dir=s["dir"], id=(c, n)))
        s["_gained"] = len(gained)
    return before, after, problems


def entry_matches(fields, t):
    src = fields.get("source")
    if src and src != t["source"] and not t["source"].startswith(src + "/"):
        return False
    rest = {k: v for k, v in fields.items() if k != "source"}
    if not rest:
        return bool(fields)
    return tid.matches(rest, {"binary_id": t["cls"], "name": t["name"]}, f"{t['dir']}/{t['cls']}")


def rewrites(fields, renames):
    yield fields
    for k in ("file", "classname"):
        v = fields.get(k)
        if not v:
            continue
        for old, new in renames.items():
            # B7's only rename: test/panels/<x>.spec.tsx -> test/panels/<x>.dom.test.tsx
            if old in v:
                cand = v.replace(old, new)
            elif v in old:
                cand = v.replace(".spec", ".dom.test")
            else:
                continue
            if cand != v:
                yield {**fields, k: cand}


def cockpit(test_map, out, suites_path):
    suites = json.loads(Path(suites_path).read_text())
    before, after, problems = load(suites)
    renames = {o: n for s in suites for o, n in s.get("renames", {}).items()}
    lines = Path(test_map).read_text().splitlines(keepends=True)
    checked = changed = failed = 0
    union_before, union_after = set(), set()
    for i, line in enumerate(lines):
        m = tid.MATCH_LINE.match(line.rstrip("\n"))
        if not m:
            continue
        fields = {f.group("key"): f.group("val") for f in tid.FIELD.finditer(m.group("body"))}
        want = {t["id"] + (t["source"],) for t in before if entry_matches(fields, t)}
        if not want:
            continue
        checked += 1
        union_before |= want
        for cand in rewrites(fields, renames):
            got = {t["id"] + (t["source"],) for t in after if entry_matches(cand, t)}
            if got == want:
                if cand is not fields:
                    lines[i] = m.group("pre") + tid.render(cand, m.group("body")) + m.group("post") + "\n"
                    changed += 1
                union_after |= got
                break
        else:
            # A key that matched an unchanged spec and a renamed one needs both:
            # keep the entry and add the rewritten one beside it (test-map matching
            # is a union across entries), with its features/stage lines.
            for cand in list(rewrites(fields, renames))[1:]:
                got = {t["id"] + (t["source"],) for t in after if entry_matches(fields, t) or entry_matches(cand, t)}
                if got == want:
                    j = i + 1
                    while j < len(lines) and lines[j].startswith((" ", "\t")) and not tid.MATCH_LINE.match(lines[j].rstrip("\n")):
                        j += 1
                    dup = m.group("pre") + tid.render(cand, m.group("body")) + m.group("post") + "\n" + "".join(lines[i + 1:j])
                    lines[j - 1] = lines[j - 1] + dup
                    union_after |= got
                    changed += 1
                    break
            else:
                failed += 1
                print(f"line {i + 1}: no rewrite keeps its {len(want)} TypeScript matches")
    Path(out).write_text("".join(lines))
    print(f"tests: before {len(before)}, after {len(after)}")
    print(f"test-map: {checked} entries match TypeScript tests; {changed} rewritten for renamed specs; {failed} could not be kept equal")
    print(f"Cockpit-mapped TypeScript tests: before {len(union_before)}, after {len(union_after)}")
    sys.exit(1 if failed or problems else 0)


def main():
    cmd, *rest = sys.argv[1:] or ["help"]
    if cmd == "cockpit" and len(rest) == 3:
        cockpit(*rest)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
