#!/usr/bin/env python3
"""Assemble the paged monorepo from the per-component repositories.

Reads manifest.yaml, and for every listed repository:
  1. updates a bare mirror of it under WORK/mirrors (network only here),
  2. clones the requested ref from that mirror,
  3. rewrites the clone with git-filter-repo: path rules from the manifest,
     history-only blob strips, the mailmap, `#N` -> `paged-media/<repo>#N` in
     commit messages, and finally the directory prefix,
then builds a new repository: one root commit (root/ files plus this tooling,
the lock file and the commit maps), followed by one merge per component in
manifest order. Root and merge commits use the manifest's fixed date, so an
assembly from the same source SHAs gives the same result.

Usage: assemble.py WORK_DIR [--offline]

WORK_DIR/out/paged is the assembled repository. Nothing is pushed anywhere.
Run verify.py on it afterwards.
"""
from __future__ import annotations

import fnmatch
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
IDENT = ("Dietmar Rietsch", "dietmar.rietsch@andthenext.at")


def run(*args: str, cwd: Path | None = None, env: dict | None = None, capture: bool = False) -> str:
    full_env = None
    if env:
        full_env = os.environ.copy()
        full_env.update(env)
    res = subprocess.run(
        args, cwd=cwd, env=full_env, check=True,
        stdout=subprocess.PIPE if capture else None, text=True,
    )
    return res.stdout if capture else ""


def git(repo: Path, *args: str, env: dict | None = None, capture: bool = True) -> str:
    return run("git", "-C", str(repo), *args, env=env, capture=capture)


def mirror(work: Path, org: str, name: str, offline: bool) -> Path:
    m = work / "mirrors" / f"{name}.git"
    if not m.exists():
        if offline:
            sys.exit(f"--offline but no mirror for {name}")
        m.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--quiet", "--mirror", f"https://github.com/{org}/{name}.git", str(m))
    elif not offline:
        git(m, "remote", "update", "--prune", capture=False)
    return m


