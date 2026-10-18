#!/usr/bin/env python3
"""CI speed measurements for step A10: queue, cache, compute, wall, waste.

    python3 tooling/migration/ci_speed.py fetch  --cache DIR [--logs-per-job 6]
    python3 tooling/migration/ci_speed.py report --cache DIR --out FILE.json \
        [--hours 48] [--until ISO] [--markdown TABLES.md]

`fetch` reads GitHub Actions data with read-only `gh api` GETs and caches it
under --cache (the parity_counts.py / test_inventory.py layout, so their caches
can seed this one):

- every workflow run of the monorepo, with the jobs of every attempt;
- the old per-component runs of the A3 timing baseline
  (docs/migration/ci-timing-baseline.json), with their jobs;
- job logs of the Rust jobs (a rust-cache step or a disk clean-up step): all
  of the old baseline, and the newest N finished runs of every monorepo job.

`report` needs no network once the cache is filled. Per side (old = the A3
baseline runs, new = the monorepo runs in the window) it measures:

1. queue time: run created -> its first job started, and job created -> started;
2. cache: rust-cache restore and save seconds, hit kind and size, from the
   step times and the log;
3. Docker: whether any workflow builds an image;
4. compute: per job, set-up / cache / build+test / report seconds (the step
   buckets of ci-timing-baseline.json), and for the core Rust jobs the
   compile vs test-execution split from cargo's `Finished` line;
5. wall time and job minutes per green run, per workflow;

plus the waste the concurrency lever removes (superseded and duplicate runs,
main runs cancelled), the runner occupancy (peak running and queued jobs),
the free disk the clean-up step leaves, and which core test legs failed alone
(does macOS find anything Linux does not).

`--markdown` renders the tables used in docs/migration/ci-speed.md.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import glob
import json
import os
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import parity_counts as pc  # noqa: E402  (same directory)
import test_inventory as ti  # noqa: E402

NEW_REPO = pc.NEW_REPO
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BASELINE = os.path.join(ROOT, "docs", "migration", "ci-timing-baseline.json")
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")

# ---------------------------------------------------------------- helpers


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def secs(a, b):
    a, b = ts(a), ts(b)
    if a is None or b is None:
        return None
    return max(0.0, (b - a).total_seconds())


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return round(xs[k], 1)


def fmt_s(s):
    if s is None:
        return "—"
    s = int(round(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"


def ran(job):
    """A job that ran on a runner (not skipped, not cancelled before start)."""
    return (job.get("started_at") and job.get("completed_at")
            and job.get("conclusion") not in ("skipped", None)
            and job.get("steps"))


def job_run_seconds(job):
    return secs(job.get("started_at"), job.get("completed_at")) if ran(job) else 0.0


def is_macos(job):
    return any("macos" in lbl for lbl in job.get("labels") or [])


# ---------------------------------------------------------------- fetching


def all_new_runs(cache, refresh=True):
    def fetch():
        runs, page = [], 1
        while True:
            d = ti.gh_json(f"repos/{NEW_REPO}/actions/runs?per_page=100&page={page}")
            runs += d["workflow_runs"]
            if len(runs) >= d["total_count"] or not d["workflow_runs"]:
                return runs
            page += 1
    return ti._cached(cache, "a10-new-runs", fetch, refresh=refresh)


def jobs_of(cache, repo, run):
    """Jobs of every attempt; refetched until the run (and its attempt) is final."""
    key = f"a10-{repo.replace('/', '_')}-jobs-{run['id']}-a{run.get('run_attempt', 1)}"
    done = run.get("status") == "completed"

    def fetch():
        jobs, page = [], 1
        while True:
            d = ti.gh_json(f"repos/{repo}/actions/runs/{run['id']}/jobs"
                           f"?filter=all&per_page=100&page={page}")
            jobs += d["jobs"]
            if len(jobs) >= d["total_count"] or not d["jobs"]:
                return jobs
            page += 1
    seed = os.path.join(cache.root, "api",
                        f"hist-{repo.replace('/', '_')}-jobsall-{run['id']}.json")
    p = os.path.join(cache.root, "api", key + ".json")
    if done and not os.path.exists(p) and os.path.exists(seed):
        jobs = json.load(open(seed))
        if all(j.get("status") == "completed" for j in jobs) and \
                max((j.get("run_attempt") or 1) for j in jobs) >= run.get("run_attempt", 1):
            return jobs
    return ti._cached(cache, key, fetch, refresh=not done)


def baseline_runs():
    with open(BASELINE) as fh:
        base = json.load(fh)
    return [(w["repo"], w["workflow"], w["run"]["id"]) for w in base["workflows"]
            if w.get("run")]


def old_bundle(cache, repo, run_id):
    run = cache.json(f"{repo.replace('/', '_')}-run-{run_id}",
                     f"repos/{repo}/actions/runs/{run_id}")
    jobs = cache.json(f"{repo.replace('/', '_')}-jobs-{run_id}",
                      f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100")["jobs"]
    return run, jobs


RUST_CACHE_STEP = re.compile(r"rust-cache", re.I)
DISK_STEP = re.compile(r"free runner disk|disk at end of job", re.I)
SCCACHE_STEP = re.compile(r"sccache", re.I)


def wants_log(job):
    names = [s["name"] for s in job.get("steps") or []]
    return any(RUST_CACHE_STEP.search(n) or DISK_STEP.search(n) or SCCACHE_STEP.search(n)
               for n in names)


def fetch(args):
    cache = pc.Cache(args.cache)
    runs = all_new_runs(cache)
    print(f"monorepo runs: {len(runs)}", flush=True)
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(jobs_of, cache, NEW_REPO, r): r for r in runs}
        for i, f in enumerate(cf.as_completed(futs), 1):
            try:
                f.result()
            except Exception as e:  # keep going; the report marks the run unread
                print("jobs:", futs[f]["id"], e, file=sys.stderr)
            if i % 100 == 0:
                print(f"jobs {i}/{len(runs)}", flush=True)
    olds = []
    for repo, _wf, rid in baseline_runs():
        try:
            olds.append((repo, old_bundle(cache, repo, rid)))
        except Exception as e:
            print("old run:", repo, rid, e, file=sys.stderr)
    # Logs: the whole old baseline, and the newest N finished runs per new job name.
    want = []
    for repo, (_run, jobs) in olds:
        want += [(repo, j["id"]) for j in jobs if ran(j) and wants_log(j)]
    per_name = collections.defaultdict(list)
    for r in runs:
        if r.get("status") != "completed":
            continue
        try:
            jobs = jobs_of(cache, NEW_REPO, r)
        except Exception:
            continue
        for j in jobs:
            if ran(j) and wants_log(j) and j.get("conclusion") in ("success", "failure"):
                per_name[(r["name"], j["name"])].append(j)
    for js in per_name.values():
        js.sort(key=lambda j: j["started_at"], reverse=True)
        want += [(NEW_REPO, j["id"]) for j in js[:args.logs_per_job]]
    # The Actions cache as it is now (live state; one snapshot per fetch).
    caches, page = [], 1
    while True:
        d = ti.gh_json(f"repos/{NEW_REPO}/actions/caches?per_page=100&page={page}")
        caches += d["actions_caches"]
        if len(caches) >= d["total_count"] or not d["actions_caches"]:
            break
        page += 1
    snap = dict(taken_at=dt.datetime.now(dt.timezone.utc).isoformat(), caches=caches,
                usage=ti.gh_json(f"repos/{NEW_REPO}/actions/cache/usage"))
    with open(os.path.join(cache.root, "api", "a10-caches.json"), "w") as fh:
        json.dump(snap, fh)
    print(f"logs wanted: {len(want)}", flush=True)
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(cache.log, repo, jid): (repo, jid) for repo, jid in want}
        for f in cf.as_completed(futs):
            try:
                f.result()
            except Exception as e:
                print("log:", futs[f], e, file=sys.stderr)
    print("fetch: done", flush=True)


# ---------------------------------------------------------------- log parsing

CACHE_HIT = re.compile(r'^Restored from cache key "([^"]+)" full match: (true|false)')
CACHE_MISS = re.compile(r"^No cache found\.")
CACHE_SIZE = re.compile(r"^Cache Size: ~(\d+) MB")
CACHE_KEY = re.compile(r"^\s+(v\d+-rust-\S+)$")
SAVE_RESULT = re.compile(r"^(Cache saved|Failed to save|Unable to reserve|"
                         r"Cache up-to-date|.*another job may be creating this cache|"
                         r"Not saving cache|... Saving cache ...)", re.I)
FINISHED = re.compile(r"^\s*Finished `(\w+)` profile \[[^\]]*\] target\(s\) in "
                      r"(?:(\d+)m )?([\d.]+)s")
DF_ROOT = re.compile(r"^/dev/\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+/$")
GROUP_RUN = re.compile(r"^##\[group\]Run (.*)$")


def log_text(cache, repo, job_id):
    p = os.path.join(cache.root, "logs", f"{repo.replace('/', '_')}-{job_id}.log")
    if not os.path.exists(p):
        return None
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")


def size_gb(tok):
    m = re.match(r"([\d.]+)([KMGT])", tok)
    if not m:
        return None
    return float(m[1]) * {"K": 1e-6, "M": 1e-3, "G": 1, "T": 1e3}[m[2]]


def parse_rust_log(text):
    """rust-cache result, compile times per profile, free disk, by log section."""
    out = dict(cache=[], finished=[], disk=[], saves=[])
    lines = pc.clean_lines(text)
    section = None
    in_post = False
    for i, ln in enumerate(lines):
        m = GROUP_RUN.match(ln)
        if m:
            section = m[1]
            continue
        if ln.startswith("Post job cleanup."):
            in_post = True
        m = CACHE_HIT.match(ln)
        if m:
            out["cache"].append(dict(result="exact" if m[2] == "true" else "partial",
                                     key=m[1]))
            continue
        if CACHE_MISS.match(ln):
            out["cache"].append(dict(result="miss", key=None))
            continue
        m = CACHE_SIZE.match(ln)
        if m and not in_post:
            out.setdefault("restore_mb", []).append(int(m[1]))
            continue
        if in_post:
            m = SAVE_RESULT.match(ln.strip())
            if m:
                out["saves"].append(ln.strip()[:120])
        m = FINISHED.match(ln)
        if m:
            s = float(m[3]) + 60 * int(m[2] or 0)
            out["finished"].append(dict(profile=m[1], seconds=s, step=section))
            continue
        m = DF_ROOT.match(ln.strip())
        if m:
            out["disk"].append(dict(step=section, size_gb=size_gb(m[1]),
                                    used_gb=size_gb(m[2]), avail_gb=size_gb(m[3]),
                                    use_pct=int(m[4])))
    return out


# ---------------------------------------------------------------- measuring


def step_seconds(job, rx, post=None):
    tot = 0.0
    found = False
    for st in job.get("steps") or []:
        name = st["name"]
        if not rx.search(name):
            continue
        if post is not None and name.startswith("Post ") != post:
            continue
        s = secs(st.get("started_at"), st.get("completed_at"))
        if s is not None:
            tot += s
            found = True
    return tot if found else None


SCCACHE_STAT = re.compile(r"^(Compile requests(?: executed)?|Cache hits(?: \(Rust\))?|"
                          r"Cache misses(?: \(Rust\))?|Cache timeouts|Cache read errors|"
                          r"Cache write errors|Non-cacheable calls|Non-compilation calls|"
                          r"Average cache write|Average cache read hit|Average compiler)"
                          r"\s{2,}(\S+(?: s)?)\s*$")


def sccache_trial(cache, jobs_out_full):
    """The ci-sccache-trial.yml job: cold and warm build seconds plus sccache's stats
    (the first `sccache --show-stats` follows build 1, the second build 2)."""
    out = []
    for j in jobs_out_full:
        if not j["job"].startswith("sccache trial"):
            continue
        steps = {st["name"]: st["s"] for st in j["steps"]}
        text = log_text(cache, j["repo"], j["job_id"]) or ""
        stats, cur, seen = {}, None, 0
        for ln in pc.clean_lines(text):
            m = GROUP_RUN.match(ln)
            if m:
                cur = None
                if m[1].startswith("sccache --show-stats"):
                    seen += 1
                    cur = f"after build {seen}"
                continue
            m = SCCACHE_STAT.match(ln.strip())
            if m and cur:
                stats.setdefault(cur, {})[m[1]] = m[2]
        out.append(dict(run=j["run"], conclusion=j["conclusion"], run_s=j["run_s"],
                        build_cold_s=steps.get("build 1 (cold sccache)"),
                        build_warm_s=steps.get("build 2 (warm sccache)"), stats=stats))
    return out


def run_queue(run, jobs):
    """Run created -> first job started (attempt 1 only)."""
    first = [j for j in jobs if (j.get("run_attempt") or 1) == 1 and ran(j)]
    if not first:
        return None
    return secs(run["created_at"], min(j["started_at"] for j in first))


def run_wall(jobs):
    """A3's definition: first job created -> last job completed (latest attempt)."""
    js = [j for j in latest_attempt(jobs) if ran(j)]
    if not js:
        return None
    return secs(min(j["created_at"] for j in js), max(j["completed_at"] for j in js))


