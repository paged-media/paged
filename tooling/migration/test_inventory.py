#!/usr/bin/env python3
"""Test inventory for wave T (step T0): wall time, durations, skips, flakes, fakes, mapping.

    python3 tooling/migration/test_inventory.py history --cache DIR [--runs 30]
    python3 tooling/migration/test_inventory.py report  --cache DIR --out FILE.json \
        [--nextest-lists DIR] [--test-map FILE] [--test-map-after FILE] \
        [--test-ids FILE] [--merge-report FILE] [--features DIR] [--cockpit-config FILE]
    python3 tooling/migration/test_inventory.py tables FILE.json --out TABLES.md
    python3 tooling/migration/test_inventory.py skips [--out FILE.json]

`history` reads GitHub Actions data with read-only `gh api` GETs: the last N
runs of every test workflow, in the old per-component repositories and in the
monorepo, with the jobs of every attempt (`filter=all`), and the logs of
failed test steps. Everything is cached under --cache (the same layout as
parity_counts.py, so its cache can seed this one).

`report` needs no network once the cache is filled. It combines:

- docs/migration/parity-baseline.json (A5): per-suite counts and job times;
- the cached job/step data of the same runs: the setup / cache / build+test /
  report split of each job, with the step buckets of ci-timing-baseline.json;
- the cached JUnit and Playwright artifacts of the same runs: per-test
  durations;
- the source tree: `#[ignore]` reasons, early returns on missing resources
  (silent skips), env gates, hand-rolled fakes and wasm boot helpers;
- `cargo nextest list --run-ignored all` dumps (test-ids.py `dump`) for the
  Rust workspaces, and the artifacts' test ids for TS and Playwright;
- a Cockpit test map, matched with test-ids.py's rules (plus Cockpit's
  `source` scoping and its explicit `@feat:`/`__feat__` references); the
  Cockpit config says which evidence source reads which artifact. Only counts
  and test ids from these private inputs reach the output.

It writes one JSON document (--out); `tables` renders the Markdown tables used
in docs/migration/test-inventory.md from it. `skips` is the source scan alone
(no cache, no network): the Rust silent skips, the skips reported through
paged-test-resources (T3), and the `#[ignore]`d tests. Logs missing from the cache are
fetched read-only on first use.

The source scans are heuristics (regex over comment- and string-stripped
code, braces matched); docs/migration/test-inventory.md says what they count.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import importlib.util
import json
import os
import re
import statistics
import subprocess
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import parity_counts as pc  # noqa: E402  (same directory)

NEW_REPO = pc.NEW_REPO
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# ---------------------------------------------------------------- workflows

# Test-bearing workflows: (component, old repo, old file, new file). None: no
# counterpart on that side.
HISTORY = [
    ("core", "paged-media/core", "ci.yml", "core-ci.yml"),
    ("core", "paged-media/core", "fidelity.yml", "core-fidelity.yml"),
    ("core", "paged-media/core", "gpu.yml", "core-gpu.yml"),
    ("core", "paged-media/core", "perf-nightly.yml", "core-perf-nightly.yml"),
    ("editor", "paged-media/editor", "tests.yml", "editor-tests.yml"),
    ("editor", "paged-media/editor", "showcase-nightly.yml", "editor-showcase-nightly.yml"),
    ("extensions", "paged-media/plugin-sdk", "vitest.yml", "extensions-vitest.yml"),
    ("publish", "paged-media/plugin-publish", "ci.yml", "publish-ci.yml"),
    ("image", "paged-media/plugin-image", "ci.yml", "image-ci.yml"),
    ("image", "paged-media/plugin-image", "publish-state.yml", "image-publish-state.yml"),
    ("draw", "paged-media/plugin-draw", "rust.yml", "draw-rust.yml"),
    ("draw", "paged-media/plugin-draw", "vitest.yml", "draw-vitest.yml"),
    ("sheet", "paged-media/plugin-sheets", "rust.yml", "sheet-rust.yml"),
    ("sheet", "paged-media/plugin-sheets", "vitest.yml", "sheet-vitest.yml"),
    ("sheet", "paged-media/plugin-sheets", "fuzz.yml", "sheet-fuzz.yml"),
    ("data", "paged-media/plugin-data", "rust.yml", "data-rust.yml"),
    ("data", "paged-media/plugin-data", "vitest.yml", "data-vitest.yml"),
    ("doc", "paged-media/plugin-doc", "rust.yml", "doc-rust.yml"),
    ("doc", "paged-media/plugin-doc", "vitest.yml", "doc-vitest.yml"),
    ("slide", "paged-media/plugin-slide", "bundle.yml", "slide-bundle.yml"),
    ("slide", "paged-media/plugin-slide", "rust.yml", "slide-rust.yml"),
    ("web", "paged-media/plugin-web", "rust.yml", "web-rust.yml"),
    ("web", "paged-media/plugin-web", "vitest.yml", "web-vitest.yml"),
    ("server", None, None, "server-rust.yml"),
    ("moon", None, None, "moon.yml"),
]

# Step buckets, the same rules as docs/migration/ci-timing-baseline.json (A3).
_CACHE = re.compile(r"(rust-cache|^cache |^post cache |actions/cache)", re.I)
_REPORT = re.compile(r"(^upload |download shard|lane summary|^collect junit|^merge shards|^publish|"
                     r"^deploy|^host the wasm|^ping docs|^derive fidelity|every file fits|"
                     r"^tests failed$)", re.I)
_SETUP = re.compile(r"(^set up job$|^complete job$|^post |checkout|toolchain|rust-toolchain|"
                    r"action-setup|setup-node|^install|^run pnpm install|binaryen|wasm-bindgen|"
                    r"free runner disk|install-action|^fetch|upgrade npm|point the vulkan loader|"
                    r"^browser for|^sanity|setup-binaryen|^adapter$)", re.I)


def bucket(step_name: str) -> str:
    if _CACHE.search(step_name):
        return "cache"
    if _REPORT.search(step_name):
        return "artifact_report"
    if _SETUP.search(step_name):
        return "setup"
    return "build_test"


# ---------------------------------------------------------------- fetching

def gh_json(path: str):
    out = subprocess.run(["gh", "api", path], check=True, capture_output=True, timeout=120)
    return json.loads(out.stdout)


def gh_raw(path: str) -> bytes:
    out = subprocess.run(["gh", "api", path], check=True, capture_output=True, timeout=300)
    return out.stdout


def _cached(cache: pc.Cache, key: str, fetch, refresh=False):
    p = os.path.join(cache.root, "api", key + ".json")
    if not refresh and os.path.exists(p):
        with open(p) as fh:
            return json.load(fh)
    data = fetch()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "w") as fh:
        json.dump(data, fh)
    os.replace(p + ".tmp", p)
    return data


def runs_of(cache, repo, wf_file, n, refresh):
    key = f"hist-{repo.replace('/', '_')}-{wf_file}-runs{n}"
    try:
        return _cached(cache, key, lambda: gh_json(
            f"repos/{repo}/actions/workflows/{wf_file}/runs?per_page={n}")["workflow_runs"],
            refresh)
    except subprocess.CalledProcessError:
        return []


def jobs_all_attempts(cache, repo, run):
    key = f"hist-{repo.replace('/', '_')}-jobsall-{run['id']}"
    done = run["status"] == "completed"

    def fetch():
        jobs, page = [], 1
        while True:
            d = gh_json(f"repos/{repo}/actions/runs/{run['id']}/jobs"
                        f"?filter=all&per_page=100&page={page}")
            jobs += d["jobs"]
            if len(jobs) >= d["total_count"] or not d["jobs"]:
                return jobs
            page += 1
    return _cached(cache, key, fetch, refresh=not done)


FAIL_KIND = [
    ("report", re.compile(r"merge shards|merge reports|upload|publish evidence", re.I)),
    ("moon ci (affected tasks)", re.compile(r"^moon ci", re.I)),
    ("test", re.compile(r"test|nextest|vitest|playwright|coverage gate|fuzz|parity|diff gate|"
                        r"fidelity|build the document|chapter", re.I)),
    ("lint / policy", re.compile(r"clippy|fmt|deny|lint|catalog|guard|typecheck|boundar", re.I)),
    ("setup / infra", re.compile(r"install|checkout|action-setup|setup-|toolchain|cache|set up job|"
                                 r"merge shards|download", re.I)),
    ("build", re.compile(r"build|wasm|compile", re.I)),
]


def failure_kind(step_name):
    """What a failed job's failing step was: test, lint/policy, setup/infra, build."""
    if not step_name:
        return "no failed step (runner)"
    for label, rx in FAIL_KIND:
        if rx.search(step_name):
            return label
    return "other"


def failed_step(job):
    for st in job.get("steps") or []:
        if st.get("conclusion") == "failure":
            return st["name"]
    return None


def history(args):
    cache = pc.Cache(args.cache)
    pairs = []
    for comp, old_repo, old_file, new_file in HISTORY:
        if old_repo:
            pairs.append(("old", comp, old_repo, old_file))
        if new_file:
            pairs.append(("new", comp, NEW_REPO, new_file))
    runs = {}
    for side, comp, repo, wf in pairs:
        runs[(repo, wf)] = runs_of(cache, repo, wf, args.runs, refresh=(side == "new"))
        print(f"{repo} {wf}: {len(runs[(repo, wf)])} runs", flush=True)
    todo = [(repo, r) for (repo, _), rs in runs.items() for r in rs]
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(jobs_all_attempts, cache, repo, r): (repo, r) for repo, r in todo}
        for i, f in enumerate(cf.as_completed(futs), 1):
            try:
                f.result()
            except Exception as e:  # keep going; the report marks the run as unread
                print("jobs:", futs[f][0], futs[f][1]["id"], e, file=sys.stderr)
            if i % 50 == 0:
                print(f"jobs {i}/{len(todo)}", flush=True)
    # Logs of failed test steps (to name the failing tests).
    logs = []
    for repo, r in todo:
        p = os.path.join(cache.root, "api",
                         f"hist-{repo.replace('/', '_')}-jobsall-{r['id']}.json")
        if not os.path.exists(p):
            continue
        for j in json.load(open(p)):
            st = failed_step(j)
            if j.get("conclusion") == "failure" and failure_kind(st) == "test":
                logs.append((repo, j["id"]))
            elif (j["name"].startswith("playwright") and j.get("conclusion") == "success"):
                # Playwright retries once in CI; a retried pass is only in the log.
                logs.append((repo, j["id"]))
    print(f"logs (failed test steps + passing Playwright shards): {len(logs)}", flush=True)
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(cache.log, repo, jid): (repo, jid) for repo, jid in logs}
        for f in cf.as_completed(futs):
            try:
                f.result()
            except Exception as e:
                print("log:", futs[f], e, file=sys.stderr)
    print("history: done", flush=True)


# ---------------------------------------------------------------- 1. suites

