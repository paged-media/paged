#!/usr/bin/env python3
"""Gates for an assembled monorepo. Exit status 1 if any gate fails.

Usage: verify.py WORK_DIR

Gates:
  tree      each component's subtree equals its source tree at the imported SHA,
            minus exactly the paths the manifest drops
  tags      every imported tag points at a commit whose subtree equals the
            original tag's tree
  identity  no pimcore.com address as author, committer or tagger
  forbidden no private or secret-looking files in the tip tree
  secrets   gitleaks over the full history finds nothing beyond the allowlist
  history   every component has more than its import merge in `git log`
It also prints a size report (pack size, largest blobs).
"""
from __future__ import annotations

import fnmatch
import json
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
FORBIDDEN = ["*.icc", "*.icm", "*/fonts/local/*", "*cloudflare-tokens*", "*.pem", "*.p12",
             "*.key", "*/.env", ".env", "*/.dev.vars", "*.sqlite", "*/paged.db"]


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout


def tree_listing(repo: Path, treeish: str) -> dict[str, tuple[str, str]]:
    out = {}
    for line in git(repo, "ls-tree", "-r", "-z", "--full-tree", treeish).split("\0"):
        if not line:
            continue
        meta, path = line.split("\t", 1)
        mode, typ, sha = meta.split()
        out[path] = (mode, sha)
    return out


def kept(path: str, spec: dict) -> bool:
    inc = spec.get("include")
    if inc and not any(path == p or (p.endswith("/") and path.startswith(p)) for p in inc):
        return False
    for g in spec.get("exclude_globs", []):
        # filter-repo --path-glob matches the path or any leading directory of it.
        parts = path.split("/")
        if any(fnmatch.fnmatch("/".join(parts[:i]), g) for i in range(1, len(parts) + 1)):
            return False
    return True


def main() -> int:
    work = Path(sys.argv[1]).resolve()
    out = work / "out" / "paged"
    manifest = yaml.safe_load((HERE / "manifest.yaml").read_text())
    lock = {r["name"]: r for r in json.loads((out / "tooling/import/import-lock.json").read_text())}
    failures: list[str] = []

    # tree
    for spec in manifest["repos"]:
        name, prefix = spec["name"], spec["prefix"].rstrip("/")
        mirror = work / "mirrors" / f"{name}.git"
        src = {p: v for p, v in tree_listing(mirror, lock[name]["source_sha"]).items() if kept(p, spec)}
        dst = tree_listing(out, f"HEAD:{prefix}")
        if src != dst:
            missing = sorted(set(src) - set(dst))[:5]
            extra = sorted(set(dst) - set(src))[:5]
            changed = sorted(p for p in set(src) & set(dst) if src[p] != dst[p])[:5]
            failures.append(f"tree {name}: missing={missing} extra={extra} changed={changed}")
        else:
            print(f"ok   tree      {name}: {len(dst)} files identical")

    # tags
    for spec in manifest["repos"]:
        if not spec.get("tags"):
            continue
        name, prefix = spec["name"], spec["prefix"].rstrip("/")
        mirror = work / "mirrors" / f"{name}.git"
        bad = []
        tags = git(mirror, "tag", "--merged", lock[name]["source_sha"]).split()
        for t in tags:
            orig = git(mirror, "rev-parse", f"{t}^{{tree}}").strip()
            try:
                new = git(out, "rev-parse", f"{t}^{{commit}}:{prefix}").strip()
            except subprocess.CalledProcessError:
                new = "<missing>"
            if orig != new:
                bad.append(t)
        if bad:
            failures.append(f"tags {name}: {bad[:5]} (of {len(tags)})")
        else:
            print(f"ok   tags      {name}: {len(tags)} tags, trees identical")
    extra_tags = set(git(out, "tag").split()) - {
        t for s in manifest["repos"] if s.get("tags")
        for t in git(work / "mirrors" / f"{s['name']}.git", "tag", "--merged", lock[s["name"]]["source_sha"]).split()}
    if extra_tags:
        failures.append(f"tags: unexpected {sorted(extra_tags)[:5]}")

    # identity
    ids = git(out, "log", "--all", "--format=%ae%n%ce")
    ids += git(out, "for-each-ref", "refs/tags", "--format=%(taggeremail)")
    n = sum(1 for line in ids.splitlines() if "pimcore" in line)
    if n:
        failures.append(f"identity: {n} pimcore addresses")
    else:
        print("ok   identity  no pimcore address in authors, committers or taggers")

    # forbidden
    tip = tree_listing(out, "HEAD")
    # Guard files that keep a private directory empty (.gitignore, .gitkeep, a README) are expected.
    guard = {".gitignore", ".gitkeep", "README.md"}
    hits = [p for p in tip if any(fnmatch.fnmatch(p, g) for g in FORBIDDEN)
            and p.rsplit("/", 1)[-1] not in guard]
    if hits:
        failures.append(f"forbidden: {hits[:10]}")
    else:
        print(f"ok   forbidden none of {len(FORBIDDEN)} patterns in {len(tip)} tip files")

    # secrets
    report = work / "gitleaks.json"
    cfg = HERE / "gitleaks.toml"
    cmd = ["gitleaks", "git", str(out), "--no-banner", "--redact", "--report-format", "json",
           "--report-path", str(report), "--exit-code", "0"]
    if cfg.exists():
        cmd += ["--config", str(cfg)]
    subprocess.run(cmd, check=True, capture_output=True)
    findings = json.loads(report.read_text() or "[]")
    if findings:
        rules = {}
        for f in findings:
            rules.setdefault(f["RuleID"], []).append(f"{f['File']}@{f['Commit'][:8]}")
        failures.append("secrets: " + "; ".join(f"{k} x{len(v)} e.g. {v[0]}" for k, v in rules.items()))
    else:
        print("ok   secrets   gitleaks: no findings")

    # history
    for spec in manifest["repos"]:
        prefix = spec["prefix"].rstrip("/")
        count = int(git(out, "rev-list", "--count", "HEAD", "--", prefix).strip())
        if count < 2:
            failures.append(f"history {spec['name']}: only {count} commits touch {prefix}")
    if not any(f.startswith("history") for f in failures):
        print("ok   history   every component carries its history")

    # size report
    print("\nsize:", " ".join(git(out, "count-objects", "-vH").split()))
    rows = git(out, "rev-list", "--objects", "--all")
    batch = subprocess.run(["git", "-C", str(out), "cat-file",
                            "--batch-check=%(objecttype) %(objectsize) %(rest)"],
                           input=rows, capture_output=True, text=True, check=True).stdout
    blobs = sorted((int(l.split(" ", 2)[1]), l.split(" ", 2)[2]) for l in batch.splitlines()
                   if l.startswith("blob ") and len(l.split(" ", 2)) == 3)
    for size, path in blobs[-10:][::-1]:
        print(f"  {size / 1e6:7.2f} MB  {path}")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("\nall gates passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