def latest_attempt(jobs):
    if not jobs:
        return []
    top = max((j.get("run_attempt") or 1) for j in jobs)
    return [j for j in jobs if (j.get("run_attempt") or 1) == top]


def job_record(side, repo, wf, run, j, cache):
    sp = ti.job_split(j) if ran(j) else {}
    rec = dict(side=side, repo=repo, workflow=wf, run=run["id"], event=run.get("event"),
               branch=run.get("head_branch"), job=j["name"], job_id=j["id"],
               conclusion=j.get("conclusion"), runner=",".join(j.get("labels") or []),
               queue=secs(j.get("created_at"), j.get("started_at")) if ran(j) else None,
               run_s=job_run_seconds(j), **{k: sp.get(k) for k in
                                            ("setup", "cache", "build_test", "artifact_report")})
    rc_restore = step_seconds(j, RUST_CACHE_STEP, post=False)
    rc_save = step_seconds(j, RUST_CACHE_STEP, post=True)
    if rc_restore is not None:
        rec["rust_cache"] = dict(restore_s=rc_restore, save_s=rc_save)
    text = log_text(cache, repo, j["id"]) if ran(j) else None
    if text is not None:
        pl = parse_rust_log(text)
        if rc_restore is not None:
            rc = rec["rust_cache"]
            rc["result"] = pl["cache"][0]["result"] if pl["cache"] else "unknown"
            rc["restore_mb"] = (pl.get("restore_mb") or [None])[0]
            rc["save_lines"] = pl["saves"][-2:]
        rec["finished"] = pl["finished"]
        rec["disk"] = pl["disk"]
        rec["counts"] = {k: v for k, v in pc.parse_log(text).items()
                         if k in ("cargo test", "nextest")}
        rec["log"] = True
    rec["steps"] = [dict(name=s["name"], s=secs(s.get("started_at"), s.get("completed_at")),
                         conclusion=s.get("conclusion")) for s in j.get("steps") or []]
    return rec