def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def cached_jobs(cache, repo, run_id):
    """Jobs (latest attempt) of one run, from the parity_counts.py cache layout."""
    return cache.json(f"{repo.replace('/', '_')}-jobs-{run_id}",
                      f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100")["jobs"]


def job_split(job):
    """Seconds per step bucket, plus the job's run time."""
    b = collections.Counter()
    for st in job.get("steps") or []:
        s = pc.seconds(st.get("started_at"), st.get("completed_at"))
        if s is not None:
            b[bucket(st["name"])] += s
    return dict(run=pc.seconds(job.get("started_at"), job.get("completed_at")), **{
        k: b.get(k, 0) for k in ("setup", "cache", "build_test", "artifact_report")})


CARGO_FINISHED = re.compile(r"test result: .*; finished in ([\d.]+)s")
VITEST_DURATION = re.compile(r"^\s*Duration\s+([\d.]+)(ms|s|m)\b")
PW_PASSED_TIME = re.compile(r"^\s+\d+ passed \(([\d.]+)(ms|s|m|h)\)")
NODE_DURATION = re.compile(r"^# duration_ms ([\d.]+)")
_UNIT = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}


def test_phase_seconds(text):
    """Seconds the test runners themselves report (not compile, not setup)."""
    lines = pc.clean_lines(text)
    out = collections.Counter()
    for ln in lines:
        m = pc.NEXTEST.match(ln)
        if m:
            out["nextest"] += float(m[1])
        m = CARGO_FINISHED.search(ln)
        if m:
            out["cargo test"] += float(m[1])
        m = VITEST_DURATION.match(ln)
        if m:
            out["vitest"] += float(m[1]) * _UNIT[m[2]]
        m = PW_PASSED_TIME.match(ln)
        if m:
            out["playwright"] += float(m[1]) * _UNIT[m[2]]
        m = NODE_DURATION.match(ln)
        if m:
            out["node:test"] += float(m[1]) / 1000
    return {k: round(v, 1) for k, v in out.items()}


def group_of(job_name):
    return next((g for rx, g in pc.JOB_GROUPS if rx.match(job_name)), job_name)


def run_timing(cache, repo, run_id):
    """Per job group: run seconds, bucket split, test-phase seconds; plus wall."""
    jobs = cached_jobs(cache, repo, run_id)
    groups = {}
    starts, ends = [], []
    for j in jobs:
        if j.get("conclusion") in ("skipped", None):
            continue
        g = groups.setdefault(group_of(j["name"]), dict(
            jobs=0, run=0, setup=0, cache=0, build_test=0, artifact_report=0,
            test_phase={}, runner=",".join(j.get("labels") or []), conclusion=set()))
        sp = job_split(j)
        g["jobs"] += 1
        for k in ("run", "setup", "cache", "build_test", "artifact_report"):
            g[k] += sp[k] or 0
        g["conclusion"].add(j["conclusion"])
        if j.get("started_at"):
            starts.append(j["started_at"])
        if j.get("completed_at"):
            ends.append(j["completed_at"])
        log = os.path.join(cache.root, "logs", f"{repo.replace('/', '_')}-{j['id']}.log")
        if os.path.exists(log):
            with open(log, "rb") as fh:
                tp = test_phase_seconds(fh.read().decode("utf-8", "replace"))
            for k, v in tp.items():
                g["test_phase"][k] = round(g["test_phase"].get(k, 0) + v, 1)
    for g in groups.values():
        g["conclusion"] = ",".join(sorted(g["conclusion"]))
    wall = pc.seconds(min(starts), max(ends)) if starts and ends else None
    return groups, wall


def suites_section(cache, parity):
    """One row per test-bearing job: counts (from A5) + time split (from the jobs API)."""
    rows = []
    walls = []
    by_wf = {(w["new_file"]): w for w in parity["workflows"]}
    counted = ("cargo test", "nextest", "vitest", "node:test", "playwright")
    for wf in pc.WORKFLOWS:
        pw = by_wf[wf["new_file"]]
        old_t, old_wall = run_timing(cache, wf["old_repo"], wf["old_run"])
        new_t, new_wall = (run_timing(cache, NEW_REPO, wf["new_run"]) if wf.get("new_run")
                           else ({}, None))
        walls.append(dict(component=wf["component"], workflow=wf["new_file"],
                          old_run=wf["old_run"], old_wall=old_wall,
                          new_run=wf.get("new_run"), new_wall=new_wall))
        for job, entry in pw["old"]["jobs"].items():
            fws = {}
            for side in ("old", "new"):
                e = (pw.get(side) or {}).get("jobs", {}).get(job) or {}
                for fw, c in (e.get("log") or {}).items():
                    if fw in counted:
                        fws.setdefault(fw, {})[side] = dict(
                            run=c.get("run", 0), skipped=c.get("skipped", 0),
                            failed=c.get("failed", 0))
            if not fws:
                continue
            rows.append(dict(component=wf["component"], workflow=wf["new_file"], job=job,
                             runner=entry.get("runner"), frameworks=fws,
                             old=old_t.get(job), new=new_t.get(job)))
    return rows, walls


# ---------------------------------------------------------------- 2. durations

def junit_testcases(blob: bytes):
    """Every testcase of a JUnit file (several concatenated documents allowed)."""
    text = blob.decode("utf-8", "replace")
    for doc_no, doc in enumerate(d for d in re.split(r"(?=<\?xml)", text) if d.strip()):
        root = ET.fromstring(doc.encode("utf-8"))
        for suite in root.iter("testsuite"):
            sfile = suite.get("name", "")
            for tc in suite.findall("testcase"):
                tags = {c.tag: c for c in tc}
                status = ("failed" if tags.keys() & {"failure", "error"} else
                          "skipped" if "skipped" in tags else "passed")
                msg = tags["skipped"].get("message") if "skipped" in tags else None
                yield dict(doc=doc_no, suite=sfile, classname=tc.get("classname", ""),
                           name=tc.get("name", ""), seconds=float(tc.get("time") or 0),
                           status=status, skip_message=msg)
            st = suite.get("time")
            if st is not None:
                yield dict(doc=doc_no, suite=sfile, file_seconds=float(st), file=True)


def playwright_testcases(blob: bytes):
    data = json.loads(blob)

    def walk(suite, titles, file):
        file = suite.get("file") or file
        t = titles + ([suite["title"]] if suite.get("title") and suite.get("title") != file else [])
        for spec in suite.get("specs") or []:
            for test in spec.get("tests") or []:
                results = test.get("results") or []
                dur = sum(r.get("duration", 0) for r in results) / 1000
                retries = max((r.get("retry", 0) for r in results), default=0)
                ann = [a for a in (test.get("annotations") or []) if a.get("type") in ("skip", "fixme")]
                for r in results:
                    ann += [a for a in (r.get("annotations") or []) if a.get("type") in ("skip", "fixme")]
                yield dict(file=spec.get("file") or file, title=" › ".join(t + [spec["title"]]),
                           project=test.get("projectName"), seconds=dur,
                           status=test.get("status"), retries=retries,
                           tags=spec.get("tags") or [],
                           skip_reason=(ann[0].get("description") or ann[0]["type"]) if ann else None)
        for child in suite.get("suites") or []:
            yield from walk(child, t, file)

    for s in data["suites"]:
        yield from walk(s, [], s.get("file"))


# Which artifact feeds which suite, preferring the monorepo run of A5 when it
# has one. (component, label, workflow new file, artifact)
JUNIT_SOURCES = [
    ("core", "core nextest (workspace)", "core-ci.yml", "nextest-junit"),
    ("core", "core idml-viewer vitest", "core-ci.yml", "idml-viewer-vitest-junit"),
    ("core", "core vello on lavapipe", "core-gpu.yml", "vello-junit"),
    ("editor", "editor Playwright", "editor-tests.yml", "playwright-results"),
    ("extensions", "extensions vitest", "extensions-vitest.yml", "vitest-junit"),
    ("publish", "publish nextest", "publish-ci.yml", "nextest-junit"),
    ("publish", "publish vitest (publish-bundle)", "publish-ci.yml", "vitest-junit-publish-bundle"),
    ("publish", "publish vitest (pdf-bundle)", "publish-ci.yml", "vitest-junit-pdf-bundle"),
    ("image", "image nextest", "image-publish-state.yml", "nextest-junit"),
    ("image", "image vitest", "image-publish-state.yml", "vitest-junit"),
    ("draw", "draw vitest", "draw-vitest.yml", "vitest-junit"),
    ("sheet", "sheet nextest", "sheet-rust.yml", "nextest-junit"),
    ("sheet", "sheet vitest", "sheet-vitest.yml", "vitest-junit"),
    ("data", "data nextest", "data-rust.yml", "nextest-junit"),
    ("data", "data vitest", "data-vitest.yml", "vitest-junit"),
    ("doc", "doc nextest", "doc-rust.yml", "nextest-junit"),
    ("doc", "doc vitest", "doc-vitest.yml", "vitest-junit"),
    ("slide", "slide nextest", "slide-rust.yml", "nextest-junit"),
    ("slide", "slide vitest", "slide-bundle.yml", "vitest-junit"),
    ("web", "web nextest (web-render)", "web-rust.yml", "nextest-junit"),
    ("web", "web vitest", "web-vitest.yml", "vitest-junit"),
]


def artifact_files(cache, repo, run_id, name):
    arts = cache.json(f"{repo.replace('/', '_')}-arts-{run_id}",
                      f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
    for a in arts:
        if a["name"] == name and not a.get("expired"):
            return cache.artifact(repo, a["id"])
    return None


def suite_tests(cache):
    """{label: dict(meta, tests, files)} from the artifacts of the A5 runs."""
    wfs = {w["new_file"]: w for w in pc.WORKFLOWS}
    out = {}
    for comp, label, new_file, art in JUNIT_SOURCES:
        wf = wfs[new_file]
        files = None
        for repo, run in ((NEW_REPO, wf.get("new_run")), (wf["old_repo"], wf["old_run"])):
            if run:
                files = artifact_files(cache, repo, run, art)
                if files:
                    break
        if not files:
            continue
        tests, file_secs = [], []
        for fname, blob in sorted(files.items()):
            if fname.endswith(".xml"):
                for t in junit_testcases(blob):
                    (file_secs if t.get("file") else tests).append(dict(t, report=fname))
            elif fname == "playwright-results.json":
                tests += [dict(t, report=fname) for t in playwright_testcases(blob)]
        kind = ("playwright" if art == "playwright-results" else
                "nextest" if "nextest" in art or art == "vello-junit" else "vitest")
        out[label] = dict(component=comp, workflow=new_file, artifact=art, repo=repo,
                          run=run, kind=kind, tests=tests, files=file_secs)
    return out


def tid(kind, t):
    if kind == "playwright":
        return f"{t['file']} › {t['title']} [{t['project']}]"
    if kind == "nextest":
        return f"{t['classname']} {t['name']}"
    return f"{t['classname']} > {t['name']}"


def durations_section(suites):
    per_suite, overall = {}, []
    for label, s in suites.items():
        ran = [t for t in s["tests"] if t["status"] not in ("skipped",)]
        ran.sort(key=lambda t: -t["seconds"])
        total = sum(t["seconds"] for t in ran)
        top = [dict(id=tid(s["kind"], t), seconds=round(t["seconds"], 2)) for t in ran[:10]]
        top5 = sum(t["seconds"] for t in ran[:5])
        n90 = 0
        acc = 0.0
        for t in ran:
            if total and acc >= 0.9 * total:
                break
            acc += t["seconds"]
            n90 += 1
        files = []
        if s["kind"] == "vitest":
            # Per test file: the file's time vs the sum of its tests (the rest is
            # module load, wasm boot and beforeAll/afterAll hooks).
            by_file = collections.defaultdict(float)
            for t in s["tests"]:
                by_file[(t["report"], t["doc"], t["suite"])] += t["seconds"]
            for f in s["files"]:
                k = (f["report"], f["doc"], f["suite"])
                files.append(dict(file=f["suite"], seconds=round(f["file_seconds"], 2),
                                  tests_seconds=round(by_file.get(k, 0), 2),
                                  overhead=round(f["file_seconds"] - by_file.get(k, 0), 2)))
            files.sort(key=lambda f: -f["seconds"])
        per_suite[label] = dict(
            component=s["component"], workflow=s["workflow"], run=s["run"], repo=s["repo"],
            kind=s["kind"], tests=len(s["tests"]), ran=len(ran),
            skipped=sum(1 for t in s["tests"] if t["status"] == "skipped"),
            sum_seconds=round(total, 1), top5_share=round(top5 / total, 3) if total else None,
            tests_for_90pct=n90, slowest=top, slowest_files=files[:10],
            file_overhead_seconds=round(sum(f["overhead"] for f in files), 1) if files else None,
            file_seconds=round(sum(f["seconds"] for f in files), 1) if files else None)
        for t in ran:
            overall.append(dict(suite=label, id=tid(s["kind"], t), seconds=round(t["seconds"], 2)))
    overall.sort(key=lambda t: -t["seconds"])
    return per_suite, overall[:30]


# ---------------------------------------------------------------- 3. skips (source scan)

def git_files(root):
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True,
                         check=True).stdout.split("\n")
    return [f for f in out if f]


