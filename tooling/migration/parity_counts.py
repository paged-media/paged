#!/usr/bin/env python3
"""Test-count parity between the old per-component CI and the monorepo CI.

Reads GitHub Actions data with read-only `gh api` GETs, caches job logs and
test artifacts under --cache, and writes one JSON document with, per suite
(workflow / job / framework), the counts of the old run and of the new run.

    python3 tooling/migration/parity_counts.py --cache DIR --out FILE.json \
        [--markdown TABLES.md] [--refresh-new]

The run ids compared are in WORKFLOWS below. --markdown writes the suite,
job-time and slowest-suite tables used in docs/migration/parity.md.

A suite is one test framework inside one job. Counts come from the job log
(cargo test, cargo nextest, vitest, node:test, Playwright summaries and the
engine's own gates) and, where the workflow uploads one, from the JUnit
artifact, which also gives the test ids used to name added/removed tests.
Matrix legs are separate suites; Playwright shards are summed into one.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

NEW_REPO = "paged-media/paged"

# component, old repo, old workflow, old run, new workflow, new run (None:
# no run on the PR head; the reason is in new_note), artifact -> job map.
WORKFLOWS = [
    dict(component="core", old_repo="paged-media/core", old_file="ci.yml",
         old_run=39104676793, new_file="core-ci.yml", new_run=39114572956,
         ref_runs=[39105589722],
         artifacts={"nextest-junit": "nextest evidence",
                    "idml-viewer-vitest-junit": "idml-viewer vitest"}),
    dict(component="core", old_repo="paged-media/core", old_file="fidelity.yml",
         old_run=39105589731, new_file="core-fidelity.yml", new_run=39114573095,
         artifacts={"paged-fidelity-ubuntu-latest": "corpus diff (ubuntu-latest)",
                    "paged-fidelity-macos-latest": "corpus diff (macos-latest)"}),
    dict(component="core", old_repo="paged-media/core", old_file="gpu.yml",
         old_run=39105589730, new_file="core-gpu.yml", new_run=None,
         new_note="not triggered: the pull_request path filter (paged-gpu, "
                  "paged-compose, paged-renderer, corpus/generated) does not "
                  "match the PR's diff",
         artifacts={"vello-junit": "vello on lavapipe",
                    "vello-parity": "vello on lavapipe"}),
    dict(component="core", old_repo="paged-media/core", old_file="licenses.yml",
         old_run=39105589903, new_file="core-licenses.yml", new_run=39114572965,
         artifacts={}),
    dict(component="editor", old_repo="paged-media/editor", old_file="tests.yml",
         old_run=39111494763, new_file="editor-tests.yml", new_run=39114573051,
         artifacts={"playwright-results": "playwright"}),
    dict(component="extensions", old_repo="paged-media/plugin-sdk",
         old_file="vitest.yml", old_run=39104436980,
         new_file="extensions-vitest.yml", new_run=39114573011,
         artifacts={"vitest-junit": "vitest"}),
    dict(component="extensions", old_repo="paged-media/plugin-sdk",
         old_file="contract-guard.yml", old_run=39104436961,
         new_file="extensions-contract-guard.yml", new_run=39114573057,
         artifacts={}),
    dict(component="publish", old_repo="paged-media/plugin-publish",
         old_file="ci.yml", old_run=39103521764, new_file="publish-ci.yml",
         new_run=39114573097,
         artifacts={"nextest-junit": "tests (evidence)",
                    "vitest-junit-pdf-bundle": "tests (evidence)",
                    "vitest-junit-publish-bundle": "tests (evidence)"}),
    dict(component="image", old_repo="paged-media/plugin-image",
         old_file="ci.yml", old_run=38389428083, new_file="image-ci.yml",
         new_run=39114572997, artifacts={}),
    dict(component="image", old_repo="paged-media/plugin-image",
         old_file="publish-state.yml", old_run=38389428020,
         new_file="image-publish-state.yml", new_run=None,
         new_note="not triggered: push-to-main only (no pull_request trigger)",
         artifacts={"nextest-junit": "nextest evidence",
                    "vitest-junit": "vitest evidence"}),
    dict(component="draw", old_repo="paged-media/plugin-draw",
         old_file="rust.yml", old_run=38870353614, new_file="draw-rust.yml",
         new_run=39114572977, artifacts={}),
    dict(component="draw", old_repo="paged-media/plugin-draw",
         old_file="vitest.yml", old_run=38870353446, new_file="draw-vitest.yml",
         new_run=39114573055, artifacts={"vitest-junit": "vitest"}),
    dict(component="sheet", old_repo="paged-media/plugin-sheets",
         old_file="rust.yml", old_run=39098219634, new_file="sheet-rust.yml",
         new_run=39114572983, artifacts={"nextest-junit": "test"}),
    dict(component="sheet", old_repo="paged-media/plugin-sheets",
         old_file="vitest.yml", old_run=39098219635, new_file="sheet-vitest.yml",
         new_run=39114573052, artifacts={"vitest-junit": "vitest"}),
    dict(component="data", old_repo="paged-media/plugin-data",
         old_file="rust.yml", old_run=39013601426, new_file="data-rust.yml",
         new_run=39114572973, artifacts={"nextest-junit": "test"}),
    dict(component="data", old_repo="paged-media/plugin-data",
         old_file="vitest.yml", old_run=39013601420, new_file="data-vitest.yml",
         new_run=39114572992, artifacts={"vitest-junit": "vitest"}),
    dict(component="doc", old_repo="paged-media/plugin-doc",
         old_file="rust.yml", old_run=39052833299, new_file="doc-rust.yml",
         new_run=None,
         new_note="not triggered: push-to-main only (no pull_request trigger, "
                  "as in the old repository)",
         artifacts={"nextest-junit": "test"}),
    dict(component="doc", old_repo="paged-media/plugin-doc",
         old_file="vitest.yml", old_run=39052833304, new_file="doc-vitest.yml",
         new_run=None,
         new_note="not triggered: push-to-main only (no pull_request trigger, "
                  "as in the old repository)",
         artifacts={"vitest-junit": "vitest"}),
    dict(component="slide", old_repo="paged-media/plugin-slide",
         old_file="bundle.yml", old_run=39052837993, new_file="slide-bundle.yml",
         new_run=39114573084, artifacts={"vitest-junit": "bundle"}),
    dict(component="slide", old_repo="paged-media/plugin-slide",
         old_file="rust.yml", old_run=39052837969, new_file="slide-rust.yml",
         new_run=39114573053, artifacts={"nextest-junit": "test"}),
    dict(component="web", old_repo="paged-media/plugin-web",
         old_file="rust.yml", old_run=39012929516, new_file="web-rust.yml",
         new_run=39114573076, artifacts={"nextest-junit": "test"}),
    dict(component="web", old_repo="paged-media/plugin-web",
         old_file="vitest.yml", old_run=39012929525, new_file="web-vitest.yml",
         new_run=39114573021, artifacts={"vitest-junit": "vitest"}),
]

# Jobs whose counts are summed into one suite.
JOB_GROUPS = [(re.compile(r"^playwright \(shard \d+/\d+\)$"), "playwright")]


# ---------------------------------------------------------------- fetching

def gh_api(path: str, raw: bool = False):
    out = subprocess.run(["gh", "api", path], check=True, capture_output=True)
    return out.stdout if raw else json.loads(out.stdout)


class Cache:
    def __init__(self, root: str):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _path(self, *parts):
        p = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def json(self, key: str, path: str, refresh: bool = False):
        p = self._path("api", key + ".json")
        if not refresh and os.path.exists(p):
            with open(p) as fh:
                return json.load(fh)
        data = gh_api(path)
        with open(p, "w") as fh:
            json.dump(data, fh)
        return data

    def log(self, repo: str, job_id: int) -> str:
        p = self._path("logs", f"{repo.replace('/', '_')}-{job_id}.log")
        if not os.path.exists(p):
            data = gh_api(f"repos/{repo}/actions/jobs/{job_id}/logs", raw=True)
            with open(p, "wb") as fh:
                fh.write(data)
        with open(p, "rb") as fh:
            return fh.read().decode("utf-8", "replace")

    def artifact(self, repo: str, art_id: int) -> dict[str, bytes]:
        p = self._path("artifacts", f"{art_id}.zip")
        if not os.path.exists(p):
            data = gh_api(f"repos/{repo}/actions/artifacts/{art_id}/zip", raw=True)
            with open(p, "wb") as fh:
                fh.write(data)
        with zipfile.ZipFile(p) as zf:
            return {n: zf.read(n) for n in zf.namelist() if not n.endswith("/")}


def run_bundle(cache: Cache, repo: str, run_id: int, refresh: bool):
    run = cache.json(f"{repo.replace('/', '_')}-run-{run_id}",
                     f"repos/{repo}/actions/runs/{run_id}", refresh)
    jobs = cache.json(f"{repo.replace('/', '_')}-jobs-{run_id}",
                      f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100",
                      refresh)["jobs"]
    arts = cache.json(f"{repo.replace('/', '_')}-arts-{run_id}",
                      f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100",
                      refresh)["artifacts"]
    return run, jobs, arts


# ---------------------------------------------------------------- parsing

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
STAMP = re.compile(r"^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?")


def clean_lines(text: str) -> list[str]:
    return [STAMP.sub("", ANSI.sub("", ln)) for ln in text.splitlines()]


CARGO = re.compile(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; "
                   r"(\d+) ignored;(?: (\d+) measured;)? (\d+) filtered out")
NEXTEST = re.compile(r"^\s*Summary \[\s*([\d.]+)s\] (\d+) tests? run: (\d+) passed(.*)$")
NEXTEST_START = re.compile(r"^\s*Starting (\d+) tests? across (\d+) binar(?:y|ies)"
                           r"(?: \((\d+) tests? skipped\))?")
VITEST_TESTS = re.compile(r"\bTests\s{2,}((?:\d+ [a-z]+(?: \| )?)+)\s*\((\d+)\)")
VITEST_FILES = re.compile(r"\bTest Files\s{2,}((?:\d+ [a-z]+(?: \| )?)+)\s*\((\d+)\)")
NODE_TEST = re.compile(r"^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$")
PW_RUNNING = re.compile(r"^Running (\d+) tests? using (\d+) workers?(?:, shard (\d+) of (\d+))?")
PW_FINAL = re.compile(r"^\s+(\d+) (passed|failed|flaky|skipped|did not run|interrupted)(?: \((.+)\))?\s*$")
EXPORT_HARD = re.compile(r"^hard-gating (\d+) fixtures")
EXPORT_PAGE = re.compile(r"^(\S+) p(\d+): mean_de=\S+ ssim=\S+ \[(\w+)\]")
FIDELITY_FIX = re.compile(r"^\[([\w.-]+)\] (PASS|FAIL|SKIP\w*|INCONCLUSIVE\w*):")
WASM_SIZE = re.compile(r"^compressed size: (\d+) bytes")
GUARD_OK = re.compile(r"(\bOK\b.*|skipping .*)$")
GPU_ADAPTER = re.compile(r"^(?:\s*deviceName\s+= (.+)|test GPU adapter: ([^|]+?) \|)")


def kv_counts(blob: str) -> dict[str, int]:
    return {k: int(v) for v, k in re.findall(r"(\d+) ([a-z]+)", blob)}


def parse_log(text: str) -> dict:
    """All test signals found in one job log, keyed by framework."""
    lines = clean_lines(text)
    out: dict = {}
    steps: list[list[str]] = [[]]
    for ln in lines:
        if ln.startswith("##[group]Run "):
            steps.append([])
        steps[-1].append(ln)

    cargo = [m for m in map(CARGO.search, lines) if m]
    if cargo:
        p = sum(int(m[2]) for m in cargo)
        f = sum(int(m[3]) for m in cargo)
        i = sum(int(m[4]) for m in cargo)
        out["cargo test"] = dict(run=p + f, passed=p, failed=f, skipped=i,
                                 filtered_out=sum(int(m[6]) for m in cargo),
                                 result_lines=len(cargo))

    nx = [m for m in map(NEXTEST.match, lines) if m]
    if nx:
        acc = collections.Counter()
        for m in nx:
            rest = kv_counts(m[4])
            acc["run"] += int(m[2])
            acc["passed"] += int(m[3])
            acc["failed"] += rest.get("failed", 0)
            acc["skipped"] += rest.get("skipped", 0)
            acc["flaky"] += rest.get("flaky", 0)
            acc["slow"] += rest.get("slow", 0)
            acc["seconds"] += float(m[1])
        starts = [m for m in map(NEXTEST_START.match, lines) if m]
        acc["binaries"] = sum(int(m[2]) for m in starts)
        acc["invocations"] = len(nx)
        out["nextest"] = dict(acc)

    vt = [m for m in map(VITEST_TESTS.search, lines) if m]
    if vt:
        acc = collections.Counter()
        for m in vt:
            c = kv_counts(m[1])
            acc["total"] += int(m[2])
            acc["passed"] += c.get("passed", 0)
            acc["failed"] += c.get("failed", 0)
            acc["skipped"] += c.get("skipped", 0) + c.get("todo", 0)
        acc["run"] = acc["passed"] + acc["failed"]
        files = collections.Counter()
        for m in filter(None, map(VITEST_FILES.search, lines)):
            files["total"] += int(m[2])
            for k, v in kv_counts(m[1]).items():
                files[k] += v
        acc["invocations"] = len(vt)
        out["vitest"] = dict(acc, files=dict(files))

    nt = [m for m in map(NODE_TEST.match, lines) if m]
    if nt:
        acc = collections.Counter()
        for m in nt:
            acc[m[1]] += int(m[2])
        acc["invocations"] = sum(1 for m in nt if m[1] == "tests")
        out["node:test"] = dict(run=acc["pass"] + acc["fail"], passed=acc["pass"],
                                failed=acc["fail"],
                                skipped=acc["skipped"] + acc["todo"],
                                total=acc["tests"], cancelled=acc["cancelled"],
                                invocations=acc["invocations"])

    started = False
    pw = collections.Counter()
    for ln in lines:
        m = PW_RUNNING.match(ln)
        if m:
            started = True
            pw["total"] += int(m[1])
            continue
        if started:
            m = PW_FINAL.match(ln)
            if m:
                pw[m[2].replace(" ", "_")] += int(m[1])
    if started:
        pw["run"] = pw["passed"] + pw["failed"] + pw["flaky"]
        out["playwright"] = dict(pw)

    hard = None
    for idx, st in enumerate(steps):
        for ln in st:
            m = EXPORT_HARD.match(ln)
            if m:
                hard = (idx, int(m[1]))
    if hard:
        sections = {"hard": collections.Counter(), "advisory": collections.Counter()}
        fixtures = {"hard": set(), "advisory": set()}
        for idx, st in enumerate(steps):
            if idx < hard[0]:
                continue
            key = "hard" if idx == hard[0] else "advisory"
            for ln in st:
                m = EXPORT_PAGE.match(ln)
                if m:
                    sections[key][m[3]] += 1
                    fixtures[key].add(m[1])
        out["export-diff gate"] = dict(
            gated_fixtures=hard[1], hard_fixtures_seen=len(fixtures["hard"]),
            hard_pages=dict(sections["hard"]),
            advisory_fixtures=len(fixtures["advisory"]),
            advisory_pages=dict(sections["advisory"]))

    fid = collections.Counter(m[2] for m in map(FIDELITY_FIX.match, lines) if m)
    if fid:
        out["fidelity gate (log)"] = dict(fid, fixtures=sum(fid.values()))

    gpu = sorted({(m[1] or m[2]).strip() for m in map(GPU_ADAPTER.match, lines) if m})
    if gpu:
        out["gpu adapter"] = gpu

    ws = [int(m[1]) for m in map(WASM_SIZE.match, lines) if m]
    if ws:
        out["wasm-size gate"] = dict(compressed_bytes=ws[-1])

    guards = []
    for st in steps:
        if not st or not st[0].startswith("##[group]Run pnpm test:"):
            continue
        name = st[0][len("##[group]Run pnpm "):].split()[0]
        hits = [GUARD_OK.search(ln) for ln in st[1:]]
        hits = [h[0].strip() for h in hits if h]
        if hits:
            guards.append(dict(step=name, line=hits[-1]))
    if guards:
        out["guards"] = guards
    return out


def junit_cases(blob: bytes):
    """(id, status) per testcase; files may hold several concatenated docs."""
    text = blob.decode("utf-8", "replace")
    docs = [d for d in re.split(r"(?=<\?xml)", text) if d.strip()]
    for doc in docs:
        root = ET.fromstring(doc.encode("utf-8"))
        for suite in root.iter("testsuite"):
            sname = suite.get("name", "")
            for tc in suite.findall("testcase"):
                tags = {child.tag for child in tc}
                if tags & {"failure", "error"}:
                    status = "failed"
                elif "skipped" in tags:
                    status = "skipped"
                elif tags & {"flakyFailure", "flakyError"}:
                    status = "flaky"
                else:
                    status = "passed"
                yield (f"{sname} :: {tc.get('classname', '')} :: {tc.get('name', '')}",
                       status)


def parse_artifact(name: str, files: dict[str, bytes]) -> dict:
    res: dict = {}
    for fname, blob in sorted(files.items()):
        if fname.endswith(".xml"):
            cases = list(junit_cases(blob))
            c = collections.Counter(s for _, s in cases)
            res.setdefault("junit", []).append(dict(
                artifact=name, file=fname, total=len(cases), **c,
                ids=sorted(i for i, _ in cases),
                cases=sorted(f"{s}\t{i}" for i, s in cases)))
        elif fname == "paged-results-fidelity.json":
            d = json.loads(blob)
            res["fidelity results"] = dict(
                artifact=name, fixtures=len(d["results"]),
                **collections.Counter(r["status"] for r in d["results"]))
        elif fname == "parity.json":
            d = json.loads(blob)
            fx = d["fixtures"]
            res["vello parity"] = dict(
                artifact=name, fixtures=len(fx),
                passed=sum(1 for f in fx if f.get("passed")),
                failed=sum(1 for f in fx if not f.get("passed")),
                pages=sum(f.get("pages", 0) for f in fx))
        elif fname == "playwright-results.json":
            st = json.loads(blob)["stats"]
            res["playwright (report)"] = dict(
                artifact=name, expected=st["expected"], skipped=st["skipped"],
                unexpected=st["unexpected"], flaky=st["flaky"],
                total=st["expected"] + st["skipped"] + st["unexpected"] + st["flaky"])
    return res


# ---------------------------------------------------------------- assembly

def seconds(a, b):
    if not a or not b:
        return None
    f = "%Y-%m-%dT%H:%M:%SZ"
    return int((dt.datetime.strptime(b, f) - dt.datetime.strptime(a, f)).total_seconds())


def step_info(job):
    best = None
    for st in job.get("steps") or []:
        s = seconds(st.get("started_at"), st.get("completed_at"))
        if s is not None and (best is None or s > best[1]):
            best = (st["name"], s)
    return dict(name=best[0], seconds=best[1]) if best else None


def side(cache: Cache, repo: str, run_id: int, art_map: dict, refresh: bool):
    run, jobs, arts = run_bundle(cache, repo, run_id, refresh)
    by_job: dict[str, dict] = {}
    for job in jobs:
        name = job["name"]
        group = next((g for rx, g in JOB_GROUPS if rx.match(name)), name)
        entry = by_job.setdefault(group, dict(
            job_ids=[], jobs=[], runner=",".join(job.get("labels") or []),
            log={}, artifacts={}))
        dur = seconds(job.get("started_at"), job.get("completed_at"))
        entry["job_ids"].append(job["id"])
        entry["jobs"].append(dict(name=name, id=job["id"], status=job["status"],
                                  conclusion=job["conclusion"], seconds=dur,
                                  slowest_step=step_info(job)))
        if job["status"] == "completed" and job["conclusion"] not in ("skipped", None):
            parsed = parse_log(cache.log(repo, job["id"]))
            for fw, counts in parsed.items():
                if fw in ("guards", "gpu adapter"):
                    entry["log"].setdefault(fw, []).extend(counts)
                elif fw in entry["log"]:
                    merged = collections.Counter(entry["log"][fw])
                    for k, v in counts.items():
                        if isinstance(v, (int, float)):
                            merged[k] += v
                    entry["log"][fw] = dict(merged)
                else:
                    entry["log"][fw] = counts
    for art in arts:
        target = art_map.get(art["name"])
        if not target or art.get("expired"):
            continue
        parsed = parse_artifact(art["name"], cache.artifact(repo, art["id"]))
        entry = by_job.setdefault(target, dict(job_ids=[], jobs=[], runner="",
                                               log={}, artifacts={}))
        for k, v in parsed.items():
            if k == "junit":
                entry["artifacts"].setdefault("junit", []).extend(v)
            else:
                entry["artifacts"][k] = v
    for entry in by_job.values():
        secs = [j["seconds"] for j in entry["jobs"] if j["seconds"] is not None]
        entry["seconds"] = sum(secs) if secs else None
        entry["max_job_seconds"] = max(secs) if secs else None
        entry["conclusion"] = ",".join(sorted({str(j["conclusion"]) for j in entry["jobs"]}))
    meta = dict(repo=repo, run_id=run_id, url=run["html_url"], head_sha=run["head_sha"],
                event=run["event"], head_branch=run["head_branch"],
                status=run["status"], conclusion=run["conclusion"],
                created_at=run["created_at"], updated_at=run["updated_at"])
    return meta, by_job


def junit_totals(entry):
    js = entry.get("artifacts", {}).get("junit") or []
    if not js:
        return None
    acc = collections.Counter()
    ids = collections.Counter()
    cases = collections.Counter()
    for j in js:
        for k in ("total", "passed", "failed", "skipped", "flaky"):
            acc[k] += j.get(k, 0)
        ids.update(j["ids"])
        cases.update(j["cases"])
    return dict(acc), ids, cases


def diff_ids(old, new, limit=60):
    """Test ids added/removed, and ids present on both sides whose status changed."""
    old_ids, new_ids = old[1], new[1]
    added = sorted((new_ids - old_ids).elements())
    removed = sorted((old_ids - new_ids).elements())
    both = set(old_ids) & set(new_ids)
    changed = sorted({c.split("\t", 1)[1] for c in (old[2] - new[2]) + (new[2] - old[2])
                      if c.split("\t", 1)[1] in both})
    return dict(added_count=len(added), removed_count=len(removed),
                status_changed_count=len(changed),
                added=added[:limit], removed=removed[:limit],
                status_changed=changed[:limit])


def strip_ids(entry):
    e = json.loads(json.dumps(entry))
    for j in e.get("artifacts", {}).get("junit", []):
        j.pop("ids", None)
        j.pop("cases", None)
    return e


# ---------------------------------------------------------------- suites

COUNT_KEYS = ("run", "passed", "failed", "skipped")
COUNTED = {"cargo test", "nextest", "vitest", "node:test", "playwright"}
SKIP_FW = {"gpu adapter"}

# Explanations for suites whose old and new results are not identical, keyed
# by (new workflow file, job, framework). Filled in from the analysis in
# docs/migration/parity.md.
_D1 = "the +1 test added before the import, see D1"
NOTES: dict[tuple[str, str, str], str] = {
    ("core-ci.yml", "check + test (ubuntu-latest)", "cargo test"): _D1,
    ("core-ci.yml", "check + test (macos-latest)", "cargo test"): _D1,
    ("core-ci.yml", "nextest evidence", "nextest"): _D1,
    ("core-ci.yml", "nextest evidence", "JUnit nextest-junit"): _D1,
}

# Suites that cannot run yet in the monorepo, keyed by (new workflow, job).
PENDING: dict[tuple[str, str], str] = {
    ("editor-tests.yml", "playwright"):
        "pending: secret STATE_DISPATCH_TOKEN (corpus checkout fails before "
        "Playwright starts)",
}


def norm(fw: str, c) -> dict:
    if fw in COUNTED:
        d = {k: c.get(k, 0) for k in COUNT_KEYS}
        if fw == "playwright":
            d["flaky"] = c.get("flaky", 0)
            d["did_not_run"] = c.get("did_not_run", 0)
        if fw == "nextest":
            d["flaky"] = c.get("flaky", 0)
            d["binaries"] = c.get("binaries", 0)
        if fw == "cargo test":
            d["result_lines"] = c.get("result_lines", 0)
            d["filtered_out"] = c.get("filtered_out", 0)
        return d
    if fw == "guards":
        return {"guards": len(c), "lines": [f"{g['step']}: {g['line']}" for g in c]}
    return {k: v for k, v in c.items() if k != "artifact"}


def frameworks(entry: dict) -> dict:
    out = {}
    for fw, c in (entry.get("log") or {}).items():
        if fw not in SKIP_FW:
            out[fw] = ("log", norm(fw, c))
    arts = entry.get("artifacts") or {}
    for j in arts.get("junit", []):
        key = f"JUnit {j['artifact']}"
        prev = out.get(key, ("junit", collections.Counter()))[1]
        acc = collections.Counter(prev)
        for k in ("total", "passed", "failed", "skipped", "flaky"):
            acc[k] += j.get(k, 0)
        out[key] = ("junit", dict(run=acc["total"] - acc["skipped"], passed=acc["passed"],
                                  failed=acc["failed"], skipped=acc["skipped"],
                                  total=acc["total"]))
    for k, v in arts.items():
        if k != "junit":
            out[k] = ("artifact", norm(k, v))
    return out


def side_summary(meta, entry):
    if entry is None:
        return None
    return dict(run_id=meta["run_id"], sha=meta["head_sha"], job_ids=entry["job_ids"],
                conclusion=entry["conclusion"], seconds=entry["seconds"],
                max_job_seconds=entry["max_job_seconds"],
                slowest_steps=[j["slowest_step"] for j in entry["jobs"]],
                gpu_adapter=(entry.get("log") or {}).get("gpu adapter"))


def flatten(workflows: list[dict]) -> list[dict]:
    suites = []
    for w in workflows:
        oj = w["old"]["jobs"]
        nj = (w["new"] or {}).get("jobs", {})
        for job in list(oj) + [j for j in nj if j not in oj]:
            o, n = oj.get(job), nj.get(job)
            ofw = frameworks(o) if o else {}
            nfw = frameworks(n) if n else {}
            names = list(ofw) + [f for f in nfw if f not in ofw]
            if not names:
                names = [None]  # a job without test signals: timing only
            for fw in names:
                row = dict(component=w["component"], old_workflow=w["old_file"],
                           new_workflow=w["new_file"], job=job, framework=fw,
                           source=(ofw.get(fw) or nfw.get(fw) or (None,))[0],
                           runner=(o or n or {}).get("runner", ""),
                           old=side_summary(w["old"]["run"], o),
                           new=side_summary(w["new"]["run"], n) if w["new"] else None)
                if row["old"] is not None:
                    row["old"]["counts"] = ofw.get(fw, (None, None))[1]
                if row["new"] is not None:
                    row["new"]["counts"] = nfw.get(fw, (None, None))[1]
                oc = (row["old"] or {}).get("counts")
                nc = (row["new"] or {}).get("counts")
                if w["new"] is None:
                    status = "not run"
                    row["status_note"] = w["new_note"]
                elif n is None or n["conclusion"] == "skipped":
                    status = "not run"
                    row["status_note"] = "job skipped on pull_request"
                elif (w["new_file"], job) in PENDING and fw is not None:
                    status = "pending"
                    row["status_note"] = PENDING[(w["new_file"], job)]
                elif fw is None:
                    status = "no tests"
                elif nc is None and n["conclusion"] != "success":
                    status = "failed before tests"
                elif oc == nc:
                    status = "match"
                else:
                    status = "differs"
                row["status"] = status
                if oc and nc and fw and all(k in oc for k in COUNT_KEYS if k in nc):
                    row["delta"] = {k: nc[k] - oc[k] for k in nc
                                    if isinstance(nc.get(k), int) and isinstance(oc.get(k), int)
                                    and nc[k] != oc[k]}
                note = NOTES.get((w["new_file"], job, fw or ""))
                if note:
                    row["note"] = note
                suites.append(row)
    return suites


def fmt_secs(s):
    if s is None:
        return "—"
    return f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


def fmt_counts(fw, c):
    if c is None:
        return "—"
    if fw is None:
        return "(no test counts)"
    if all(k in c for k in COUNT_KEYS):
        s = f"{c['run']} / {c['passed']} / {c['failed']} / {c['skipped']}"
        extra = [f"{k.replace('_', ' ')} {c[k]}" for k in ("flaky", "did_not_run")
                 if c.get(k)]
        return s + (f" ({', '.join(extra)})" if extra else "")
    if "total" in c and "passed" in c:  # JUnit
        return f"{c['total']} / {c['passed']} / {c.get('failed', 0)} / {c.get('skipped', 0)}"
    if fw == "guards":
        return f"{c['guards']} guard steps OK"
    if fw == "export-diff gate":
        hp = ", ".join(f"{v} {k}" for k, v in c["hard_pages"].items())
        ap_ = ", ".join(f"{v} {k}" for k, v in c["advisory_pages"].items())
        return (f"hard: {c['gated_fixtures']} fixtures, pages {hp}; "
                f"advisory: {c['advisory_fixtures']} fixture, pages {ap_}")
    if fw == "fidelity gate (log)":
        return f"{c['fixtures']} fixtures: {c.get('PASS', 0)} PASS, {c.get('FAIL', 0)} FAIL lines"
    if fw.startswith("paged-fidelity") or fw == "fidelity results":
        rest = ", ".join(f"{v} {k}" for k, v in c.items() if k != "fixtures")
        return f"{c['fixtures']} fixtures: {rest}"
    if fw == "vello parity":
        return f"{c['fixtures']} fixtures / {c['pages']} pages: {c['passed']} passed, {c['failed']} failed"
    if fw == "wasm-size gate":
        return f"{c['compressed_bytes']} bytes (brotli)"
    if fw == "playwright (report)":
        return (f"{c['total']}: {c['expected']} expected, {c['skipped']} skipped, "
                f"{c['unexpected']} unexpected, {c['flaky']} flaky")
    return json.dumps(c)


def fmt_delta(row):
    st = row["status"]
    if st in ("match",):
        return "0"
    if st == "no tests":
        return ""
    if st == "not run":
        return "not run on the PR, see below"
    if st == "failed before tests":
        return "not measured"
    if st == "pending":
        return row["status_note"]
    d = row.get("delta")
    if d:
        return ", ".join(f"{k.replace('_', ' ')} {v:+d}" for k, v in d.items())
    return "differs"


def run_link(repo, run_id):
    return f"[{run_id}](https://github.com/{repo}/actions/runs/{run_id})"


def markdown(doc: dict) -> str:
    out = []
    repos = {w["new_file"]: w["old_repo"] for w in doc["workflows"]}
    comp = None
    for r in doc["suites"]:
        if r["framework"] is None:
            continue  # jobs without test signals are in the timing table only
        if r["component"] != comp:
            comp = r["component"]
            out.append(f"\n### {comp}\n")
            out.append("| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip "
                       "| New run | New run/pass/fail/skip | Δ |")
            out.append("|---|---|---|---|---|---|")
        o, n = r["old"], r["new"]
        fw = r["framework"]
        suite = f"`{r['new_workflow']}` / {r['job']} / {r['runner'] or '—'} / {fw or '—'}"
        old_run = f"{run_link(repos[r['new_workflow']], o['run_id'])} `{o['sha'][:7]}`" if o else "—"
        new_run = (f"{run_link(doc['new_repo'], n['run_id'])} `{n['sha'][:7]}`"
                   if n else "—")
        delta = fmt_delta(r)
        if r.get("note"):
            delta += f": {r['note']}"
        out.append(f"| {suite} | {old_run} | {fmt_counts(fw, o and o.get('counts'))} | {new_run} "
                   f"| {fmt_counts(fw, n and n.get('counts')) if n else '—'} | {delta} |")
    return "\n".join(out) + "\n"


def timing_markdown(doc: dict) -> str:
    rows, seen = [], set()
    for r in doc["suites"]:
        key = (r["new_workflow"], r["job"])
        if key in seen:
            continue
        seen.add(key)
        o, n = r["old"], r["new"]
        rows.append((r, o, n))
    out = ["| Workflow / job | Runner | Old job time | New job time | Δ | Slowest step (old) |",
           "|---|---|---|---|---|---|"]
    for r, o, n in rows:
        os_, ns = (o or {}).get("seconds"), (n or {}).get("seconds")
        new_txt = fmt_secs(ns)
        if not n:
            new_txt = "not run"
        elif n.get("conclusion") == "skipped":
            ns, new_txt = None, "skipped"
        elif n.get("conclusion") != "success":
            new_txt, ns = f"{fmt_secs(ns)} ({n.get('conclusion')})", None
        d = f"{ns - os_:+d}s" if os_ is not None and ns is not None else "—"
        slow = ""
        if o and o.get("slowest_steps"):
            st = max((s for s in o["slowest_steps"] if s), key=lambda s: s["seconds"],
                     default=None)
            if st:
                slow = f"{st['name']} ({fmt_secs(st['seconds'])})"
        out.append(f"| `{r['new_workflow']}` / {r['job']} | {r['runner'] or '—'} | {fmt_secs(os_)} "
                   f"| {new_txt} | {d} | {slow} |")
    return "\n".join(out) + "\n"


def slowest_markdown(doc: dict, n: int = 10) -> str:
    """The n longest test-bearing jobs (summed shards), old side, with new."""
    jobs = {}
    for r in doc["suites"]:
        if r["framework"] is None or not r["old"]:
            continue
        key = (r["new_workflow"], r["job"])
        o, nw = r["old"], r["new"]
        if not nw:
            new_txt = "not run"
        elif r["status"] == "pending":
            new_txt = "pending"
        elif nw.get("conclusion") == "skipped":
            new_txt = "skipped"
        elif nw.get("conclusion") != "success":
            new_txt = str(nw.get("conclusion"))
        else:
            new_txt = fmt_secs(nw.get("seconds"))
        jobs[key] = (o["seconds"] or 0, o.get("max_job_seconds"), new_txt, r["runner"])
    rows = sorted(jobs.items(), key=lambda kv: -kv[1][0])[:n]
    out = ["| # | Workflow / job | Runner | Old (sum of jobs) | Old (longest job) | New |",
           "|---|---|---|---|---|---|"]
    for i, ((wf, job), (s, mx, ns, runner)) in enumerate(rows, 1):
        out.append(f"| {i} | `{wf}` / {job} | {runner} | {fmt_secs(s)} | {fmt_secs(mx)} "
                   f"| {ns} |")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", required=True, help="directory for API data, logs, artifacts")
    ap.add_argument("--out", required=True, help="JSON output path")
    ap.add_argument("--markdown", help="also write the suite and timing tables here")
    ap.add_argument("--refresh-new", action="store_true",
                    help="re-read the new runs' API data (logs stay cached)")
    args = ap.parse_args()
    cache = Cache(args.cache)

    workflows = []
    for wf in WORKFLOWS:
        rec = dict(component=wf["component"], old_repo=wf["old_repo"],
                   old_file=wf["old_file"], new_file=wf["new_file"])
        old_meta, old_jobs = side(cache, wf["old_repo"], wf["old_run"],
                                  wf["artifacts"], False)
        rec["old"] = dict(run=old_meta, jobs={k: strip_ids(v) for k, v in old_jobs.items()})
        refs, ref_jobs = [], {}
        for rid in wf.get("ref_runs", []):
            m, j = side(cache, wf["old_repo"], rid, wf["artifacts"], False)
            refs.append(dict(run=m, jobs={k: strip_ids(v) for k, v in j.items()}))
            ref_jobs = j
        if refs:
            rec["old_reference_runs"] = refs
        new_jobs = {}
        if wf["new_run"]:
            new_meta, new_jobs = side(cache, NEW_REPO, wf["new_run"], wf["artifacts"],
                                      args.refresh_new)
            rec["new"] = dict(run=new_meta,
                              jobs={k: strip_ids(v) for k, v in new_jobs.items()})
        else:
            rec["new"] = None
            rec["new_note"] = wf["new_note"]
        # JUnit id diffs (old vs new, and old vs the reference run).
        diffs = {}
        for job, entry in old_jobs.items():
            ot = junit_totals(entry)
            if not ot:
                continue
            d = {}
            if job in new_jobs:
                nt = junit_totals(new_jobs[job])
                if nt:
                    d["old_vs_new"] = diff_ids(ot, nt)
            if job in ref_jobs:
                rt = junit_totals(ref_jobs[job])
                if rt:
                    d["old_vs_reference"] = diff_ids(ot, rt)
            if d:
                diffs[job] = d
        if diffs:
            rec["junit_id_diffs"] = diffs
        workflows.append(rec)

    doc = dict(
        description="Test-count parity: last green run of each workflow in the old "
                    "per-component repositories vs the monorepo run of the same "
                    "workflow. Produced by tooling/migration/parity_counts.py from "
                    "read-only GitHub API data (job logs + JUnit/report artifacts). "
                    "Counts are run/passed/failed/skipped; 'skipped' is cargo's "
                    "'ignored', nextest's 'skipped', vitest's skipped+todo, "
                    "Playwright's skipped.",
        generated_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        new_repo=NEW_REPO,
        workflows=workflows)
    doc["suites"] = flatten(workflows)
    with open(args.out, "w") as fh:
        json.dump(doc, fh, indent=1, sort_keys=False)
        fh.write("\n")
    if args.markdown:
        with open(args.markdown, "w") as fh:
            fh.write("## Suites\n" + markdown(doc) + "\n## Job times\n\n" + timing_markdown(doc)
                     + "\n## Slowest suites\n\n" + slowest_markdown(doc))
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