def collect(cache, since, until, branch=None):
    runs_new = [r for r in all_new_runs(cache, refresh=False)
                if since <= ts(r["created_at"]) <= until
                and (branch is None or r["head_branch"] == branch)]
    new = []
    for r in runs_new:
        try:
            jobs = jobs_of(cache, NEW_REPO, r)
        except Exception:
            jobs = None
        new.append((r, jobs))
    old = []
    for repo, wf, rid in baseline_runs():
        try:
            run, jobs = old_bundle(cache, repo, rid)
        except Exception:
            continue
        old.append((repo, wf, run, jobs))
    return new, old


def waste(new):
    """Superseded and duplicate runs: what concurrency cancel-in-progress removes."""
    groups = collections.defaultdict(list)
    by_sha = collections.defaultdict(list)
    for r, jobs in new:
        if jobs is None:
            continue
        end = max([ts(j["completed_at"]) for j in jobs if j.get("completed_at")] or
                  [ts(r["updated_at"])])
        rec = dict(run=r, jobs=jobs, end=end)
        groups[(r["workflow_id"], r["event"], r["head_branch"])].append(rec)
        by_sha[(r["workflow_id"], r["event"], r["head_sha"])].append(rec)
    sup = []
    for (wid, event, branch), recs in groups.items():
        recs.sort(key=lambda x: x["run"]["created_at"])
        for i, rec in enumerate(recs):
            nxt = next((o for o in recs[i + 1:]
                        if ts(o["run"]["created_at"]) < rec["end"]), None)
            if nxt is None:
                continue
            t0 = ts(nxt["run"]["created_at"])
            after = 0.0
            total = 0.0
            for j in rec["jobs"]:
                if not ran(j):
                    continue
                a, b = ts(j["started_at"]), ts(j["completed_at"])
                total += (b - a).total_seconds()
                after += max(0.0, (b - max(a, t0)).total_seconds())
            sup.append(dict(workflow=rec["run"]["name"], event=event, branch=branch,
                            run=rec["run"]["id"], conclusion=rec["run"].get("conclusion"),
                            superseded_by=nxt["run"]["id"], job_s=total,
                            job_s_after_superseded=after))
    dups = []
    for (wid, event, sha), recs in by_sha.items():
        if len(recs) < 2:
            continue
        recs.sort(key=lambda x: x["run"]["created_at"])
        for rec in recs[1:]:
            dups.append(dict(workflow=rec["run"]["name"], event=event, sha=sha[:9],
                             branch=rec["run"]["head_branch"], run=rec["run"]["id"],
                             conclusion=rec["run"].get("conclusion"),
                             first=recs[0]["run"]["id"],
                             job_s=sum(job_run_seconds(j) for j in rec["jobs"])))
    return sup, dups