def module_of(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if parts[0] in ("engine", "apps", "platform", "modules") else parts[0]


_RUST_LIT = re.compile(r"""//[^\n]*|/\*.*?\*/|\bb?r(#*)".*?"\1|b?"(?:[^"\\]|\\.)*"|"""
                       r"""b?'(?:[^'\\\n]|\\[^'\n]{1,10})'""", re.S)
_TS_LIT = re.compile(r"""//[^\n]*|/\*.*?\*/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`""",
                     re.S)
_NOT_NL = re.compile(r"[^\n]")


def strip_code(src: str, lang: str) -> str:
    """Comments and string/char literals blanked (newlines and length kept), so braces
    and keywords inside them don't count. Regex-based: nested block comments and TS
    regex literals are not special-cased."""
    rx = _RUST_LIT if lang == "rust" else _TS_LIT
    return rx.sub(lambda m: _NOT_NL.sub(" ", m.group(0)), src)


def match_brace(s: str, i: int) -> int:
    """Index after the brace block that opens at s[i] == '{'."""
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                return j + 1
    return len(s)


# Why a test returns early, by the words around the guard (first hit wins).
SKIP_REASONS = [
    ("GPU adapter", re.compile(r"gpu|device|adapter|wgpu|vello|lavapipe|webgpu|navigator\.gpu|ctx_or_skip", re.I)),
    ("real engine wasm", re.compile(r"ENGINE_ANCHOR|REAL_CORE|canvas-wasm|realEngine|engine_?wasm|wasm|\bbinary\b|pkg/", re.I)),
    ("DuckDB", re.compile(r"duckdb", re.I)),
    ("build output", re.compile(r"\bDIST\b|/dist/|pnpm build|not been built|has not run", re.I)),
    ("corpus / fixture", re.compile(r"corpus|envato|fixture|sample|\.exists\(|existsSync|is_dir|is_file|read_dir|try_exists|statSync", re.I)),
    ("colour profile / font", re.compile(r"\bicc\b|profile|fogra|\bfont|myriad", re.I)),
    ("external tool", re.compile(r"indesign|osascript|Command::new|which\(|magick|pdftoppm|mutool|chrome|libreoffice|soffice|python|\bbun\b", re.I)),
    ("env switch", re.compile(r"env::var|var_os|process\.env|import\.meta\.env|REQUIRE_|PAGED_", re.I)),
]
SKIP_WORDS = re.compile(r"skip|unavailable|not found|missing|absent|not present|no .{0,30}(found|available)", re.I)

RUST_TEST_ATTR = re.compile(r"#\[(?:tokio::)?test\b[^\]]*\]|#\[wasm_bindgen_test\]|#\[rstest\]")
RUST_FN = re.compile(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)")
RUST_IGNORE = re.compile(r"#\[ignore(?:\s*=\s*\"((?:[^\"\\]|\\.)*)\")?\s*\]|#\[cfg_attr\([^\]]*\bignore\b[^\]]*\]", re.S)
RUST_RETURN = re.compile(r"\breturn\b")
SILENT_ARM = re.compile(r"\b(?:None|Err\s*\([^)]*\))\s*=>\s*(?:\{\s*\}|\(\s*\)|\{?\s*e?println!)")
# T3: a guard that goes through platform/shared/test-resources prints
# `unavailable: …` and fails under PAGED_REQUIRE_<X>=1, so it is a reported
# skip, not a silent one. So is a guard that calls a function which does
# (filled by rust_scan's first pass: HONEST_FNS by name where every
# definition reports, HONEST_LOCAL as (file, name) for the rest).
HONEST = re.compile(r"paged_test_resources|\bskip!\s*\(|\bunavailable\s*\(")
HONEST_FNS: set = set()
HONEST_LOCAL: set = set()
CALLED = re.compile(r"(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*(?:::<[^>]*>)?\s*\(")
MACRO_RULES = re.compile(r"\bmacro_rules!\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{")


def honest_guard(text, file=None):
    return bool(HONEST.search(text)) or any(
        n in HONEST_FNS or (file, n) in HONEST_LOCAL for n in CALLED.findall(text))


def classify_guard(text):
    for label, rx in SKIP_REASONS:
        if rx.search(text):
            return label
    return None


def guard_context(orig, stripped, ret_at, body_start):
    """The guard that holds a `return` at ret_at: the text from the statement that
    opens the enclosing block (`let … else {`, `if … {`, `… => {`) to the block end."""
    # innermost unclosed '{' before ret_at
    depth, j = 0, ret_at
    while j > body_start:
        j -= 1
        ch = stripped[j]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                break
            depth -= 1
    open_at = j
    # direct `=> return` / `if cond return` (no block of its own)
    line_start = stripped.rfind("\n", 0, ret_at) + 1
    head_line = stripped[line_start:ret_at]
    if re.search(r"(=>|\belse|\bif\b.*\))\s*$", head_line) and open_at < line_start:
        stmt_start = max(stripped.rfind(";", 0, ret_at), stripped.rfind("{", 0, ret_at),
                         stripped.rfind("}", 0, ret_at)) + 1
        end = stripped.find("\n", ret_at)
        return orig[stmt_start:end if end > 0 else ret_at + 40], True
    if open_at <= body_start:
        return None, False  # a plain `return` at the top of the body
    stmt_start = max(stripped.rfind(";", 0, open_at), stripped.rfind("{", 0, open_at),
                     stripped.rfind("}", 0, open_at)) + 1
    head = stripped[stmt_start:open_at]
    if not re.search(r"\belse\s*$|\bif\b|=>\s*$|\bNone\b|\bErr\b", head):
        return None, False
    close = match_brace(stripped, open_at)
    return orig[stmt_start:close], True


def is_closure_block(stripped, open_at):
    before = stripped[max(0, open_at - 80):open_at].rstrip()
    return bool(re.search(r"(\|[^|]*\|\s*(->\s*[^{]+)?|\bmove)$|=>$", before)) and not before.endswith("=>")


def rust_body_reasons(orig, st, b0, b1, nested, reported=None, file=None):
    """Resource reasons for which the body st[b0:b1] passes without testing anything.
    Guards that report through paged-test-resources go to `reported` instead."""
    reasons, msgs = [], False
    reported = [] if reported is None else reported
    for r in RUST_RETURN.finditer(st, b0, b1):
        if any(n0 < r.start() < n1 for n0, n1 in nested):
            continue  # a return of a nested fn
        ctx, guarded = guard_context(orig, st, r.start(), b0)
        if not guarded or ctx is None:
            continue
        lb = st.rfind("{", b0, r.start())
        if lb > b0 and is_closure_block(st, lb):
            continue  # `|x| { … return … }` returns from the closure
        reason = classify_guard(ctx)
        probe = ctx
        if "=>" in ctx:  # a match arm: the probe is in the match head
            head = st.rfind("match", b0, r.start())
            if head >= 0:
                probe = orig[head:st.find("{", head) + 1] + " " + ctx
        elif re.search(r"\belse\b", ctx):  # `let … = probe(…) else`: the whole `let`
            let_at = st.rfind("let ", b0, r.start())
            if let_at >= 0:
                probe = orig[let_at:r.start()]
        if reason and honest_guard(probe, file):
            reported.append(reason)
        elif reason:
            reasons.append(reason)
            msgs = msgs or bool(SKIP_WORDS.search(ctx))
    # `match device() { Some(d) => …, None => eprintln!("SKIP …") }`: an arm that
    # neither fails nor asserts.
    for arm in SILENT_ARM.finditer(st, b0, b1):
        head = st.rfind("match", b0, arm.start())
        if head < 0:
            continue
        arm_end = st.find("\n", arm.end())
        arm_text = orig[arm.start():arm_end]
        if re.search(r"panic!|assert|unreachable!|\.expect\(|\.unwrap\(|todo!", arm_text):
            continue
        ctx = orig[head:st.find("{", head) + 1] + " " + arm_text
        reason = classify_guard(ctx)
        if reason and honest_guard(ctx, file):
            reported.append(reason)
        elif reason:
            reasons.append(reason)
            msgs = msgs or bool(SKIP_WORDS.search(ctx))
    # `if let Some(dev) = device() { …the whole test… }` with no else.
    if not reasons:
        if_let = re.search(r"\bif\s+let\s+Some\s*\([^)]*\)\s*=\s*([^{;]+)\{", st[b0:b1])
        if if_let:
            open_at = b0 + if_let.end() - 1
            close = match_brace(st, open_at)
            covers = (close - open_at) / max(1, b1 - b0)
            tail = st[close:b1].lstrip()
            cond = orig[b0 + if_let.start(1):b0 + if_let.end(1)]
            reason = classify_guard(cond)
            if reason and covers > 0.5 and not tail.startswith("else"):
                (reported if honest_guard(cond, file) else reasons).append(reason)
    return sorted(set(reasons)), msgs


def crate_of(path):
    return path.split("/src/")[0].split("/tests/")[0].split("/benches/")[0]


def honest_functions(root, files):
    """The functions that report a skip through paged-test-resources, directly or
    through another such function (a few rounds). Returns (names whose every
    definition reports, the (file, name) pairs of the other reporting ones)."""
    bodies = {}
    for f in files:
        if not f.endswith(".rs") or "/target/" in f or f.startswith("tooling/"):
            continue
        try:
            orig = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        st = strip_code(orig, "rust")
        for m in RUST_FN.finditer(st):
            brace = st.find("{", m.end())
            semi = st.find(";", m.end())
            if brace < 0 or (0 <= semi < brace):
                continue
            body = orig[brace:match_brace(st, brace)]
            bodies.setdefault(m.group(1), []).append((f, body))
    honest = {(f, n) for n, defs in bodies.items() for f, b in defs if HONEST.search(b)}

    def everywhere(n):
        return all((f, n) in honest for f, _ in bodies[n])

    for _ in range(4):
        names = {n for n in bodies if everywhere(n)}
        grown = {(f, n) for n, defs in bodies.items() for f, b in defs if (f, n) not in honest
                 and any(c in names or (f, c) in honest for c in CALLED.findall(b))}
        if not grown:
            break
        honest |= grown
    names = {n for n in bodies if everywhere(n)}
    return names, {(f, n) for f, n in honest if n not in names}


def rust_scan(root, files):
    """Every Rust test function (macro-generated ones counted per invocation), its
    `#[ignore]`, and whether it passes silently when a resource is missing."""
    names, local = honest_functions(root, files)
    HONEST_FNS.clear()
    HONEST_FNS.update(names)
    HONEST_LOCAL.clear()
    HONEST_LOCAL.update(local)
    tests, helpers = [], {}
    for f in files:
        if not f.endswith(".rs") or "/target/" in f or f.startswith("tooling/"):
            continue
        try:
            orig = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if "#[test" not in orig and "#[wasm_bindgen_test" not in orig and "#[rstest" not in orig \
                and "/tests/" not in f and "test_support" not in f:
            continue
        st = strip_code(orig, "rust")
        macros = []
        for m in MACRO_RULES.finditer(st):
            open_at = m.end() - 1
            macros.append((m.group(1), open_at, match_brace(st, open_at)))
        fns = []
        for m in RUST_FN.finditer(st):
            brace = st.find("{", m.end())
            semi = st.find(";", m.end())
            if brace < 0 or (0 <= semi < brace):
                continue
            pre_start = max(0, m.start() - 600)
            pre = st[pre_start:m.start()]
            cut = max(pre.rfind("}"), pre.rfind(";"), pre.rfind("{"))
            attr_text = orig[pre_start + cut + 1:m.start()]
            fns.append(dict(name=m.group(1), start=m.start(), body=(brace, match_brace(st, brace)),
                            sig=st[m.end():brace], attrs=attr_text,
                            test=bool(RUST_TEST_ATTR.search(attr_text))))
        for fn in fns:
            b0, b1 = fn["body"]
            nested = [o["body"] for o in fns if o is not fn and b0 < o["start"] < b1]
            reported = []
            reasons, msgs = rust_body_reasons(orig, st, b0, b1, nested, reported, f)
            entry = dict(file=f, name=fn["name"], line=orig.count("\n", 0, fn["start"]) + 1,
                         reasons=reasons, message=msgs, reported=sorted(set(reported)),
                         calls=set(re.findall(r"(?<![.\w])([a-z_][a-z0-9_]*)\s*\(", st[b0:b1])))
            if fn["test"]:
                ig = RUST_IGNORE.search(fn["attrs"])
                entry["ignored"] = bool(ig)
                entry["ignore_reason"] = (ig.group(1) if ig and ig.group(1) else
                                          ("cfg_attr" if ig and "cfg_attr" in ig.group(0) else None))
                tests.append(entry)
            elif reasons and "->" not in fn["sig"] and (
                    "/tests/" in f or "test_support" in f
                    or 0 <= orig.find("#[cfg(test)]") < fn["start"]):
                # a () helper that returns early: a test that calls it passes untested.
                # Callable from its own file, or crate-wide from a shared support module.
                shared = re.search(r"/tests/(common|support|util)|test_support|/testing/", f)
                helpers.setdefault((crate_of(f) if shared else f, fn["name"]), entry)
        # tests generated by a macro_rules! that holds a #[test]: one per invocation
        for name, m0, m1 in macros:
            body = st[m0:m1]
            t_at = RUST_TEST_ATTR.search(body)
            if not t_at:
                continue
            fb = body.find("{", body.find("fn ", t_at.end()))
            reported = []
            reasons, msgs = (rust_body_reasons(orig, st, m0 + fb, match_brace(st, m0 + fb), [],
                                               reported, f)
                             if fb > 0 else ([], False))
            ig = RUST_IGNORE.search(body[:fb if fb > 0 else len(body)])
            for inv in re.finditer(r"\b" + re.escape(name) + r"!\s*[({\[]\s*([A-Za-z_][A-Za-z0-9_]*)?", st):
                if any(a0 <= inv.start() < a1 for _, a0, a1 in macros):
                    continue
                tests.append(dict(file=f, name=inv.group(1) or f"{name}!", macro=name,
                                  line=orig.count("\n", 0, inv.start()) + 1, reasons=reasons,
                                  message=msgs, reported=sorted(set(reported)), calls=set(),
                                  ignored=bool(ig),
                                  ignore_reason=ig.group(1) if ig and ig.group(1) else None))
    # one level of helper indirection (same crate)
    for t in tests:
        if t["reasons"]:
            continue
        via = [helpers[k] for c in t["calls"]
               for k in ((t["file"], c), (crate_of(t["file"]), c)) if k in helpers]
        if via:
            t["reasons"] = sorted({r for h in via for r in h["reasons"]})
            t["via_helper"] = sorted(h["name"] for h in via)
            t["message"] = any(h["message"] for h in via)
    for t in tests:
        t.pop("calls", None)
    return tests


TS_TEST = re.compile(r"(?<![\w.$])(it|test)(\.(?:each\s*\([^)]*\)\s*|concurrent|only|sequential|fails))*\s*\(")
TS_SKIPPING = re.compile(r"(?<![\w$])(?:it|test|describe)\s*\.\s*(skip|todo|fixme|skipIf|runIf)\b|"
                         r"(?<![\w$])(?:ctx|t|context|task)\s*\.\s*skip\s*\(|"
                         r"(?<![\w$])test\s*\.\s*skip\s*\(\s*(?!['\"`])")
TS_EXT = re.compile(r"\.(ts|tsx|mts|mjs|js|cjs)$")
TESTISH = re.compile(r"(/test/|/tests/|/__tests__/|\.spec\.|\.test\.|/e2e/)")


def ts_scan(root, files):
    tests, conditional = [], []
    for f in files:
        if not TS_EXT.search(f) or not TESTISH.search(f) or "node_modules" in f:
            continue
        if not re.search(r"\.(spec|test)\.[cm]?[jt]sx?$", f):
            continue
        try:
            orig = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        st = strip_code(orig, "ts")
        for m in TS_SKIPPING.finditer(st):
            conditional.append(dict(file=f, line=orig.count("\n", 0, m.start()) + 1,
                                    kind=re.sub(r"\s", "", m.group(0)).rstrip("(")))
        for m in TS_TEST.finditer(st):
            # the callback body: the first `{` after `=>` or `function (...)`
            seg = st[m.end():m.end() + 2000]
            cb = re.search(r"=>\s*\{|function\s*\*?\s*\w*\s*\([^)]*\)\s*\{", seg)
            if not cb:
                continue
            b0 = m.end() + cb.end() - 1
            b1 = match_brace(st, b0)
            reasons, msgs = [], False
            for r in re.finditer(r"\breturn\b(?=\s*(;|\}|\n|$|undefined|void))", st[b0:b1]):
                at = b0 + r.start()
                # only returns of the callback itself (no nested function/arrow between)
                lb = st.rfind("{", b0, at)
                inner = st[b0:at]
                depth = inner.count("{") - inner.count("}")
                ctx, guarded = guard_context(orig, st, at, b0)
                if not guarded or ctx is None:
                    continue
                if re.search(r"\.(skip|fixme)\s*\(", ctx):
                    continue  # reported as skipped: honest
                if depth > 2 or re.search(r"=>\s*\{\s*$|function[^{]*\{\s*$", st[max(b0, lb - 60):lb + 1]):
                    continue
                reason = classify_guard(ctx)
                if reason:
                    reasons.append(reason)
                    msgs = msgs or bool(SKIP_WORDS.search(ctx))
            if reasons:
                title = re.match(r"\s*([\"'`])(.*?)\1", orig[m.end():m.end() + 400], re.S)
                tests.append(dict(file=f, line=orig.count("\n", 0, m.start()) + 1,
                                  title=title.group(2)[:120] if title else None,
                                  reasons=sorted(set(reasons)), message=msgs))
    return tests, conditional


ENV_RX = [
    re.compile(r"(?:env::var(?:_os)?|option_env!|env!)\s*\(\s*\"([A-Z][A-Z0-9_]+)\""),
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]+)"),
    re.compile(r"process\.env\[\s*[\"']([A-Z][A-Z0-9_]+)[\"']\s*\]"),
    re.compile(r"import\.meta\.env\.([A-Z][A-Z0-9_]+)"),
    # names passed to a helper (`corpus_gate("PAGED_PSD_CORPUS")`, `env("REQUIRE_…")`)
    re.compile(r"[\"'`]((?:PAGED|REQUIRE)_[A-Z0-9_]+)[\"'`]"),
]
ENV_IGNORE = re.compile(r"^(CI|HOME|PATH|TMPDIR|USER|NODE_ENV|CARGO_[A-Z_]+|RUST_[A-Z_]+|GITHUB_[A-Z_]+|"
                        r"OUT_DIR|PWD|LANG|TERM|DEBUG|VITEST.*|PLAYWRIGHT.*|DEV|PROD|MODE|SSR|BASE_URL)$")


