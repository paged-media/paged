#!/usr/bin/env python3
"""Merge each crate's integration-test files into one test binary.

`tests/<name>.rs` moves to `tests/it/<name>.rs` and becomes `mod <name>;` in a
generated `tests/it/main.rs` (Cargo discovers `tests/*/main.rs` as one test
target named `it`). One binary per crate means one link, and on macOS one
first-run malware scan, instead of one per file. nextest still runs every test
in its own process. Test ids change from `<crate>::<name>  <test>` to
`<crate>::it  <name>::<test>`.

Files that stay separate binaries (each is reported with its reason):
  - explicit `[[test]]` targets (harness = false, required-features, …)
  - wasm-bindgen tests (they run under the wasm32 runner)
  - files with a `#[global_allocator]` (a binary has at most one)
  - timing/allocation budgets (`perf` or `budget` in the name): they assume
    no other tests share their process under `cargo test`
  - crates with fewer than two files left to merge

Shared helpers that test files pull in with `[#[path = "…"]] mod <x>;` are
declared once in main.rs; each file then refers to them with
`use crate::<x>;`. Relative `include_str!`/`include_bytes!`/`include!` paths
gain a `../`.

Re-runnable: a crate that already has tests/it/main.rs gets any new top-level
files merged and main.rs regenerated.

Usage: merge-test-binaries.py [--dry-run] [--report FILE] <dir>...
Every Cargo package below each <dir> is considered (target/, fuzz/ and
spikes/ are skipped).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

SKIP_DIRS = {"target", "node_modules", "fuzz", "spikes", ".git"}

# A module declaration with its leading attribute and doc-comment lines.
MOD_DECL = re.compile(
    r"(?m)^(?P<attrs>(?:[ \t]*(?:#\[[^\n]*\]|///[^\n]*)[ \t]*\n)*)"
    r"[ \t]*(?P<vis>pub(?:\([^)]*\))?\s+)?mod\s+(?P<name>\w+)\s*;[ \t]*\n?"
)
PATH_ATTR = re.compile(r'#\[path\s*=\s*"(?P<path>[^"]+)"\]')
OTHER_ATTR = re.compile(r"#\[(?!path\b)[^\n]*\]")
DOC_LINE = re.compile(r"(?m)^[ \t]*(///[^\n]*)$")
INCLUDE = re.compile(r'\b(?P<mac>include_str|include_bytes|include)!\(\s*"(?P<path>[^"]+)"')
TEST_ATTR = re.compile(r"#\[(?:[\w:]+::)?test\b|wasm_bindgen_test|proptest!|#\[rstest")

HEADER = """\
//! The integration tests of `{package}`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.
"""


def packages(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if "Cargo.toml" in filenames:
            manifest = tomllib.loads(Path(dirpath, "Cargo.toml").read_text())
            if "package" in manifest:
                yield Path(dirpath), manifest


def keep_reason(stem: str, text: str, explicit: dict | None) -> str | None:
    if explicit is not None:
        if explicit.get("harness") is False:
            return "explicit [[test]] with harness = false"
        if explicit.get("required-features"):
            return "explicit [[test]] with required-features"
        return "explicit [[test]] entry"
    if "wasm_bindgen_test" in text:
        return "wasm-bindgen test"
    if "global_allocator" in text:
        return "#[global_allocator]"
    if re.search(r"perf|budget", stem):
        return "timing/allocation budget"
    if re.search(r"(?m)^\s*fn\s+main\s*\(", text):
        return "has fn main"
    return None


def helper_decls(text: str, tests_dir: Path):
    """The `mod x;` declarations of a top-level test file, resolved to files."""
    out = []
    for m in MOD_DECL.finditer(text):
        attrs = m.group("attrs")
        path_attr = PATH_ATTR.search(attrs)
        name = m.group("name")
        if path_attr:
            target = (tests_dir / path_attr.group("path")).resolve()
        else:
            flat, nested = tests_dir / f"{name}.rs", tests_dir / name / "mod.rs"
            target = (flat if flat.exists() else nested).resolve()
        other = [a.strip() for a in OTHER_ATTR.findall(attrs)]
        docs = DOC_LINE.findall(attrs)
        out.append({"match": m, "name": name, "target": target, "attrs": other, "docs": docs,
                    "has_path": bool(path_attr)})
    return out


def rewrite_file(text: str, decls, canon_of) -> str:
    """Replace helper `mod` declarations with `use crate::…` and fix include paths."""
    # Work back to front so match offsets stay valid.
    for d in sorted(decls, key=lambda d: d["match"].start(), reverse=True):
        m, name = d["match"], d["name"]
        canon = canon_of[d["target"]]

        def absolute(part: str) -> str:
            return re.sub(
                rf"\b(?P<vis>pub(?:\([^)]*\))?\s+)?use\s+{name}::",
                lambda u: f"{u.group('vis') or ''}use crate::{canon}::",
                part,
            )

        before, after = absolute(text[: m.start()]), absolute(text[m.end():])
        alias = ""
        if re.search(rf"(?<![\w:]){name}::", before + after):
            alias = f"use crate::{canon};\n" if name == canon else f"use crate::{canon} as {name};\n"
        text = before + alias + after
    return INCLUDE.sub(
        lambda i: i.group(0)
        if i.group("path").startswith("/")
        else f'{i.group("mac")}!("../{i.group("path")}"',
        text,
    )


def main_rs(package: str, helpers: dict, modules: list[str]) -> str:
    lines = [HEADER.format(package=package), "\n"]
    for canon, h in sorted(helpers.items()):
        lines.extend(f"{doc}\n" for doc in h["docs"])
        lines.extend(f"{a}\n" for a in h["attrs"])
        lines.append(f'#[path = "{h["rel"]}"]\nmod {canon};\n')
    if helpers:
        lines.append("\n")
    lines.extend(f"mod {m};\n" for m in modules)
    return "".join(lines)


def git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


def process(pkg_dir: Path, manifest: dict, dry_run: bool):
    package = manifest["package"]["name"]
    tests_dir = pkg_dir / "tests"
    it_dir = tests_dir / "it"
    entry = {"package": package, "dir": str(pkg_dir), "merged": [], "kept": {}, "helpers": {}}
    if not tests_dir.is_dir():
        return None
    if manifest["package"].get("autotests") is False:
        entry["skipped"] = "autotests = false"
        return entry
    explicit = {
        (pkg_dir / t.get("path", f"tests/{t['name']}.rs")).resolve(): t
        for t in manifest.get("test", [])
    }
    top = sorted(tests_dir.glob("*.rs"))
    if not top:
        return None
    existing = (it_dir / "main.rs").exists()

    candidates = []
    for f in top:
        text = f.read_text()
        reason = keep_reason(f.stem, text, explicit.get(f.resolve()))
        if reason is None and not TEST_ATTR.search(text):
            reason = "no tests (helper?)"
        if reason:
            entry["kept"][f.stem] = reason
        else:
            candidates.append((f, text))
    already = sorted(p.stem for p in it_dir.glob("*.rs") if p.name != "main.rs") if existing else []
    if not existing and len(candidates) < 2:
        entry["skipped"] = "fewer than two test files to merge"
        return entry
    if not candidates and existing:
        entry["merged"] = already
        entry["unchanged"] = True
        return entry

    # Shared helpers, declared once in main.rs.
    helpers, canon_of, plans = {}, {}, []
    names = {f.stem for f, _ in candidates} | set(already)
    if existing:
        for d in helper_decls((it_dir / "main.rs").read_text(), it_dir):
            if not d["has_path"]:
                continue  # a test module, not a helper
            helpers[d["name"]] = {"target": d["target"], "attrs": d["attrs"], "docs": d["docs"]}
            canon_of[d["target"]] = d["name"]
    for f, text in candidates:
        decls = helper_decls(text, tests_dir)
        for d in decls:
            if any(d["target"] == c.resolve() for c, _ in candidates):
                raise SystemExit(f"{f}: `mod {d['name']};` points at another test file")
            if not d["target"].exists():
                raise SystemExit(f"{f}: `mod {d['name']};` resolves to missing {d['target']}")
            if any(a.startswith("#[cfg") for a in d["attrs"]):
                raise SystemExit(f"{f}: cfg on a helper module is not supported")
            if d["target"] not in canon_of:
                canon = d["target"].stem if d["target"].name != "mod.rs" else d["target"].parent.name
                while canon in names or canon in helpers:
                    canon += "_support"
                canon_of[d["target"]] = canon
                helpers[canon] = {"target": d["target"], "attrs": [], "docs": d["docs"]}
            h = helpers[canon_of[d["target"]]]
            h["docs"] = h["docs"] or d["docs"]
            h["attrs"] = sorted(set(h["attrs"]) | {a for a in d["attrs"] if not a.startswith("#[cfg")})
        plans.append((f, rewrite_file(text, decls, canon_of)))

    for h in helpers.values():
        h["rel"] = os.path.relpath(h["target"], it_dir.resolve())
    modules = sorted(names)
    entry["merged"] = modules
    entry["helpers"] = {c: h["rel"] for c, h in helpers.items()}
    if dry_run:
        return entry

    it_dir.mkdir(exist_ok=True)
    for f, new_text in plans:
        dest = it_dir / f.name
        git("mv", str(f), str(dest))
        dest.write_text(new_text)
    (it_dir / "main.rs").write_text(main_rs(package, helpers, modules))
    git("add", str(it_dir))
    return entry


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dirs", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    report = []
    for root in args.dirs:
        for pkg_dir, manifest in packages(root):
            entry = process(pkg_dir, manifest, args.dry_run)
            if entry:
                report.append(entry)
                status = entry.get("skipped") or (
                    f"{len(entry['merged'])} files -> 1 binary"
                    + (f", kept {len(entry['kept'])}" if entry["kept"] else "")
                )
                print(f"{entry['package']:28} {status}")
                for stem, reason in entry["kept"].items():
                    print(f"{'':30}kept {stem}: {reason}")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    merged = sum(len(e["merged"]) for e in report if not e.get("skipped"))
    crates = sum(1 for e in report if not e.get("skipped"))
    print(f"\n{merged} test files merged into {crates} binaries")


if __name__ == "__main__":
    sys.exit(main())