def occupancy(new):
    """Peak running and queued jobs (all runners; macOS separately), 1-minute steps."""
    ev = []
    for r, jobs in new:
        for j in jobs or []:
            c, s, e = ts(j.get("created_at")), ts(j.get("started_at")), ts(j.get("completed_at"))
            if c is None:
                continue
            if j.get("conclusion") == "skipped":
                continue
            ev.append((c, s if (s and ran(j)) else e, e, is_macos(j)))
    if not ev:
        return {}
    t = min(x[0] for x in ev).replace(second=0, microsecond=0)
    end = max((x[2] or x[0]) for x in ev)
    peak = dict(running=0, queued=0, running_macos=0, at_running=None, at_queued=None)
    while t <= end:
        run_n = q_n = mac_n = 0
        for c, s, e, mac in ev:
            if c <= t and (s is None or t < s):
                q_n += 1
            elif s and s <= t and (e is None or t < e):
                run_n += 1
                mac_n += mac
        if run_n > peak["running"]:
            peak["running"], peak["at_running"] = run_n, t.isoformat()
        if q_n > peak["queued"]:
            peak["queued"], peak["at_queued"] = q_n, t.isoformat()
        peak["running_macos"] = max(peak["running_macos"], mac_n)
        t += dt.timedelta(minutes=1)
    return peak


def leg_failures(cache):
    """core check + test: runs where one OS's test step failed and the other passed."""
    out = {}
    sides = [("old", "paged-media/core", "ci.yml"), ("new", NEW_REPO, "core-ci.yml")]
    for side, repo, wf in sides:
        pat = os.path.join(cache.root, "api", f"hist-{repo.replace('/', '_')}-{wf}-runs*.json")
        runs = {}
        for p in glob.glob(pat):
            for r in json.load(open(p)):
                runs[r["id"]] = r
        if side == "new":
            for r in all_new_runs(cache, refresh=False):
                if r["path"].endswith("/core-ci.yml"):
                    runs[r["id"]] = r
        c = collections.Counter()
        for r in runs.values():
            if r.get("status") != "completed":
                continue
            try:
                jobs = (jobs_of(cache, repo, r) if side == "new" else
                        json.load(open(os.path.join(
                            cache.root, "api",
                            f"hist-{repo.replace('/', '_')}-jobsall-{r['id']}.json"))))
            except Exception:
                continue
            res = {}
            for j in latest_attempt(jobs):
                m = re.match(r"check \+ test \((\w+)-latest\)", j["name"])
                if not m:
                    continue
                st = next((s for s in j.get("steps") or [] if s["name"] == "test"), None)
                if st and st.get("conclusion") in ("success", "failure"):
                    res[m[1]] = st["conclusion"]
            if len(res) < 2:
                continue
            c["both legs ran the test step"] += 1
            if res["ubuntu"] == "success" and res["macos"] == "failure":
                c["macOS failed, Linux passed"] += 1
            elif res["ubuntu"] == "failure" and res["macos"] == "success":
                c["Linux failed, macOS passed"] += 1
            elif res["ubuntu"] == res["macos"] == "failure":
                c["both failed"] += 1
            else:
                c["both passed"] += 1
        out[side] = dict(c)
    return out


def docker_usage():
    hits = []
    for p in sorted(glob.glob(os.path.join(WORKFLOWS, "*.yml"))):
        with open(p) as fh:
            for n, ln in enumerate(fh, 1):
                if re.search(r"docker/build-push-action|docker build|docker buildx|"
                             r"docker compose|setup-buildx", ln, re.I):
                    hits.append(f"{os.path.basename(p)}:{n}")
    return hits


def ref_cancelling(rev):
    """Workflows whose concurrency group is the git ref with cancel-in-progress: true
    at REV (such a group also cancels pushes to main)."""
    out = set()
    names = subprocess.run(["git", "-C", ROOT, "ls-tree", "--name-only", f"{rev}:.github/workflows"],
                           capture_output=True, text=True).stdout.split()
    for n in names:
        txt = subprocess.run(["git", "-C", ROOT, "show", f"{rev}:.github/workflows/{n}"],
                             capture_output=True, text=True).stdout
        m = re.search(r"^concurrency:\n((?:[ \t]+.*\n)+)", txt, re.M)
        if m and re.search(r"cancel-in-progress:\s*true", m[1]) and \
                "github.event.pull_request.number" not in m[1]:
            out.add(n)
    return out


def cache_snapshot(cache):
    p = os.path.join(cache.root, "api", "a10-caches.json")
    if not os.path.exists(p):
        return None
    snap = json.load(open(p))
    rows = collections.defaultdict(lambda: dict(entries=0, mb=0))
    for c in snap["caches"]:
        ref = "main" if c["ref"] == "refs/heads/main" else (
            "pull request" if c["ref"].startswith("refs/pull/") else c["ref"])
        fam = ("core rust-cache" if c["key"].startswith("v0-rust-core-") else
               "other rust-cache" if c["key"].startswith("v0-rust-") else "other")
        r = rows[(fam, ref)]
        r["entries"] += 1
        r["mb"] += round(c["size_in_bytes"] / 1e6)
    oldest = min((c["created_at"] for c in snap["caches"]), default=None)
    return dict(taken_at=snap["taken_at"], usage=snap["usage"], oldest_entry_created=oldest,
                by_family_and_ref=[dict(family=f, ref=r, **v)
                                   for (f, r), v in sorted(rows.items())])


def per_workflow_waste(new, sup, cancelling):
    rows = collections.defaultdict(collections.Counter)
    for r, jobs in new:
        wf = os.path.basename(r["path"])
        c = rows[wf]
        c["runs"] += 1
        c["job_s"] += sum(job_run_seconds(j) for j in latest_attempt(jobs or []))
        if r.get("conclusion") == "cancelled":
            c["cancelled"] += 1
            if r["event"] == "push" and r.get("head_branch") == "main":
                c["main_cancelled"] += 1
    for s in sup:
        wf = next(os.path.basename(r["path"]) for r, _ in new if r["id"] == s["run"])
        c = rows[wf]
        c["superseded"] += 1
        if s["conclusion"] != "cancelled":
            c["superseded_completed"] += 1
            c["superseded_completed_job_s"] += s["job_s_after_superseded"]
    return [dict(workflow=wf, ref_group_cancel=wf in cancelling,
                 job_minutes=round(c["job_s"] / 60, 1),
                 **{k: (round(v / 60, 1) if k.endswith("_job_s") else v)
                    for k, v in c.items() if k != "job_s"})
            for wf, c in sorted(rows.items())]


