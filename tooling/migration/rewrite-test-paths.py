#!/usr/bin/env python3
"""Point mentions of a merged integration-test file at its new home.

merge-test-binaries.py moves `<crate>/tests/<file>.rs` to
`<crate>/tests/it/<file>.rs`. Registries, docs and comments that name the old
path are rewritten here:

- `<crate>/tests/<file>.rs` anywhere in the repository, when no
  `<crate>/tests/<file>.rs` still exists under any workspace;
- a bare `tests/<file>.rs` inside the crate's own directory.

Golden files are left alone (tests compare their bytes), and so is
docs/migration (the record of the move). Fixtures are rewritten: the few that
name a test file record which test or probe generated them, and those
generators are rewritten too. Re-running it changes nothing.

    python3 tooling/migration/rewrite-test-paths.py [--dry-run]
"""

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

SKIP_PARTS = {"golden", "node_modules"}
SKIP_PREFIXES = ("docs/migration/",)
BINARY_SUFFIXES = (".wasm", ".png", ".jpg", ".idml", ".pdf", ".psd", ".xlsx", ".docx", ".lock")


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\n") if f]


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    files = tracked()
    present = set(files)
    # crate dir name -> {file stem} moved into tests/it/, and the crate dirs themselves
    moved: dict[str, set[str]] = defaultdict(set)
    crate_dirs: dict[str, set[str]] = defaultdict(set)  # crate dir path -> stems
    still_flat: set[tuple[str, str]] = set()
    for f in files:
        m = re.match(r"(?:(.*)/)?([^/]+)/tests/it/([^/]+)\.rs$", f)
        if m and m.group(3) != "main":
            moved[m.group(2)].add(m.group(3))
            crate_dirs[f.rsplit("/tests/it/", 1)[0]].add(m.group(3))
        m = re.match(r"(?:.*/)?([^/]+)/tests/([^/]+)\.rs$", f)
        if m:
            still_flat.add((m.group(1), m.group(2)))

    qualified = re.compile(r"(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)/tests/([A-Za-z0-9_]+)\.rs")
    bare = re.compile(r"(?<![A-Za-z0-9_./-])tests/([A-Za-z0-9_]+)\.rs")

    changed = 0
    for f in files:
        if f.startswith(SKIP_PREFIXES) or f.endswith(BINARY_SUFFIXES):
            continue
        if SKIP_PARTS.intersection(f.split("/")[:-1]):
            continue
        path = Path(f)
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue

        def qual(m: re.Match) -> str:
            krate, stem = m.group(1), m.group(2)
            if stem in moved.get(krate, ()) and (krate, stem) not in still_flat:
                return f"{krate}/tests/it/{stem}.rs"
            return m.group(0)

        new = qualified.sub(qual, text)
        owner = next((d for d in crate_dirs if f.startswith(d + "/")), None)
        if owner is not None:
            stems = crate_dirs[owner]
            krate = owner.rsplit("/", 1)[-1]

            def unqual(m: re.Match) -> str:
                stem = m.group(1)
                if stem in stems and (krate, stem) not in still_flat:
                    return f"tests/it/{stem}.rs"
                return m.group(0)

            new = bare.sub(unqual, new)
        if new != text:
            changed += 1
            print(f)
            if not dry_run:
                path.write_text(new, encoding="utf-8")
    print(f"{changed} file(s) {'would change' if dry_run else 'changed'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