# ---------------------------------------------------------------- 5. fakes and boot helpers

FAKE_NAME = r"[A-Za-z0-9_$]*(?:[Ff]ake|[Mm]ock|[Ss]tub)[A-Za-z0-9_$]*"
HOSTISH_NAME = r"[A-Za-z0-9_$]*(?:Host|Editor|Shell)[A-Za-z0-9_$]*"
DEF_RX = [
    r"^[ \t]*(?:export\s+)?(?:async\s+)?function\*?\s+(NAME)\s*[<(]",
    r"^[ \t]*(?:export\s+)?(?:const|let)\s+(NAME)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*(?::[^=\n]+)?=>",
    r"^[ \t]*(?:export\s+)?(?:const|let)\s+(NAME)\s*(?::[^=\n]+)?=\s*(?:async\s+)?function",
    r"^[ \t]*(?:export\s+)?(?:const|let)\s+(NAME)\s*(?::[^=\n]+)?=\s*\{\s*$",
    r"^[ \t]*(?:export\s+)?class\s+(NAME)\b",
]
FAKE_DEFS = [re.compile(r.replace("NAME", FAKE_NAME), re.M) for r in DEF_RX]
HOST_DEFS = [re.compile(r.replace("NAME", HOSTISH_NAME), re.M) for r in DEF_RX]
MAPBACKING_DEF = re.compile(r"^[ \t]*(?:export\s+)?(?:const|let|function)\s+mapBacking\b", re.M)
CORE_BOOT = re.compile(r"\bcreateHeadlessHost\s*\(|\bloadHeadlessEngine\s*\(")
WASM_BOOT = re.compile(r"\binitSync\s*\(|\bawait\s+init\s*\(|readFileSync\([^)]*\.wasm|"
                       r"WebAssembly\.(?:instantiate|compile)\s*\(")