def queue_hops(new):
    """Jobs created after their run started (a `needs:` dependency): run created ->
    first dependent job created. Every hop puts the dependent jobs at the back of
    the queue again."""
    rows = collections.defaultdict(list)
    for r, jobs in new:
        if r.get("status") != "completed" or not jobs:
            continue
        js = [j for j in jobs if (j.get("run_attempt") or 1) == 1 and j.get("conclusion") != "skipped"]
        t0 = ts(r["created_at"])
        dep = [j for j in js if ts(j["created_at"]) > t0 + dt.timedelta(seconds=30)]
        if not dep:
            continue
        first = min(dep, key=lambda j: j["created_at"])
        parents = [j for j in js if j not in dep and j.get("completed_at")
                   and abs((ts(j["completed_at"]) - ts(first["created_at"])).total_seconds()) < 30]
        rows[os.path.basename(r["path"])].append(dict(
            hop_s=secs(r["created_at"], first["created_at"]),
            parent=parents[0]["name"] if parents else None,
            parent_run_s=job_run_seconds(parents[0]) if parents else None))
    return [dict(workflow=wf, runs=len(xs), hop_median=med([x["hop_s"] for x in xs]),
                 hop_p90=pct([x["hop_s"] for x in xs], .9),
                 hop_minutes_sum=round(sum(x["hop_s"] for x in xs) / 60, 1),
                 parents=dict(collections.Counter(x["parent"] for x in xs)),
                 parent_run_median=med([x["parent_run_s"] for x in xs]))
            for wf, xs in sorted(rows.items())]


def tiny_jobs(jobs_out, limit=60):
    out = {}
    for side in ("old", "new"):
        js = [j for j in jobs_out if j["side"] == side and j["conclusion"] == "success"]
        tiny = [j for j in js if j["run_s"] < limit]
        out[side] = dict(jobs=len(js), tiny=len(tiny),
                         tiny_minutes=round(sum(j["run_s"] for j in tiny) / 60, 1),
                         all_minutes=round(sum(j["run_s"] for j in js) / 60, 1),
                         tiny_setup_share=round(sum(j.get("setup") or 0 for j in tiny) /
                                                max(1, sum(j["run_s"] for j in tiny)), 2),
                         tiny_queue_median=med([j["queue"] for j in tiny]),
                         names=dict(collections.Counter(j["job"] for j in tiny).most_common(12)))
    return out