def blobs_to_strip(clone: Path, ref: str, rule: dict) -> list[str]:
    """Blob IDs that match the rule and are absent from the tip tree."""
    paths = rule.get("paths", [])
    over = rule.get("over_bytes")
    tip = set(git(clone, "ls-tree", "-r", "--format=%(objectname)", ref).split())
    objs = git(clone, "rev-list", "--objects", ref).splitlines()
    path_of: dict[str, set[str]] = {}
    for line in objs:
        sha, _, path = line.partition(" ")
        if path:
            path_of.setdefault(sha, set()).add(path)
    if not path_of:
        return []
    batch = "\n".join(path_of) + "\n"
    sizes = subprocess.run(
        ["git", "-C", str(clone), "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        input=batch, text=True, capture_output=True, check=True,
    ).stdout.splitlines()
    strip = []
    for row in sizes:
        sha, typ, size = row.split()
        if typ != "blob" or sha in tip:
            continue
        by_path = any(fnmatch.fnmatch(p, g) for p in path_of[sha] for g in paths)
        by_size = over is not None and int(size) >= over
        if by_path or by_size:
            strip.append(sha)
    return sorted(strip)


def filter_clone(work: Path, org: str, spec: dict, src: Path, sha: str) -> dict:
    name, prefix = spec["name"], spec["prefix"].rstrip("/")
    clone = work / "clones" / name
    if clone.exists():
        shutil.rmtree(clone)
    clone_args = ["git", "clone", "--quiet", "--no-local", "--single-branch", "--no-checkout"]
    if not spec.get("tags"):
        clone_args.append("--no-tags")
    run(*clone_args, str(src), str(clone))
    # Point a local branch at exactly the resolved SHA; drop everything else.
    git(clone, "update-ref", "refs/heads/import", sha)
    git(clone, "symbolic-ref", "HEAD", "refs/heads/import")
    for ref in git(clone, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes").split():
        if ref != "refs/heads/import":
            git(clone, "update-ref", "-d", ref)
    git(clone, "remote", "remove", "origin")

    args = ["git", "filter-repo", "--force", "--quiet"]
    if spec.get("include"):
        for p in spec["include"]:
            args += ["--path", p]
    for g in spec.get("exclude_globs", []):
        args += ["--path-glob", g]
    if spec.get("exclude_globs"):
        args.append("--invert-paths")

    meta = work / "meta" / name
    meta.mkdir(parents=True, exist_ok=True)
    stripped: list[str] = []
    if spec.get("strip_history_only"):
        stripped = blobs_to_strip(clone, "import", spec["strip_history_only"])
        (meta / "strip-blob-ids.txt").write_text("".join(f"{s}\n" for s in stripped))
        if stripped:
            args += ["--strip-blobs-with-ids", str(meta / "strip-blob-ids.txt")]

    (meta / "replace-message.txt").write_text(
        f"regex:(^|[\\s(\\[]){'#'}(\\d+)\\b==>\\1{org}/{name}#\\2\n"
    )
    args += ["--mailmap", str(HERE / "mailmap"),
             "--replace-message", str(meta / "replace-message.txt"),
             "--path-rename", f":{prefix}/"]
    run(*args, cwd=clone)
    shutil.copy(clone / ".git" / "filter-repo" / "commit-map", meta / "commit-map")
    new_sha = git(clone, "rev-parse", "import").strip()
    tags = git(clone, "tag", "--list").split() if spec.get("tags") else []
    return {"name": name, "prefix": prefix, "source_sha": sha, "imported_sha": new_sha,
            "stripped_blobs": len(stripped), "tags": len(tags), "clone": clone}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    offline = "--offline" in sys.argv
    manifest = yaml.safe_load((HERE / "manifest.yaml").read_text())
    org, date = manifest["org"], manifest["date"]
    when = {"GIT_AUTHOR_NAME": IDENT[0], "GIT_AUTHOR_EMAIL": IDENT[1],
            "GIT_COMMITTER_NAME": IDENT[0], "GIT_COMMITTER_EMAIL": IDENT[1],
            "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}

    results = []
    for spec in manifest["repos"]:
        src = mirror(work, org, spec["name"], offline)
        sha = git(src, "rev-parse", "--verify", f"{spec['ref']}^{{commit}}").strip()
        print(f"[{spec['name']}] {spec['ref']} = {sha[:12]} -> {spec['prefix']}/", flush=True)
        results.append(filter_clone(work, org, spec, src, sha))

    out = work / "out" / "paged"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    run("git", "init", "--quiet", "--initial-branch=main", str(out))

    # Root commit: root/ files, this tooling, the lock and the commit maps.
    shutil.copytree(HERE / "root", out, dirs_exist_ok=True)
    tooling = out / "tooling" / "import"
    tooling.mkdir(parents=True)
    for f in ("assemble.py", "verify.py", "manifest.yaml", "mailmap", "gitleaks.toml", "README.md"):
        shutil.copy(HERE / f, tooling / f)
    shutil.copytree(HERE / "root", tooling / "root")
    maps = tooling / "commit-maps"
    maps.mkdir()
    for r in results:
        shutil.copy(work / "meta" / r["name"] / "commit-map", maps / f"{r['name']}.tsv")
    lock = [{k: v for k, v in r.items() if k != "clone"} for r in results]
    (tooling / "import-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    git(out, "add", "-A")
    git(out, "commit", "--quiet", "-m",
        "Start the paged monorepo\n\nRoot files and the import tooling that assembles the "
        "component repositories below.", env=when)

    for r in results:
        clone = r["clone"]
        git(out, "fetch", "--quiet", "--no-tags", str(clone), f"import:refs/import/{r['name']}")
        if r["tags"]:
            git(out, "fetch", "--quiet", str(clone), "refs/tags/*:refs/tags/*")
        msg = (f"Import {org}/{r['name']} into {r['prefix']}/\n\n"
               f"Source: {org}/{r['name']}@{r['source_sha']}\n"
               f"Rewritten tip: {r['imported_sha']}\n"
               f"See tooling/import/import-lock.json and commit-maps/{r['name']}.tsv.")
        git(out, "merge", "--quiet", "--allow-unrelated-histories", "--no-ff", "-m", msg,
            f"refs/import/{r['name']}", env=when)
        git(out, "update-ref", "-d", f"refs/import/{r['name']}")
        print(f"[{r['name']}] merged ({r['stripped_blobs']} history-only blobs stripped, {r['tags']} tags)",
              flush=True)

    git(out, "gc", "--quiet", "--prune=now", capture=False)
    print(f"assembled: {out}  HEAD {git(out, 'rev-parse', 'HEAD').strip()}")


if __name__ == "__main__":
    main()