FAKE_KIND = [
    ("host / editor / shell", re.compile(r"Host|Editor|Shell|Session|Client|Keybinding|Canvas|Bus|Context", re.I)),
    ("engine / wasm / worker", re.compile(r"Engine|Wasm|Worker|Backend|Decoder|Channel|Chart", re.I)),
    ("registry / store", re.compile(r"Registry|Store|Storage|Secret|Swatch", re.I)),
    ("document / model", re.compile(r"Doc|Document|Objects|Table|Textarea|Model", re.I)),
]


def match_paren(s, i):
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "(":
            depth += 1
        elif s[j] == ")":
            depth -= 1
            if depth == 0:
                return j + 1
    return len(s)


def ts_body(st, at):
    """(start, end) of the function or object body that a definition starting at
    `at` introduces: params are skipped as a balanced group, then `=> {`, `{` or
    an expression-bodied arrow up to the end of the statement."""
    m = re.compile(r"[=(<{]").search(st, at)
    if not m:
        return None
    i = m.start()
    if st[i] == "<":  # generics
        close = st.find(">", i)
        i = st.find("(", close)
    elif st[i] == "=":
        j = i + 1
        while j < len(st) and st[j].isspace():
            j += 1
        if st.startswith("async", j):
            j += 5
            while j < len(st) and st[j].isspace():
                j += 1
        if st[j:j + 1] == "{":
            return j, match_brace(st, j)
        if st.startswith("function", j):
            j = st.find("(", j)
        i = j
    if i < 0 or st[i:i + 1] != "(":
        if st[i:i + 1] == "{":
            return i, match_brace(st, i)
        return None
    after = match_paren(st, i)
    k = after
    rest = re.compile(r"\s*(?::\s*[^={;]+?)?\s*(=>\s*)?(\{|\()").match(st, k)
    if not rest:
        return None
    b = rest.end() - 1
    if st[b] == "{":
        return b, match_brace(st, b)
    return b, match_paren(st, b)


def fake_kind(name):
    for label, rx in FAKE_KIND:
        if rx.search(name):
            return label
    return "other"


def ts_test_files(files):
    return [f for f in files if TS_EXT.search(f) and TESTISH.search(f) and "node_modules" not in f]


def fakes_scan(root, files):
    defs, mapb, boots, helpers = [], [], [], []
    test_files = ts_test_files(files)
    texts = {}
    for f in test_files:
        try:
            texts[f] = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    # boot helpers first: functions in test code whose body boots an engine
    helper_names = collections.defaultdict(set)
    for f, src in texts.items():
        st = strip_code(src, "ts")
        for rx_list, kind in ((FAKE_DEFS, "fake"), (HOST_DEFS, "host")):
            for rx in rx_list:
                for m in rx.finditer(st):
                    rng = ts_body(st, m.end(1))
                    body = st[rng[0]:rng[1]] if rng else ""
                    delegates = bool(CORE_BOOT.search(body))
                    defs.append(dict(file=f, line=src.count("\n", 0, m.start()) + 1,
                                     name=m.group(1), via=kind, lines=body.count("\n") + 1,
                                     delegates_to_shared_harness=delegates))
        for m in MAPBACKING_DEF.finditer(st):
            mapb.append(dict(file=f, line=src.count("\n", 0, m.start()) + 1))
        for m in re.finditer(r"^[ \t]*(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*(?=[<(])|"
                             r"^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?=(?::[^=\n]+)?=\s*(?:async\s*)?\()",
                             st, re.M):
            rng = ts_body(st, m.end())
            if not rng:
                continue
            body = st[rng[0]:rng[1]]
            name = m.group(1) or m.group(2)
            if CORE_BOOT.search(body) or WASM_BOOT.search(body):
                kind = "core engine" if CORE_BOOT.search(body) else "module wasm"
                helpers.append(dict(file=f, name=name, kind=kind,
                                    exported="export" in st[m.start():m.start() + 20]))
                helper_names[name].add(kind)
    # de-duplicate definitions matched by both lists
    seen, uniq = set(), []
    for d in defs:
        k = (d["file"], d["line"])
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    defs = uniq
    for d in defs:
        d["kind"] = fake_kind(d["name"])
    # files that boot an engine, and where: once per file (beforeAll / module scope) or
    # per test (inside it/test/beforeEach)
    call_rx = {name: re.compile(r"(?<![\w$.])" + re.escape(name) + r"\s*\(") for name in helper_names}
    for f, src in texts.items():
        if not re.search(r"\.(spec|test)\.[cm]?[jt]sx?$", f):
            continue
        st = strip_code(src, "ts")
        sites = [(m.start(), "core engine") for m in CORE_BOOT.finditer(st)]
        sites += [(m.start(), "module wasm") for m in WASM_BOOT.finditer(st)]
        for name, rx in call_rx.items():
            if any(h["file"] == f and h["name"] == name for h in helpers):
                continue  # the definition itself
            for m in rx.finditer(st):
                sites.append((m.start(), sorted(helper_names[name])[0]))
        if not sites:
            continue
        hooks = [(m.start(), m.group(1)) for m in
                 re.finditer(r"\b(beforeAll|beforeEach|it|test|before|after|afterAll|afterEach)\s*(?:\.\w+\s*)?\(", st)]
        per = collections.Counter()
        kinds = set()
        for at, kind in sites:
            kinds.add(kind)
            enclosing = None
            for h_at, h in hooks:
                if h_at < at:
                    brace = st.find("{", h_at)
                    if 0 <= brace < at and match_brace(st, brace) > at:
                        enclosing = h
            per["per test" if enclosing in ("it", "test", "beforeEach") else "once per file"] += 1
        boots.append(dict(file=f, kinds=sorted(kinds), sites=len(sites), **dict(per)))
    return dict(definitions=defs, map_backing=mapb, boot_files=boots, boot_helpers=helpers)


def env_scan(root, files):
    """Environment switches that test code reads, with the test files that read them."""
    uses = collections.defaultdict(set)
    for f in files:
        if not (f.endswith(".rs") or TS_EXT.search(f)) or "node_modules" in f:
            continue
        rust_test = f.endswith(".rs") and ("/tests/" in f or "test_support" in f)
        if not (TESTISH.search(f) or rust_test or "/test-support/" in f):
            if not f.endswith(".rs"):
                continue
        try:
            src = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if f.endswith(".rs") and not rust_test and "#[cfg(test)]" not in src:
            continue
        for rx in ENV_RX:
            for m in rx.finditer(src):
                if not ENV_IGNORE.match(m.group(1)):
                    uses[m.group(1)].add(f)
    return {k: sorted(v) for k, v in sorted(uses.items())}


def ignored_from_lists(lists_dir):
    """`cargo nextest list --run-ignored all` dumps (test-ids.py dump): ignored per crate."""
    out = {}
    if not lists_dir or not os.path.isdir(lists_dir):
        return out
    for fn in sorted(os.listdir(lists_dir)):
        if not (fn.startswith("before-") and fn.endswith(".json")):
            continue
        ws = fn[len("before-"):-len(".json")]
        tests = load_json(os.path.join(lists_dir, fn))
        per = collections.Counter(t["binary_id"].split("::")[0] for t in tests if t["ignored"])
        out[ws] = dict(tests=len(tests), ignored=sum(per.values()),
                       binaries=len({t["binary_id"] for t in tests}), ignored_by_crate=dict(per),
                       ignored_ids=sorted(f"{t['binary_id']} {t['name']}" for t in tests
                                          if t["ignored"]))
    return out


# ---------------------------------------------------------------- 4. flakes

NX_FAIL = re.compile(r"^\s*(?:TRY \d+ )?(FAIL|TIMEOUT|SIGSEGV|SIGABRT|SIGKILL|ABORT)\s+\[\s*[\d.]+s\]\s+"
                     r"(?:\(\s*\d+/\d+\)\s+)?(\S+)\s+(\S+)")
NX_FLAKY = re.compile(r"^\s*FLAKY\s+\d+/\d+\s+\[\s*[\d.]+s\]\s+(?:\(\s*\d+/\d+\)\s+)?(\S+)\s+(\S+)")
CARGO_FAIL = re.compile(r"^test (\S+) \.\.\. FAILED\s*$")
VITEST_FAIL = re.compile(r"^\s*FAIL\s+(\S+\.(?:[cm]?[jt]sx?))\s+>\s+(.+?)\s*$")
PW_HEAD = re.compile(r"^\s+(\d+) (failed|flaky)\s*$")
PW_ITEM = re.compile(r"^\s+\[([^\]]+)\] › (\S+?):\d+:\d+ › (.+?)\s*$")
NODE_FAIL = re.compile(r"^not ok \d+ - (.+)$")


def log_failures(text):
    """Failed (and retried-then-passed) tests named in one job log."""
    failed, flaky = set(), set()
    lines = pc.clean_lines(text)
    section = None
    for ln in lines:
        m = NX_FAIL.match(ln)
        if m:
            failed.add(f"{m[2]} {m[3]}")
            continue
        m = NX_FLAKY.match(ln)
        if m:
            flaky.add(f"{m[1]} {m[2]}")
            continue
        m = CARGO_FAIL.match(ln)
        if m:
            failed.add(m[1])
            continue
        m = VITEST_FAIL.match(ln)
        if m:
            failed.add(f"{m[1]} > {m[2]}")
            continue
        m = NODE_FAIL.match(ln)
        if m:
            failed.add(m[1])
            continue
        m = PW_HEAD.match(ln)
        if m:
            section = m[2]
            continue
        if section:
            m = PW_ITEM.match(ln)
            if m:
                (failed if section == "failed" else flaky).add(f"{m[2]} › {m[3]} [{m[1]}]")
                continue
            if ln.strip() and not ln.startswith("    "):
                section = None
    return sorted(failed), sorted(flaky)


def load_hist_runs(cache, repo, wf, n):
    p = os.path.join(cache.root, "api", f"hist-{repo.replace('/', '_')}-{wf}-runs{n}.json")
    return load_json(p) if os.path.exists(p) else []


def load_hist_jobs(cache, repo, run_id):
    p = os.path.join(cache.root, "api", f"hist-{repo.replace('/', '_')}-jobsall-{run_id}.json")
    return load_json(p) if os.path.exists(p) else None