def report(args):
    cache = pc.Cache(args.cache)
    until = ts(args.until) if args.until else dt.datetime.now(dt.timezone.utc)
    since = until - dt.timedelta(hours=args.hours)
    new, old = collect(cache, since, until, args.branch)
    out = dict(
        description=("CI speed measurements (step A10), produced by "
                     "tooling/migration/ci_speed.py from read-only GitHub API data. "
                     "old = the A3 baseline runs (ci-timing-baseline.json); new = every "
                     "monorepo run created in the window."),
        window=dict(since=since.isoformat(), until=until.isoformat(), hours=args.hours,
                    branch=args.branch),
        collected_at=dt.datetime.now(dt.timezone.utc).isoformat())

    # --- per run (queue, wall, minutes) and per job records
    runs_out, jobs_out = [], []
    for repo, wf, run, jobs in old:
        wf = f"{repo.split('/')[1]}/{wf}"
        latest = latest_attempt(jobs)
        runs_out.append(dict(side="old", repo=repo, workflow=wf, run=run["id"],
                             event=run.get("event"), conclusion=run.get("conclusion"),
                             queue_s=run_queue(run, jobs), wall_s=run_wall(jobs),
                             job_minutes=round(sum(job_run_seconds(j) for j in latest) / 60, 1),
                             jobs=sum(1 for j in latest if ran(j))))
        jobs_out += [job_record("old", repo, wf, run, j, cache) for j in latest if ran(j)]
    unread = 0
    for run, jobs in new:
        if jobs is None:
            unread += 1
            continue
        wf = os.path.basename(run["path"])
        latest = latest_attempt(jobs)
        runs_out.append(dict(side="new", repo=NEW_REPO, workflow=wf, run=run["id"],
                             event=run.get("event"), branch=run.get("head_branch"),
                             status=run.get("status"), conclusion=run.get("conclusion"),
                             created_at=run["created_at"],
                             queue_s=run_queue(run, jobs), wall_s=run_wall(jobs),
                             job_minutes=round(sum(job_run_seconds(j) for j in latest) / 60, 1),
                             jobs=sum(1 for j in latest if ran(j))))
        if run.get("status") == "completed":
            jobs_out += [job_record("new", NEW_REPO, wf, run, j, cache)
                         for j in latest if ran(j)]
    out["unread_runs"] = unread

    # 1. queue
    q = {}
    for side in ("old", "new"):
        rq = [r["queue_s"] for r in runs_out if r["side"] == side]
        jq = [j["queue"] for j in jobs_out if j["side"] == side]
        jq_mac = [j["queue"] for j in jobs_out if j["side"] == side and "macos" in j["runner"]]
        q[side] = dict(runs=len(rq), run_queue_median=med(rq), run_queue_p90=pct(rq, .9),
                       run_queue_max=pct(rq, 1), jobs=len(jq), job_queue_median=med(jq),
                       job_queue_p90=pct(jq, .9), job_queue_max=pct(jq, 1),
                       macos_jobs=len(jq_mac), macos_job_queue_median=med(jq_mac),
                       macos_job_queue_p90=pct(jq_mac, .9))
    out["queue"] = q

    # 2. cache (rust-cache), per side and per (workflow, job)
    rc_rows = collections.defaultdict(list)
    for j in jobs_out:
        if "rust_cache" in j:
            key = re.sub(r" \((ubuntu|macos)-latest\)$", "", j["job"])
            os_ = "macOS" if "macos" in j["runner"] else "Linux"
            rc_rows[(j["side"], j["workflow"], key, os_)].append(j)
    rc = []
    for (side, wf, job, os_), js in sorted(rc_rows.items()):
        res = collections.Counter(x["rust_cache"].get("result", "no log") for x in js)
        rc.append(dict(side=side, workflow=wf, job=job, os=os_, jobs=len(js),
                       results=dict(res),
                       restore_median=med([x["rust_cache"]["restore_s"] for x in js]),
                       restore_max=pct([x["rust_cache"]["restore_s"] for x in js], 1),
                       save_median=med([x["rust_cache"]["save_s"] for x in js]),
                       restore_mb_median=med([x["rust_cache"].get("restore_mb") for x in js]),
                       run_median=med([x["run_s"] for x in js])))
    out["rust_cache"] = rc
    tot = {}
    for side in ("old", "new"):
        js = [j for j in jobs_out if j["side"] == side and "rust_cache" in j
              and j["rust_cache"].get("result") not in (None, "unknown")]
        res = collections.Counter(j["rust_cache"]["result"] for j in js)
        tot[side] = dict(jobs_with_log=len(js), results=dict(res),
                         hit_rate=round((res["exact"] + res["partial"]) / len(js), 3) if js else None,
                         restore_s_sum=round(sum(j["rust_cache"]["restore_s"] for j in js)),
                         save_s_sum=round(sum(j["rust_cache"]["save_s"] or 0 for j in js)),
                         run_s_sum=round(sum(j["run_s"] for j in js)))
    out["rust_cache_totals"] = tot

    # 3. docker
    out["docker"] = docker_usage()

    # 4. compute: bucket split per side (green runs' jobs) and core Rust split
    comp = {}
    for side in ("old", "new"):
        js = [j for j in jobs_out if j["side"] == side and j["conclusion"] == "success"]
        b = {k: round(sum(j.get(k) or 0 for j in js) / 60, 1)
             for k in ("setup", "cache", "build_test", "artifact_report")}
        b["run"] = round(sum(j["run_s"] for j in js) / 60, 1)
        b["jobs"] = len(js)
        comp[side] = b
    out["compute"] = comp
    core = []
    for j in jobs_out:
        if j["workflow"] not in ("core/ci.yml", "core-ci.yml") or not j.get("log"):
            continue
        steps = {s["name"]: s["s"] for s in j["steps"]}
        # The test step that ran: macOS's `test`, Linux's nextest step (each leg
        # skips the other's, which then reads 0 s).
        cand = [n for n in steps if n == "test" or n.startswith("nextest")
                or n.startswith("Run cargo test") or n.startswith("Run cargo nextest")]
        test_step = max(cand, key=lambda n: steps[n] or 0) if cand else None
        fin_test = [f["seconds"] for f in j["finished"] if f["profile"] == "test"]
        fin_dev = [f["seconds"] for f in j["finished"] if f["profile"] == "dev"]
        if not test_step and not fin_dev:
            continue
        core.append(dict(side=j["side"], run=j["run"], job=j["job"], runner=j["runner"],
                         conclusion=j["conclusion"], run_s=j["run_s"],
                         cache=j.get("rust_cache", {}).get("result"),
                         clippy_s=steps.get("clippy"), test_step=test_step,
                         test_step_s=steps.get(test_step) if test_step else None,
                         test_compile_s=fin_test[0] if fin_test else None,
                         clippy_compile_s=fin_dev[0] if fin_dev else None,
                         counts=j.get("counts")))
    out["core_jobs"] = core

    # 5. wall + minutes per green run, per workflow
    wall = []
    for side in ("old", "new"):
        by = collections.defaultdict(list)
        for r in runs_out:
            if r["side"] == side and r["conclusion"] == "success":
                by[r["workflow"]].append(r)
        for wf, rs in sorted(by.items()):
            wall.append(dict(side=side, workflow=wf, green_runs=len(rs),
                             wall_median=med([r["wall_s"] for r in rs]),
                             queue_median=med([r["queue_s"] for r in rs]),
                             job_minutes_median=med([r["job_minutes"] for r in rs]),
                             job_minutes_max=pct([r["job_minutes"] for r in rs], 1)))
    out["green"] = wall

    # waste, occupancy, macOS legs, disk
    sup, dups = waste(new)
    completed_sup = [s for s in sup if s["conclusion"] != "cancelled"]
    out["superseded"] = dict(
        runs=len(sup), ran_to_completion=len(completed_sup),
        cancelled=len(sup) - len(completed_sup),
        job_minutes_after_superseded=round(sum(s["job_s_after_superseded"] for s in sup) / 60, 1),
        job_minutes_after_superseded_completed=round(
            sum(s["job_s_after_superseded"] for s in completed_sup) / 60, 1),
        by_workflow=dict(collections.Counter(s["workflow"] for s in sup)),
        detail=sup)
    out["duplicates"] = dict(runs=len(dups),
                             job_minutes=round(sum(d["job_s"] for d in dups) / 60, 1),
                             by_workflow=dict(collections.Counter(d["workflow"] for d in dups)),
                             detail=dups)
    totals = collections.Counter()
    for r in runs_out:
        if r["side"] != "new":
            continue
        totals["runs"] += 1
        totals[f"conclusion:{r.get('conclusion') or r.get('status')}"] += 1
        if r["event"] == "push" and r.get("branch") == "main" and r.get("conclusion") == "cancelled":
            totals["main push runs cancelled"] += 1
        totals["job_minutes"] += r["job_minutes"]
        if r.get("conclusion") == "cancelled":
            totals["job_minutes_in_cancelled_runs"] += r["job_minutes"]
    out["new_totals"] = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in totals.items()}
    out["config_rev"] = args.config_rev
    out["waste_by_workflow"] = per_workflow_waste(new, sup, ref_cancelling(args.config_rev))
    out["queue_hops"] = queue_hops(new)
    out["tiny_jobs"] = tiny_jobs(jobs_out)
    out["cache_snapshot"] = cache_snapshot(cache)
    out["sccache_trial"] = sccache_trial(cache, jobs_out)
    out["occupancy"] = occupancy(new)
    out["core_test_legs"] = leg_failures(cache)
    disk = []
    for j in jobs_out:
        for d in j.get("disk") or []:
            disk.append(dict(side=j["side"], workflow=j["workflow"], job=j["job"],
                             step=d["step"], avail_gb=d["avail_gb"], size_gb=d["size_gb"],
                             use_pct=d["use_pct"]))
    out["disk"] = disk
    out["runs"] = runs_out
    if args.full:
        # Per-job records without the step lists (they are in the gh cache).
        out["jobs"] = [{k: v for k, v in j.items() if k != "steps"} for j in jobs_out]
    else:
        out["superseded"].pop("detail")
        out["duplicates"].pop("detail")
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=1, default=str)
        fh.write("\n")
    print(f"wrote {args.out}: {len(runs_out)} runs, {len(jobs_out)} jobs", flush=True)
    if args.markdown:
        with open(args.markdown, "w") as fh:
            fh.write(tables(out))
        print(f"wrote {args.markdown}", flush=True)


# ---------------------------------------------------------------- tables


def tables(d):
    o = []
    w = o.append
    w(f"Window: {d['window']['since'][:16]}Z to {d['window']['until'][:16]}Z "
      f"({d['window']['hours']} h)"
      + (f", branch {d['window']['branch']}" if d['window'].get('branch') else "") + ".\n")
    w("\n### Queue\n\n| Side | Runs | Run queue median / p90 / max | Jobs | "
      "Job queue median / p90 / max | macOS job queue median / p90 |\n|---|---|---|---|---|---|\n")
    for side, q in d["queue"].items():
        w(f"| {side} | {q['runs']} | {fmt_s(q['run_queue_median'])} / {fmt_s(q['run_queue_p90'])}"
          f" / {fmt_s(q['run_queue_max'])} | {q['jobs']} | {fmt_s(q['job_queue_median'])} / "
          f"{fmt_s(q['job_queue_p90'])} / {fmt_s(q['job_queue_max'])} | "
          f"{fmt_s(q['macos_job_queue_median'])} / {fmt_s(q['macos_job_queue_p90'])} |\n")
    oc = d.get("occupancy") or {}
    if oc:
        w(f"\nPeak (new side, 1-minute samples): {oc['running']} jobs running "
          f"({oc['at_running']}), {oc['queued']} jobs queued ({oc['at_queued']}), "
          f"{oc['running_macos']} macOS jobs running.\n")
    w("\n### rust-cache totals\n\n| Side | Jobs with a log | exact / partial / miss | "
      "Hit rate | Restore s (sum) | Save s (sum) | Job s (sum) |\n|---|---|---|---|---|---|---|\n")
    for side, t in d["rust_cache_totals"].items():
        r = t["results"]
        w(f"| {side} | {t['jobs_with_log']} | {r.get('exact', 0)} / {r.get('partial', 0)} / "
          f"{r.get('miss', 0)} | {t['hit_rate']} | {t['restore_s_sum']} | {t['save_s_sum']} | "
          f"{t['run_s_sum']} |\n")
    cs = d.get("cache_snapshot")
    if cs:
        u = cs["usage"]
        w(f"\nActions cache at {cs['taken_at'][:16]}Z: {u['active_caches_count']} entries, "
          f"{u['active_caches_size_in_bytes'] / 1e9:.2f} GB; oldest entry created "
          f"{cs['oldest_entry_created'][:16]}Z.\n\n| Family | Ref | Entries | MB |\n|---|---|---|---|\n")
        for r in cs["by_family_and_ref"]:
            w(f"| {r['family']} | {r['ref']} | {r['entries']} | {r['mb']} |\n")
    w("\n### rust-cache per job\n\n| Side | Workflow | Job | OS | Jobs | Results | "
      "Restore median / max | Save median | Restored MB | Job run median |\n"
      "|---|---|---|---|---|---|---|---|---|---|\n")
    for r in d["rust_cache"]:
        res = ", ".join(f"{k} {v}" for k, v in sorted(r["results"].items()))
        w(f"| {r['side']} | {r['workflow']} | {r['job']} | {r['os']} | {r['jobs']} | {res} | "
          f"{fmt_s(r['restore_median'])} / {fmt_s(r['restore_max'])} | {fmt_s(r['save_median'])} | "
          f"{r['restore_mb_median'] or '—'} | {fmt_s(r['run_median'])} |\n")
    w("\n### Compute by step bucket (green jobs, minutes)\n\n| Side | Jobs | Run | Setup | "
      "Cache | Build/test | Report |\n|---|---|---|---|---|---|---|\n")
    for side, c in d["compute"].items():
        w(f"| {side} | {c['jobs']} | {c['run']} | {c['setup']} | {c['cache']} | "
          f"{c['build_test']} | {c['artifact_report']} |\n")
    w("\n### Core Rust jobs: compile vs test execution\n\n| Side | Run | Job | Cache | Job | "
      "clippy step (compile) | test step | test compile | test execution | counts |\n"
      "|---|---|---|---|---|---|---|---|---|---|\n")
    for c in sorted(d["core_jobs"], key=lambda x: (x["side"], x["job"], x["run"])):
        exe = (c["test_step_s"] - c["test_compile_s"]
               if c["test_step_s"] is not None and c["test_compile_s"] is not None else None)
        cnt = "; ".join(f"{k} {v.get('run')}/{v.get('skipped')}" for k, v in
                        (c.get("counts") or {}).items())
        w(f"| {c['side']} | {c['run']} | {c['job']} | {c['cache']} | {fmt_s(c['run_s'])} | "
          f"{fmt_s(c['clippy_s'])} ({fmt_s(c['clippy_compile_s'])}) | {fmt_s(c['test_step_s'])} | "
          f"{fmt_s(c['test_compile_s'])} | {fmt_s(exe)} | {cnt or '—'} |\n")
    w("\n### Green runs per workflow (medians)\n\n| Side | Workflow | Green runs | Wall | "
      "Queue | Job minutes (median / max) |\n|---|---|---|---|---|---|\n")
    for g in d["green"]:
        w(f"| {g['side']} | {g['workflow']} | {g['green_runs']} | {fmt_s(g['wall_median'])} | "
          f"{fmt_s(g['queue_median'])} | {g['job_minutes_median']} / {g['job_minutes_max']} |\n")
    s, du, nt = d["superseded"], d["duplicates"], d["new_totals"]
    w(f"\n### Waste (new side)\n\n- runs: {nt.get('runs')}; job minutes {nt.get('job_minutes')}; "
      f"in cancelled runs {nt.get('job_minutes_in_cancelled_runs', 0)}\n"
      f"- conclusions: " + ", ".join(f"{k.split(':', 1)[1]} {v}" for k, v in sorted(nt.items())
                                     if k.startswith("conclusion:")) + "\n"
      f"- main push runs cancelled: {nt.get('main push runs cancelled', 0)}\n"
      f"- superseded runs: {s['runs']} ({s['ran_to_completion']} ran to completion, "
      f"{s['cancelled']} cancelled); job minutes after the newer run was created: "
      f"{s['job_minutes_after_superseded']} (of which in runs that ran to completion: "
      f"{s['job_minutes_after_superseded_completed']})\n"
      f"- duplicate runs (same workflow, event and commit): {du['runs']}, {du['job_minutes']} "
      f"job minutes\n")
    w("\n### Waste per workflow (new side)\n\n| Workflow | Ref-keyed cancel group | Runs | "
      "Job minutes | Cancelled | Main pushes cancelled | Superseded | Superseded but ran to the "
      "end | Job minutes after supersession (ran to the end) |\n"
      "|---|---|---|---|---|---|---|---|---|\n")
    for r in d["waste_by_workflow"]:
        w(f"| {r['workflow']} | {'yes' if r['ref_group_cancel'] else 'no'} | {r.get('runs', 0)} | "
          f"{r['job_minutes']} | {r.get('cancelled', 0)} | {r.get('main_cancelled', 0)} | "
          f"{r.get('superseded', 0)} | {r.get('superseded_completed', 0)} | "
          f"{r.get('superseded_completed_job_s', 0)} |\n")
    w("\n### Queue hops (`needs:` dependencies, new side)\n\n| Workflow | Runs | Hop median / "
      "p90 | Hop minutes (sum) | First parent job | Parent run median |\n"
      "|---|---|---|---|---|---|\n")
    for h in d["queue_hops"]:
        par = ", ".join(f"{k} {v}" for k, v in h["parents"].items())
        w(f"| {h['workflow']} | {h['runs']} | {fmt_s(h['hop_median'])} / {fmt_s(h['hop_p90'])} | "
          f"{h['hop_minutes_sum']} | {par} | {fmt_s(h['parent_run_median'])} |\n")
    w("\n### Tiny jobs (green, run time under 60 s)\n\n| Side | Green jobs | Tiny | Tiny minutes | "
      "All minutes | Set-up share of tiny | Tiny queue median |\n|---|---|---|---|---|---|---|\n")
    for side, t in d["tiny_jobs"].items():
        w(f"| {side} | {t['jobs']} | {t['tiny']} | {t['tiny_minutes']} | {t['all_minutes']} | "
          f"{t['tiny_setup_share']} | {fmt_s(t['tiny_queue_median'])} |\n")
    w("\n### core check + test: one leg failed alone\n\n| Side | Both legs ran | Both passed | "
      "Both failed | macOS failed, Linux passed | Linux failed, macOS passed |\n"
      "|---|---|---|---|---|---|\n")
    for side, c in d["core_test_legs"].items():
        w(f"| {side} | {c.get('both legs ran the test step', 0)} | {c.get('both passed', 0)} | "
          f"{c.get('both failed', 0)} | {c.get('macOS failed, Linux passed', 0)} | "
          f"{c.get('Linux failed, macOS passed', 0)} |\n")
    w("\n### Free disk after the clean-up step\n\n| Side | Workflow | Job | Step | Avail GB | "
      "Use % |\n|---|---|---|---|---|---|\n")
    seen = set()
    for x in d["disk"]:
        k = (x["side"], x["workflow"], x["job"], x["step"])
        if k in seen:
            continue
        seen.add(k)
        w(f"| {x['side']} | {x['workflow']} | {x['job']} | {(x['step'] or '')[:40]} | "
          f"{x['avail_gb']} | {x['use_pct']} |\n")
    if d.get("sccache_trial"):
        w("\n### sccache trial (core test binaries, GHA backend)\n\n| Run | Conclusion | Job | "
          "Build cold | Build warm | Stats after build 1 | Stats after build 2 |\n"
          "|---|---|---|---|---|---|---|\n")
        for t in d["sccache_trial"]:
            st = {k: "; ".join(f"{a} {b}" for a, b in v.items()) for k, v in t["stats"].items()}
            w(f"| {t['run']} | {t['conclusion']} | {fmt_s(t['run_s'])} | {fmt_s(t['build_cold_s'])} | "
              f"{fmt_s(t['build_warm_s'])} | {st.get('after build 1', '—')} | "
              f"{st.get('after build 2', '—')} |\n")
    w(f"\nDocker builds in workflows: {', '.join(d['docker']) or 'none'}.\n")
    return "".join(o)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--cache", required=True)
    f.add_argument("--jobs", type=int, default=8)
    f.add_argument("--logs-per-job", type=int, default=6)
    r = sub.add_parser("report")
    r.add_argument("--cache", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--hours", type=float, default=48)
    r.add_argument("--until", help="end of the window (ISO); default now")
    r.add_argument("--config-rev", default="HEAD",
                   help="git revision whose workflow files say which concurrency groups "
                        "cancelled main pushes")
    r.add_argument("--markdown")
    r.add_argument("--branch", help="only monorepo runs of this head branch (a PR's own runs)")
    r.add_argument("--full", action="store_true",
                   help="also write every job record and the superseded/duplicate run lists")
    a = ap.parse_args()
    {"fetch": fetch, "report": report}[a.cmd](a)


if __name__ == "__main__":
    main()