def flakes_section(cache, n):
    rows = []
    known = []
    for comp, old_repo, old_file, new_file in HISTORY:
        for side, repo, wf in (("old", old_repo, old_file), ("new", NEW_REPO, new_file)):
            if not repo:
                continue
            runs = [r for r in load_hist_runs(cache, repo, wf, n) if r["status"] == "completed"]
            if not runs:
                rows.append(dict(component=comp, side=side, repo=repo, workflow=wf, runs=0))
                continue
            concl = collections.Counter(r["conclusion"] for r in runs)
            decided = concl["success"] + concl["failure"]
            job_runs = collections.Counter()
            job_fail = collections.Counter()
            fail_bucket = collections.Counter()
            failing_tests = collections.Counter()
            rerun_flakes, flips, pw_flaky_runs, pw_flaky_tests = [], [], 0, collections.Counter()
            by_sha = collections.defaultdict(lambda: collections.defaultdict(set))
            for r in runs:
                jobs = load_hist_jobs(cache, repo, r["id"])
                if jobs is None:
                    continue
                attempts = collections.defaultdict(list)
                run_flaky = False
                for j in jobs:
                    if j.get("conclusion") in ("skipped", "cancelled", None):
                        continue
                    name = j["name"]
                    attempts[name].append((j.get("run_attempt", 1), j["conclusion"]))
                    log = os.path.join(cache.root, "logs", f"{repo.replace('/', '_')}-{j['id']}.log")
                    if j["conclusion"] == "failure":
                        fail_bucket[failure_kind(failed_step(j))] += 1
                    if os.path.exists(log):
                        with open(log, "rb") as fh:
                            failed, flaky = log_failures(fh.read().decode("utf-8", "replace"))
                        if j["conclusion"] == "failure":
                            failing_tests.update(failed)
                        if flaky:
                            run_flaky = True
                            pw_flaky_tests.update(flaky)
                for name, att in attempts.items():
                    att.sort()
                    last = att[-1][1]
                    job_runs[name] += 1
                    if last == "failure":
                        job_fail[name] += 1
                    by_sha[r["head_sha"]][name].add(last)
                    if any(c == "failure" for _, c in att[:-1]) and last == "success":
                        rerun_flakes.append(dict(run=r["id"], job=name, sha=r["head_sha"][:7],
                                                 url=r["html_url"]))
                pw_flaky_runs += run_flaky
            for sha, jobs in by_sha.items():
                for name, cs in jobs.items():
                    if {"success", "failure"} <= cs:
                        flips.append(dict(sha=sha[:7], job=name))
            rows.append(dict(
                component=comp, side=side, repo=repo, workflow=wf, runs=len(runs),
                first=min(r["created_at"] for r in runs), last=max(r["created_at"] for r in runs),
                conclusions=dict(concl), failure_rate=round(concl["failure"] / decided, 3) if decided else None,
                reruns=sum(1 for r in runs if r.get("run_attempt", 1) > 1),
                rerun_flakes=rerun_flakes, same_sha_flips=flips,
                playwright_flaky_runs=pw_flaky_runs,
                playwright_flaky_tests=dict(pw_flaky_tests.most_common(20)),
                failed_step_buckets=dict(fail_bucket),
                job_failure=[dict(job=k, runs=job_runs[k], failed=job_fail[k])
                             for k in sorted(job_runs) if job_fail[k]],
                failing_tests=dict(failing_tests.most_common(15))))
            for fl in rerun_flakes:
                known.append(dict(fl, workflow=wf, repo=repo))
    return rows, known


# ---------------------------------------------------------------- 6. Cockpit mapping

def cockpit_sources(config_path):
    """Which Cockpit evidence source reads which CI artifact, from the Cockpit config:
    {(repo, workflow, artifact): source id}, and the per-package splits
    {source id: {package: split source id}}."""
    import tomllib
    with open(config_path, "rb") as fh:
        cfg = tomllib.load(fh)
    by_artifact, splits = {}, {}
    for ev in cfg.get("evidence", []):
        gh = ev.get("github") or {}
        if gh.get("repo") and gh.get("workflow") and gh.get("artifact"):
            by_artifact.setdefault((gh["repo"], gh["workflow"], gh["artifact"]), ev["id"])
        for sp in ev.get("split", []):
            for pkg in sp.get("packages", []):
                splits.setdefault(ev["id"], {})[pkg] = sp["id"]
    return by_artifact, splits


def suite_source(label, suites, by_artifact):
    """The Cockpit source of a suite: the source that reads the same artifact of the
    same workflow in the old repository (Cockpit has not been pointed at the monorepo)."""
    s = suites[label]
    wf = next(w for w in pc.WORKFLOWS if w["new_file"] == s["workflow"])
    return by_artifact.get((wf["old_repo"], wf["old_file"], s["artifact"]))


TAG_RE = re.compile(r"@?feat:([A-Za-z0-9][A-Za-z0-9._-]*)")
SUFFIX_RE = re.compile(r"__feat__([a-z0-9_]+)")
BRACKET_RE = re.compile(r"\[([A-Za-z][A-Za-z0-9._-]{1,63})\]")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_test_map(path, tim):
    lines = open(path, encoding="utf-8").read().splitlines()
    entries = []
    for i, line in enumerate(lines):
        m = tim.MATCH_LINE.match(line)
        if not m:
            continue
        fields = {f.group("key"): f.group("val") for f in tim.FIELD.finditer(m.group("body"))}
        feats = []
        for j in range(i + 1, min(i + 8, len(lines))):
            if tim.MATCH_LINE.match(lines[j]):
                break
            fm = re.match(r"\s+features:\s*\[(.*)\]", lines[j])
            if fm:
                feats = [x.strip().strip("'\"") for x in fm.group(1).split(",") if x.strip()]
                break
        entries.append((fields, feats))
    return entries


def feature_ids(features_dir):
    ids = set()
    if not features_dir or not os.path.isdir(features_dir):
        return ids
    for d, _, fs in os.walk(features_dir):
        for f in fs:
            if f.endswith(".md") and not f.startswith("_"):
                with open(os.path.join(d, f), encoding="utf-8", errors="replace") as fh:
                    head = fh.read(2000)
                m = re.search(r"^id:\s*(\S+)", head, re.M)
                ids.add(m.group(1) if m else f[:-3])
    return ids


def declared_refs(t, ids):
    """Tier 1: feature ids the test carries itself (`@feat:`, `__feat__`, `[id]`)."""
    flat = collections.defaultdict(list)
    for i in ids:
        flat[i.lower().replace(".", "_").replace("-", "_")].append(i)
    text = " ".join([t["name"], t.get("classname") or ""] + list(t.get("tags") or []))
    if t.get("kind") == "playwright":
        raws = [x[len("feat:"):] for x in (t.get("tags") or []) if x.startswith("feat:")]
        raws += [tok[len("@feat:"):] for tok in t["name"].split() if tok.startswith("@feat:")]
        return {r for r in raws if r in ids}
    got = {c for c in TAG_RE.findall(text) if c in ids}
    got |= {flat[c][0] for c in SUFFIX_RE.findall(text) if len(flat.get(c, [])) == 1}
    got |= {c for c in BRACKET_RE.findall(text)
            if c in ids and not c.upper().startswith("ADR") and re.search(r"[-.]", c)}
    return got


def entry_matches(tim, fields, t):
    s = fields.get("source")
    if s and s != t["source_id"] and s != t["suite_name"] and not t["source_id"].startswith(s + "/"):
        return False
    s = fields.get("suite")
    if s and s != t["suite_name"] and not t["source_id"].endswith("/" + s) and t["source_id"] != s:
        return False
    rest = {k: v for k, v in fields.items() if k not in ("source", "suite")}
    if not rest:
        return bool(fields)
    return tim.matches(rest, {"binary_id": t["classname"], "name": t["name"]}, t["source_path"])


def mapping_tests(suites, pkg_dirs, by_artifact, splits):
    """The tests Cockpit would ingest from each suite, in Cockpit's shape."""
    out = {}
    for label, s in suites.items():
        src = suite_source(label, suites, by_artifact)
        rows = []
        for t in s["tests"]:
            if s["kind"] == "playwright":
                rows.append(dict(kind="playwright", classname=t["file"],
                                 name=f"{t['title']} [{t['project']}]", tags=t["tags"],
                                 source_path=f"apps/editor/apps/canvas/tests/{t['file']}",
                                 id=tid("playwright", t)))
                continue
            cls = t["classname"]
            if s["kind"] == "nextest":
                pkg, _, binary = cls.partition("::")
                d = pkg_dirs.get(pkg, pkg)
                spath = f"{d}/tests/{binary}.rs" if binary else f"{d}/src"
            else:
                spath = f".cockpit/evidence/{(src or 'none').replace('/', '__')}/{cls}"
            rows.append(dict(kind=s["kind"], classname=cls, name=t["name"], tags=[],
                             source_path=spath, id=tid(s["kind"], t)))
        for r in rows:
            sid = src or ""
            pkg = r["classname"].split("::")[0]
            sid = splits.get(sid, {}).get(pkg, sid) if s["kind"] == "nextest" else sid
            r["source_id"], r["suite_name"] = sid, sid
        out[label] = dict(source=src, tests=rows, kind=s["kind"])
    return out


def mapping_section(suites, test_map, test_map_after, tim, report, features_dir, config):
    ids = feature_ids(features_dir)
    by_artifact, splits = cockpit_sources(config)
    entries = [(f, feats) for f, feats in parse_test_map(test_map, tim)
               if not ids or any(x in ids for x in feats)]
    merged, pkg_dirs = tim.load_report(report) if report else ({}, {})
    per = {}
    tests_by = mapping_tests(suites, pkg_dirs, by_artifact, splits)
    after_entries = ([(f, feats) for f, feats in parse_test_map(test_map_after, tim)
                      if not ids or any(x in ids for x in feats)] if test_map_after else None)
    for label, s in tests_by.items():
        explicit = mapped = 0
        unmapped = []
        after_mapped = 0
        for t in s["tests"]:
            tier1 = bool(ids) and bool(declared_refs(t, ids))
            tier2 = s["source"] is not None and any(entry_matches(tim, f, t) for f, _ in entries)
            if tier1:
                explicit += 1
            if s["source"] is None:
                unmapped.append(t)
                continue
            if tier1 or tier2:
                mapped += 1
            else:
                unmapped.append(t)
            if after_entries is not None and s["kind"] == "nextest":
                # the same test under the merged binary ids, against the rewritten map
                pkg, _, binary = t["classname"].partition("::")
                tt = tim.translate({"binary_id": t["classname"], "name": t["name"],
                                    "ignored": False}, merged)
                d = pkg_dirs.get(pkg, pkg)
                spath = (f"{d}/tests/it/main.rs" if tt["binary_id"].endswith("::it")
                         else t["source_path"])
                ta = dict(t, classname=tt["binary_id"], name=tt["name"], source_path=spath)
                if tier1 or any(entry_matches(tim, f, ta) for f, _ in after_entries):
                    after_mapped += 1
        by_file = collections.Counter(
            (t["classname"].split("::")[0] + ("::" + t["classname"].split("::")[1]
                                              if "::" in t["classname"] else ""))
            if s["kind"] == "nextest" else t["classname"] for t in unmapped)
        per[label] = dict(source=bool(s["source"]), tests=len(s["tests"]), explicit=explicit,
                          mapped=mapped, unmapped=len(unmapped),
                          after_mapped=after_mapped if (after_entries is not None and
                                                        s["kind"] == "nextest") else None,
                          unmapped_by_file=dict(by_file.most_common()),
                          unmapped_ids=sorted(t["id"] for t in unmapped) if len(unmapped) <= 40 else None)
    return per, len(entries)


def run_wall(jobs):
    """First job start → last job end of the latest attempt; and summed job minutes."""
    latest = max((j.get("run_attempt", 1) for j in jobs), default=1)
    js = [j for j in jobs if j.get("run_attempt", 1) == latest and j.get("started_at")
          and j.get("completed_at") and j.get("conclusion") not in ("skipped", None)]
    if not js:
        return None, None
    wall = pc.seconds(min(j["started_at"] for j in js), max(j["completed_at"] for j in js))
    total = sum(pc.seconds(j["started_at"], j["completed_at"]) or 0 for j in js)
    return wall, total


def wall_history(cache, n):
    """Median wall time per workflow over its successful runs in the history, and for
    the monorepo the per-commit critical path: the slowest test workflow of each
    pull-request head that ran green."""
    per_wf = []
    per_sha = collections.defaultdict(dict)
    for comp, old_repo, old_file, new_file in HISTORY:
        for side, repo, wf in (("old", old_repo, old_file), ("new", NEW_REPO, new_file)):
            if not repo:
                continue
            walls, totals = [], []
            for r in load_hist_runs(cache, repo, wf, n):
                if r["status"] != "completed" or r["conclusion"] != "success":
                    continue
                jobs = load_hist_jobs(cache, repo, r["id"])
                if not jobs:
                    continue
                w, t = run_wall(jobs)
                if w is None:
                    continue
                walls.append(w)
                totals.append(t)
                if side == "new" and r["event"] == "pull_request":
                    per_sha[r["head_sha"]][wf] = w
            if walls:
                per_wf.append(dict(component=comp, side=side, workflow=wf, green_runs=len(walls),
                                   median_wall=int(statistics.median(walls)),
                                   max_wall=max(walls),
                                   median_job_seconds=int(statistics.median(totals))))
    crit = [max(v.values()) for v in per_sha.values() if v]
    return per_wf, dict(pr_heads=len(crit),
                        median_slowest_green_workflow=int(statistics.median(crit)) if crit else None)


# ---------------------------------------------------------------- report

def ci_skips(cache, suites):
    """Why CI skips what it skips: Playwright annotations, and the vitest files whose
    skipped tests sit under a skip condition."""
    out = {}
    for label, s in suites.items():
        sk = [t for t in s["tests"] if t["status"] == "skipped"]
        if not sk:
            continue
        if s["kind"] == "playwright":
            c = collections.Counter((t["file"], (t.get("skip_reason") or "")[:140]) for t in sk)
        else:
            c = collections.Counter((t["classname"], t.get("skip_message") or "") for t in sk)
        out[label] = [dict(file=f, reason=r, tests=n) for (f, r), n in c.most_common()]
    return out


def counts_by(items, key):
    c = collections.Counter(key(i) for i in items)
    return dict(sorted(c.items()))


def report(args):
    cache = pc.Cache(args.cache)
    parity = load_json(os.path.join(ROOT, "docs/migration/parity-baseline.json"))
    files = git_files(ROOT)
    print("suites…", flush=True)
    rows, walls = suites_section(cache, parity)
    suites = suite_tests(cache)
    per_suite, slowest = durations_section(suites)
    print("source scan…", flush=True)
    rust = rust_scan(ROOT, files)
    ts_silent, ts_cond = ts_scan(ROOT, files)
    envs = env_scan(ROOT, files)
    rust_silent = [t for t in rust if t["reasons"] and not t["ignored"]]
    print("fakes…", flush=True)
    fakes = fakes_scan(ROOT, files)
    print("flakes…", flush=True)
    flakes, rerun_flakes = flakes_section(cache, args.runs)
    wf_walls, pr_wall = wall_history(cache, args.runs)
    mapping, entries = None, None
    if args.test_map and args.test_ids and args.cockpit_config:
        print("mapping…", flush=True)
        tim = load_module(args.test_ids, "test_ids")
        mapping, entries = mapping_section(suites, args.test_map, args.test_map_after, tim,
                                           args.merge_report, args.features, args.cockpit_config)
    hand = [d for d in fakes["definitions"] if not d["delegates_to_shared_harness"]]
    doc = dict(
        description=("Test inventory (wave T, step T0). Produced by "
                     "tooling/migration/test_inventory.py from the A5 parity baseline, cached "
                     "read-only GitHub Actions data (job/step times, JUnit and Playwright "
                     "artifacts, run history) and a scan of the source tree."),
        generated_at=dt_now(),
        history_runs_per_workflow=args.runs,
        history_snapshot=history_snapshot(cache),
        suites=dict(jobs=rows, workflow_wall=walls, history_wall=wf_walls, pr_wall=pr_wall),
        durations=dict(per_suite=per_suite, slowest_overall=slowest),
        skips=dict(
            ci_skipped=ci_skips(cache, suites),
            rust_tests_scanned=len(rust),
            rust_ignored=[dict(file=t["file"], name=t["name"], reason=t["ignore_reason"])
                          for t in rust if t["ignored"]],
            ignored_from_nextest_lists=ignored_from_lists(args.nextest_lists),
            silent_rust=dict(total=len(rust_silent),
                             with_skip_message=sum(1 for t in rust_silent if t["message"]),
                             by_module_reason=counts_by(rust_silent, lambda t: f"{module_of(t['file'])} | {t['reasons'][0]}"),
                             by_file=counts_by(rust_silent, lambda t: t["file"]),
                             tests=[dict(file=t["file"], name=t["name"], reasons=t["reasons"],
                                         via_helper=t.get("via_helper")) for t in rust_silent]),
            silent_ts=dict(total=len(ts_silent),
                           by_module_reason=counts_by(ts_silent, lambda t: f"{module_of(t['file'])} | {t['reasons'][0]}"),
                           tests=ts_silent),
            conditional_ts=counts_by(ts_cond, lambda t: f"{module_of(t['file'])} | {t['kind']}"),
            env_switches={k: dict(files=len(v), modules=sorted({module_of(f) for f in v}))
                          for k, v in envs.items()}),
        flakes=dict(workflows=flakes, rerun_flakes=rerun_flakes),
        fakes=dict(
            hand_rolled=len(hand), hand_rolled_files=len({d["file"] for d in hand}),
            by_kind=counts_by(hand, lambda d: d["kind"]),
            by_module=counts_by(hand, lambda d: module_of(d["file"])),
            by_module_kind=counts_by(hand, lambda d: f"{module_of(d['file'])} | {d['kind']}"),
            delegating_to_shared_harness=len(fakes["definitions"]) - len(hand),
            definitions=hand,
            map_backing=dict(copies=len(fakes["map_backing"]),
                             by_module=counts_by(fakes["map_backing"], lambda d: module_of(d["file"])),
                             files=sorted({d["file"] for d in fakes["map_backing"]})),
            engine_boot=dict(
                files=len(fakes["boot_files"]),
                core_engine_files=sum(1 for b in fakes["boot_files"] if "core engine" in b["kinds"]),
                module_wasm_files=sum(1 for b in fakes["boot_files"] if "module wasm" in b["kinds"]),
                files_booting_per_test=sum(1 for b in fakes["boot_files"] if b.get("per test")),
                per_test_sites=sum(b.get("per test", 0) for b in fakes["boot_files"]),
                once_per_file_sites=sum(b.get("once per file", 0) for b in fakes["boot_files"]),
                by_module=counts_by(fakes["boot_files"], lambda b: module_of(b["file"])),
                files_list=fakes["boot_files"]),
            boot_helpers=fakes["boot_helpers"]),
        cockpit=dict(entries_with_live_features=entries, per_suite=mapping),
    )
    with open(args.out, "w") as fh:
        json.dump(doc, fh, indent=1, sort_keys=False, default=sorted)
        fh.write("\n")
    print(f"wrote {args.out}", flush=True)


# ---------------------------------------------------------------- Markdown tables

def fmt_s(s):
    if s is None:
        return "—"
    s = int(round(s))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "—"


def short(text, n=110):
    text = re.sub(r"\s*@(feat|level):\S+", "", text).strip()
    text = text.replace("|", "\\|")
    return text if len(text) <= n else text[:n - 1] + "…"


def tables(doc):
    out = []
    w = out.append
    # 1. suites
    w("<!-- tables:suites -->")
    w("| Component | Workflow / job | Runner | Tests run / skipped | Job time old → new | "
      "Setup + cache | Build + test | Test runner reports | Report/upload |")
    w("|---|---|---|---|---|---|---|---|---|")
    for r in doc["suites"]["jobs"]:
        side = r["new"] if r.get("new") and r["new"].get("build_test") else r.get("old")
        cnt = []
        for fw, c in r["frameworks"].items():
            v = c.get("new") or c.get("old")
            cnt.append(f"{fw}: {v['run']} / {v['skipped']}")
        o, n = r.get("old") or {}, r.get("new") or {}
        n_run = n.get("run") if n and n.get("build_test") else None
        run = side.get("run") or 0
        tp = sum((side.get("test_phase") or {}).values())
        w(f"| {r['component']} | `{r['workflow']}` / {r['job']} | {r['runner']} | {'; '.join(cnt)} | "
          f"{fmt_s(o.get('run'))} → {fmt_s(n_run)} | "
          f"{fmt_s(side['setup'] + side['cache'])} ({pct(side['setup'] + side['cache'], run)}) | "
          f"{fmt_s(side['build_test'])} ({pct(side['build_test'], run)}) | {fmt_s(tp) if tp else '—'} | "
          f"{fmt_s(side['artifact_report'])} |")
    w("")
    w("<!-- tables:history-wall -->")
    w("| Component | Workflow | Old: green runs, median wall | New: green runs, median wall |")
    w("|---|---|---|---|")
    by = {}
    for e in doc["suites"]["history_wall"]:
        by.setdefault(e["component"] + "|" + (e["workflow"]), {})[e["side"]] = e
    pairs = []
    for comp, old_repo, old_file, new_file in HISTORY:
        o = by.get(f"{comp}|{old_file}", {}).get("old") if old_file else None
        n = by.get(f"{comp}|{new_file}", {}).get("new")
        if o or n:
            pairs.append((comp, new_file, o, n))
    for comp, wf, o, n in pairs:
        w(f"| {comp} | `{wf}` | {o['green_runs'] if o else 0}, {fmt_s(o['median_wall']) if o else '—'} | "
          f"{n['green_runs'] if n else 0}, {fmt_s(n['median_wall']) if n else '—'} |")
    w("")
    # 2. durations
    w("<!-- tables:durations -->")
    w("| Suite | Run | Tests (ran) | Sum of test times | Top 5 share | Tests holding 90% of the time | "
      "Vitest file time not in tests |")
    w("|---|---|---|---|---|---|---|")
    for label, s in sorted(doc["durations"]["per_suite"].items(), key=lambda kv: -kv[1]["sum_seconds"]):
        side = "monorepo" if s["repo"] == NEW_REPO else "old repo"
        ov = (f"{fmt_s(s['file_overhead_seconds'])} of {fmt_s(s['file_seconds'])}"
              if s.get("file_seconds") else "—")
        w(f"| {label} | {side} | {s['tests']} ({s['ran']}) | {fmt_s(s['sum_seconds'])} | "
          f"{pct(s['top5_share'] or 0, 1) if s['top5_share'] is not None else '—'} | "
          f"{s['tests_for_90pct']} of {s['ran']} | {ov} |")
    w("")
    w("<!-- tables:slowest30 -->")
    w("| # | Suite | Test | Time |")
    w("|---|---|---|---|")
    for i, t in enumerate(doc["durations"]["slowest_overall"], 1):
        w(f"| {i} | {t['suite']} | `{short(t['id'])}` | {fmt_s(t['seconds'])} |")
    w("")
    w("<!-- tables:slowest-per-suite -->")
    for label, s in sorted(doc["durations"]["per_suite"].items(), key=lambda kv: -kv[1]["sum_seconds"]):
        if not s["slowest"]:
            continue
        w(f"<details><summary>{label}: slowest 10 ({fmt_s(s['sum_seconds'])} summed)</summary>")
        w("")
        w("| Test | Time |")
        w("|---|---|")
        for t in s["slowest"]:
            w(f"| `{short(t['id'])}` | {t['seconds']:.2f}s |")
        if s.get("slowest_files"):
            w("")
            w("| Test file | File time | In tests | Outside tests |")
            w("|---|---|---|---|")
            for f in s["slowest_files"][:5]:
                w(f"| `{f['file']}` | {f['seconds']:.1f}s | {f['tests_seconds']:.1f}s | {f['overhead']:.1f}s |")
        w("")
        w("</details>")
        w("")
    # 3. skips
    sk = doc["skips"]
    w("<!-- tables:ci-skipped -->")
    w("| Suite | File | Skipped | Reason |")
    w("|---|---|---|---|")
    for label, items in sk["ci_skipped"].items():
        for it in items:
            w(f"| {label} | `{it['file']}` | {it['tests']} | {short(it['reason'] or '(condition in the file)', 120)} |")
    w("")
    w("<!-- tables:ignored -->")
    ig = collections.Counter((module_of(t["file"]), ignore_family(t["reason"])) for t in sk["rust_ignored"])
    w("| Module | `#[ignore]` reason | Tests |")
    w("|---|---|---|")
    for (m, r), n in sorted(ig.items()):
        w(f"| {m} | {r} | {n} |")
    w("")
    w("<!-- tables:silent -->")
    w("| Module | Missing resource | Tests that pass without running |")
    w("|---|---|---|")
    for k, v in sk["silent_rust"]["by_module_reason"].items():
        m, r = k.split(" | ")
        w(f"| {m} (Rust) | {r} | {v} |")
    for k, v in sk["silent_ts"]["by_module_reason"].items():
        m, r = k.split(" | ")
        w(f"| {m} (TS) | {r} | {v} |")
    w("")
    w("<!-- tables:conditional -->")
    w("| Module | Construct | Sites |")
    w("|---|---|---|")
    for k, v in sk["conditional_ts"].items():
        m, kind = k.split(" | ")
        w(f"| {m} | `{kind}` | {v} |")
    w("")
    w("<!-- tables:env -->")
    fam = collections.defaultdict(list)
    for k, v in sk["env_switches"].items():
        if re.match(r"^(PAGED_REQUIRE_|REQUIRE_)", k):
            fam["require"].append((k, v))
        elif re.match(r"^PAGED_\w*CORPUS", k):
            fam["corpus"].append((k, v))
        elif k.startswith("PAGED_"):
            fam["other"].append((k, v))
    w("| Family | Variables | Test files | Variables (test files) |")
    w("|---|---|---|---|")
    for key, label in (("corpus", "`PAGED_*CORPUS*` (corpus location / opt-in)"),
                       ("require", "`REQUIRE_*`, `PAGED_REQUIRE_*` (skip becomes failure)"),
                       ("other", "other `PAGED_*` (paths, lanes, oracles, records)")):
        items = sorted(fam[key], key=lambda kv: (-kv[1]["files"], kv[0]))
        w(f"| {label} | {len(items)} | {sum(v['files'] for _, v in items)} | "
          + ", ".join(f"`{k}` ({v['files']})" for k, v in items) + " |")
    w("")
    w("<!-- tables:silent-files -->")
    w("| Test file | Silent-skip tests |")
    w("|---|---|")
    files = sorted(sk["silent_rust"]["by_file"].items(), key=lambda kv: -kv[1])
    for f, n in files[:20]:
        w(f"| `{f}` | {n} |")
    rest = files[20:]
    if rest:
        w(f"| {len(rest)} more files | {sum(n for _, n in rest)} |")
    w("")
    w("<!-- tables:mapbacking -->")
    for f in fk_files(doc):
        w(f"- `{f}`")
    w("")
    # 4. flakes
    w("<!-- tables:flakes -->")
    w("| Component | Side | Workflow | Completed runs | Green / red / cancelled | Red rate | "
      "Red jobs by failing step | Confirmed flaky runs |")
    w("|---|---|---|---|---|---|---|---|")
    for r in doc["flakes"]["workflows"]:
        if not r["runs"]:
            w(f"| {r['component']} | {r['side']} | `{r['workflow']}` | 0 | — | — | — | — |")
            continue
        c = r["conclusions"]
        kinds = ", ".join(f"{k} {v}" for k, v in sorted(r["failed_step_buckets"].items(), key=lambda kv: -kv[1]))
        conf = len({f["run"] for f in r["rerun_flakes"]}) + r["playwright_flaky_runs"]
        rate = f"{100 * r['failure_rate']:.0f}%" if r["failure_rate"] is not None else "—"
        w(f"| {r['component']} | {r['side']} | `{r['workflow']}` | {r['runs']} | "
          f"{c.get('success', 0)} / {c.get('failure', 0)} / {c.get('cancelled', 0)} | {rate} | "
          f"{kinds or '—'} | {conf} |")
    w("")
    # 5. fakes
    fk = doc["fakes"]
    w("<!-- tables:fakes -->")
    kinds = sorted(fk["by_kind"])
    w("| Module | " + " | ".join(kinds) + " | Total | `mapBacking` copies | Files booting an engine "
      "(core / module wasm) | of which boot per test |")
    w("|---|" + "---|" * (len(kinds) + 4))
    mods = sorted(set(fk["by_module"]) | set(fk["map_backing"]["by_module"]) | set(fk["engine_boot"]["by_module"]))
    boots = collections.defaultdict(lambda: collections.Counter())
    for b in fk["engine_boot"]["files_list"]:
        m = module_of(b["file"])
        boots[m]["files"] += 1
        boots[m]["core"] += "core engine" in b["kinds"]
        boots[m]["module"] += "module wasm" in b["kinds"]
        boots[m]["per_test"] += bool(b.get("per test"))
    for m in mods:
        row = [str(fk["by_module_kind"].get(f"{m} | {k}", 0)) for k in kinds]
        b = boots[m]
        w(f"| {m} | " + " | ".join(row) + f" | {fk['by_module'].get(m, 0)} | "
          f"{fk['map_backing']['by_module'].get(m, 0)} | {b['files']} ({b['core']} / {b['module']}) | {b['per_test']} |")
    w("")
    # 6. mapping
    if doc["cockpit"]["per_suite"]:
        w("<!-- tables:cockpit -->")
        w("| Suite | Tests | Mapped | of which by an explicit tag | Unmapped | Unmapped share | "
          "Mapped after the binary merge |")
        w("|---|---|---|---|---|---|---|")
        for label, s in doc["cockpit"]["per_suite"].items():
            w(f"| {label} | {s['tests']} | {s['mapped']} | {s['explicit']} | {s['unmapped']} | "
              f"{pct(s['unmapped'], s['tests'])} | {s['after_mapped'] if s['after_mapped'] is not None else '—'} |")
        w("")
        w("<!-- tables:cockpit-unmapped -->")
        w("| Suite | Unmapped tests by test file or binary (up to 12) |")
        w("|---|---|")
        for label, s in doc["cockpit"]["per_suite"].items():
            if not s["unmapped"]:
                continue
            items = list(s["unmapped_by_file"].items())
            shown = ", ".join(f"`{f}` {n}" for f, n in items[:12])
            more = f", {len(items) - 12} more" if len(items) > 12 else ""
            w(f"| {label} ({s['unmapped']}) | {shown}{more} |")
        w("")
    return "\n".join(out) + "\n"


def fk_files(doc):
    return doc["fakes"]["map_backing"]["files"]


def ignore_family(reason):
    if not reason:
        return "no reason given"
    r = reason.lower()
    if "corpus" in r or "oracle" in r:
        return "opt-in corpus / oracle lane (`PAGED_*` + a corpus mount)"
    if "indesign" in r or "lane" in r:
        return "writes inputs for an external lane"
    if "font" in r:
        return "needs source fonts"
    if "plugin-publish" in r or "does not" in r:
        return "known gap, kept as a pending assertion"
    return "other"


def dt_now():
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def history_snapshot(cache):
    """When the run lists were last read (newest runs-list file in the cache)."""
    import datetime as dt
    d = os.path.join(cache.root, "api")
    ts = [os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
          if f.startswith("hist-") and "-runs" in f] if os.path.isdir(d) else []
    return (dt.datetime.fromtimestamp(max(ts), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if ts else None)


def skips(args):
    """The source scan alone: silent skips, reported skips and ignores (T3)."""
    files = git_files(ROOT)
    rust = rust_scan(ROOT, files)
    run = [t for t in rust if not t["ignored"]]
    silent = [t for t in run if t["reasons"]]
    reported = [t for t in run if not t["reasons"] and t.get("reported")]
    ignored = [t for t in rust if t["ignored"]]
    doc = dict(
        rust_tests_scanned=len(rust),
        silent_rust=dict(total=len(silent),
                         by_module_reason=counts_by(silent, lambda t: f"{module_of(t['file'])} | {t['reasons'][0]}"),
                         tests=[dict(file=t["file"], name=t["name"], reasons=t["reasons"]) for t in silent]),
        reported_rust=dict(total=len(reported),
                           by_module_reason=counts_by(reported, lambda t: f"{module_of(t['file'])} | {t['reported'][0]}")),
        ignored_rust=dict(total=len(ignored),
                          by_module_reason=counts_by(ignored, lambda t: f"{module_of(t['file'])} | "
                                                     f"{(t.get('ignore_reason') or 'no reason').split(':')[0]}")),
    )
    text = json.dumps(doc, indent=1, sort_keys=True)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    h = sub.add_parser("history", help="fetch run/job history and failed-test logs")
    h.add_argument("--cache", required=True)
    h.add_argument("--runs", type=int, default=30)
    h.add_argument("--jobs", type=int, default=6)
    r = sub.add_parser("report", help="build the inventory JSON from the cache and the tree")
    r.add_argument("--cache", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--runs", type=int, default=30)
    r.add_argument("--nextest-lists", help="dir of test-ids.py dump files (before-<ws>.json)")
    r.add_argument("--test-map", help="Cockpit test map (YAML) for the per-component test ids")
    r.add_argument("--test-map-after", help="the same map rewritten for merged test binaries")
    r.add_argument("--test-ids", help="tooling/migration/test-ids.py (its matching rules)")
    r.add_argument("--merge-report", help="docs/migration/test-binaries.json (T4)")
    r.add_argument("--features", help="Cockpit feature registry dir (feature ids only)")
    r.add_argument("--cockpit-config", help="Cockpit config (which source reads which artifact)")
    t = sub.add_parser("tables", help="render the Markdown tables from a report JSON")
    t.add_argument("json")
    t.add_argument("--out", required=True)
    k = sub.add_parser("skips", help="the source scan alone: silent, reported and ignored Rust tests")
    k.add_argument("--out", help="write the JSON here instead of stdout")
    args = ap.parse_args()
    if args.cmd == "history":
        history(args)
    elif args.cmd == "report":
        report(args)
    elif args.cmd == "tables":
        with open(args.out, "w") as fh:
            fh.write(tables(load_json(args.json)))
    elif args.cmd == "skips":
        skips(args)


if __name__ == "__main__":
    main()
