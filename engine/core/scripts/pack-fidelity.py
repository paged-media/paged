#!/usr/bin/env python3
"""The vendor-pack fidelity lane: render every IDML pack of the private corpus
and diff each page against the pack's InDesign reference PDF.

    python3 engine/core/scripts/pack-fidelity.py [<group>/<pack> ...]

The corpus is a tree of UNPACKED directories. A pack lives under its primary
format, `<corpus>/<group>/packs/<slug>/`, and carries `template.idml`
(the primary IDML) and, once InDesign exported one, `reference.pdf`. Nothing
here reads, expects or unpacks an archive: the source zips no longer exist,
and the corpus's own `harness/test.sh` failed every pack at its unpack step
("missing zip") before it rendered anything. This lane reads the directories
as they are and never writes into the corpus.

Selection follows the corpus's rules:

- Packs come from `<corpus>/config/manifest.json`: group `idml`, stage not
  `skip`. They are addressed by their namespaced id (`idml/<slug>`), never by
  the bare slug, which repeats across groups.
- A file is what its bytes say, not its extension: `template.idml` must be a
  ZIP (`PK`) and `reference.pdf` must start `%PDF`. A pack whose IDML is not
  a ZIP is INDD-only (awaiting an InDesign export) and is reported as such.

Per pack, as the corpus harness does: fonts from
`config/overrides/<slug>/fonts.sh` (else `_default/fonts.sh`), render through
`paged-inspect --render` at the DPI, rasterise the reference with `pdftoppm`,
both through one CMYK profile (Coated FOGRA39 unless PAGED_CMYK_PROFILE names
another; the render takes it as `--cmyk-profile`, overriding the profile the
document declares), `paged-diff` every page, and for a
`gated` pack check `config/fidelity-thresholds.json`.

Licensed fonts: a pack whose reference PDF was set in a face the corpus may
not ship declares it in its fonts.sh as `LICENSED_FONTS=("Name=path")`, the
path empty when this machine has none. A pack missing one is not rendered and
reports `unavailable` (`unavailable: font: needs licensed font <Name>`):
neither passed nor failed, because a stand-in measures the font swap, not the
renderer. `PAGED_REQUIRE_FONTS=1` fails it instead (exit 1, also in advisory
mode); `PAGED_FORCE_NO_LICENSED_FONTS=1` treats every licensed face as missing,
which proves that path on a machine that has them.

Environment:

    PAGED_CORPUS_DIR        corpus root (default: <repo root>/corpus)
    PAGED_REQUIRE_CORPUS=1  a missing corpus fails (exit 2) instead of exit 3
    PAGED_PACK_FIDELITY_OUT reports (default: <engine/core target>/pack-fidelity)
    PAGED_PACK_DPI          render + rasterise DPI (default 144)
    PAGED_PACK_JOBS         packs in parallel (default: half the CPUs)
    PAGED_PACK_TIMEOUT      seconds per render (default 900)
    PAGED_CMYK_PROFILE      CMYK profile for the render and pdftoppm (default: Adobe FOGRA39)
    PAGED_PACK_GATE=advisory  report gated failures but exit 0
    PAGED_REQUIRE_FONTS=1   a pack missing a licensed font fails instead of `unavailable`
    PAGED_FORCE_NO_LICENSED_FONTS=1  behave as if no licensed font were installed
    PAGED_SKIP_LOG          file every `unavailable` line is appended to
    CARGO_TARGET_DIR        where paged-inspect / paged-diff are built

Writes `<out>/<slug>/{pack.json,report.json,test.log}` and `<out>/summary.json`.
Exit 0 when every gated pack passes, 1 when one fails (or a required licensed
font is missing), 2 on bad input, 3 when the corpus is unavailable.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

CORE = Path(__file__).resolve().parent.parent
REPO = CORE.parent.parent
FOGRA39 = Path("/Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc")


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


def magic(path: Path, prefix: bytes) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(len(prefix)) == prefix
    except OSError:
        return False


def corpus_root() -> Path | None:
    raw = os.environ.get("PAGED_CORPUS_DIR") or str(REPO / "corpus")
    root = Path(raw).expanduser()
    if (root / "config" / "manifest.json").is_file() and (root / "idml" / "packs").is_dir():
        return root.resolve()
    return None


def select_packs(manifest: dict, wanted: list[str]) -> list[dict]:
    packs = [p for p in manifest["packs"] if (p.get("group") or "idml") == "idml"]
    for p in packs:
        p.setdefault("id", f"idml/{p['name']}")
    if not wanted:
        return [p for p in packs if p.get("stage") != "skip"]
    out = []
    for w in wanted:
        hits = [p for p in packs if p["id"] == w or p["name"] == w]
        if not hits:
            sys.exit(f"error: {w} is not an idml pack in the manifest")
        if len(hits) > 1:
            sys.exit(f"error: {w} is ambiguous ({', '.join(p['id'] for p in hits)}); pass the id")
        out.append(hits[0])
    return out


# Sources a fonts.sh and prints, NUL-separated: DEFAULT_FONT, the number of
# LICENSED_FONTS entries, those entries, then FONT_FLAGS. The canvas lane
# (apps/editor/apps/canvas/tests/fidelity/fonts.ts) reads the same layout.
FONTS_SH_READER = (
    'DEFAULT_FONT=""; FONT_FLAGS=(); LICENSED_FONTS=(); . "$1"; '
    'printf "%s\\0" "${DEFAULT_FONT:-$FONTS/Inter.ttf}" "${#LICENSED_FONTS[@]}" '
    '${LICENSED_FONTS[@]+"${LICENSED_FONTS[@]}"} ${FONT_FLAGS[@]+"${FONT_FLAGS[@]}"}'
)


def fonts_script(corpus: Path, slug: str) -> Path:
    overrides = corpus / "config" / "overrides"
    script = overrides / slug / "fonts.sh"
    return script if script.is_file() else overrides / "_default" / "fonts.sh"


def read_fonts_sh(script: Path, fonts_dir: Path) -> tuple[str, list[str], list[tuple[str, str]]]:
    """Source a bash fonts.sh: (DEFAULT_FONT, FONT_FLAGS, LICENSED_FONTS as (name, path))."""
    env = dict(os.environ, FONTS=str(fonts_dir))
    res = subprocess.run(
        ["bash", "-c", FONTS_SH_READER, "fonts", str(script)],
        env=env,
        capture_output=True,
        check=True,
    )
    parts = res.stdout.decode().split("\0")[:-1]
    count = int(parts[1])
    licensed = [tuple(e.split("=", 1)) if "=" in e else (e, "") for e in parts[2 : 2 + count]]
    return parts[0], parts[2 + count :], [(n.strip(), p.strip()) for n, p in licensed]


def font_flags(corpus: Path, slug: str) -> tuple[str, list[str], list[tuple[str, str]]]:
    """The pack's fonts.sh (else `_default`): default font, flags, licensed fonts."""
    return read_fonts_sh(fonts_script(corpus, slug), corpus / "fonts")


def missing_licensed(licensed: list[tuple[str, str]]) -> list[str]:
    """The declared licensed faces this machine lacks (all of them under
    PAGED_FORCE_NO_LICENSED_FONTS=1)."""
    forced = env_flag("PAGED_FORCE_NO_LICENSED_FONTS")
    return [name for name, path in licensed if forced or not path or not Path(path).is_file()]


def report_unavailable(pack_id: str, reason: str) -> str:
    """The test-resources line for a missing font, printed and appended to
    PAGED_SKIP_LOG (`<lane>\\t<test>\\tFONTS\\t<line>`)."""
    line = f"unavailable: font: {reason}"
    log = os.environ.get("PAGED_SKIP_LOG")
    if log:
        try:
            with open(log, "a") as f:
                f.write(f"pack-fidelity\t{pack_id}\tFONTS\t{line}\n")
        except OSError as e:
            print(f"warning: could not append to PAGED_SKIP_LOG={log}: {e}", file=sys.stderr)
    return line


def cmyk_profile() -> Path | None:
    raw = os.environ.get("PAGED_CMYK_PROFILE")
    if raw:
        return Path(raw)
    return FOGRA39 if FOGRA39.is_file() else None


def gate(spec: dict | None, pages: list[dict]) -> dict:
    if spec is None:
        return {"passed": True, "skipped": True, "reason": "not in fidelity-thresholds.json"}
    limit = spec.get("max_pages_with_pdf", 999)
    failures = []
    for p in (p for p in pages if p["page"] <= limit):
        v = []
        if p["mean_de"] > spec["max_mean_de"]:
            v.append(f"meanΔE {p['mean_de']:.3f} > {spec['max_mean_de']}")
        if p["p99_de"] > spec["max_p99_de"]:
            v.append(f"p99ΔE {p['p99_de']:.3f} > {spec['max_p99_de']}")
        if p["ssim"] < spec["min_ssim"]:
            v.append(f"ssim {p['ssim']:.4f} < {spec['min_ssim']}")
        if v:
            failures.append({"page": p["page"], "violations": v})
    return {"passed": not failures, "failures": failures}


def run_pack(pack: dict, ctx: dict) -> dict:
    corpus, out_root = ctx["corpus"], ctx["out"]
    group, slug = pack["id"].split("/", 1)
    src = corpus / group / "packs" / slug
    out = out_root / slug
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    log = (out / "test.log").open("w")
    rec = {
        "id": pack["id"],
        "stage": pack.get("stage", "smoke"),
        "typography": pack.get("typography"),
        "result": "ok",
        "note": "",
        "pages_rendered": 0,
        "pages_diffed": 0,
        "pages_passing": 0,
        "worst_mean_de": None,
        "worst_p99_de": None,
        "worst_ssim": None,
        "mean_mean_de": None,
        "seconds": 0.0,
    }
    started = time.monotonic()

    def done(result: str, note: str) -> dict:
        rec["result"], rec["note"] = result, note
        rec["seconds"] = round(time.monotonic() - started, 2)
        (out / "pack.json").write_text(json.dumps(rec, indent=2))
        log.close()
        return rec

    idml = src / "template.idml"
    if not src.is_dir():
        return done("missing", f"no directory {group}/packs/{slug}")
    if not idml.is_file():
        return done("no-idml", "no template.idml (INDD-only, awaiting InDesign export)")
    if not magic(idml, b"PK"):
        return done("no-idml", "template.idml is not a ZIP (INDD-only, awaiting InDesign export)")
    pdf = src / "reference.pdf"
    have_pdf = magic(pdf, b"%PDF")

    default_font, flags, licensed = font_flags(corpus, slug)
    missing = missing_licensed(licensed)
    if missing:
        reason = f"needs licensed font {', '.join(missing)}"
        line = report_unavailable(pack["id"], reason)
        if env_flag("PAGED_REQUIRE_FONTS"):
            log.write(f"{line} — PAGED_REQUIRE_FONTS=1 is set, so the pack fails\n")
            return done("required-missing", f"PAGED_REQUIRE_FONTS=1: {reason}")
        log.write(f"{line} (skipped, not passed; PAGED_REQUIRE_FONTS=1 fails it)\n")
        return done("unavailable", reason)
    cmd = [str(ctx["inspect"]), str(idml), "--render", str(out / "cand.png")]
    cmd += ["--default-font", default_font, *flags, "--dpi", str(ctx["dpi"])]
    # The reference is rasterised through `icc` below, so the render goes
    # through it too. Left alone, the renderer takes the document's
    # declared profile (U.S. Web Coated SWOP, say) while pdftoppm reads the
    # PDF's DeviceCMYK through FOGRA39, and every flat CMYK area differs
    # by the two profiles: a 30 % black measured meanΔE 4.3 on its own.
    if ctx["icc"]:
        cmd += ["--cmyk-profile", str(ctx["icc"])]
    try:
        r = subprocess.run(
            cmd, cwd=CORE, stdout=log, stderr=subprocess.STDOUT, timeout=ctx["timeout"]
        )
    except subprocess.TimeoutExpired:
        return done("render-error", f"paged-inspect timed out after {ctx['timeout']} s")
    if r.returncode != 0:
        return done("render-error", f"paged-inspect exited {r.returncode}")
    single = out / "cand.png"
    if single.exists():
        single.rename(out / "cand-001.png")
    cands = sorted(out.glob("cand-*.png"))
    rec["pages_rendered"] = len(cands)
    if not cands:
        return done("render-error", "no candidate PNGs produced")

    pages: list[dict] = []
    if have_pdf:
        icc = ctx["icc"]
        raster = ["pdftoppm", *(["-defaultcmykprofile", str(icc)] if icc else [])]
        raster += ["-r", str(ctx["dpi"]), "-png", str(pdf), str(out / "ref")]
        subprocess.run(raster, stdout=log, stderr=subprocess.STDOUT, check=False)
        refs = {int(p.stem.split("-")[-1]): p for p in out.glob("ref-*.png")}
        for cand in cands:
            n = int(cand.stem.split("-")[-1])
            ref = refs.get(n)
            if ref is None:
                continue
            heat = out / f"heat-{n:03d}.png"
            d = subprocess.run(
                [str(ctx["diff"]), str(ref), str(cand), "--json", "--heatmap", str(heat)],
                capture_output=True,
                text=True,
            )
            line = d.stdout.strip().splitlines()[-1] if d.stdout.strip() else ""
            if not line:
                log.write(f"paged-diff gave no output for page {n}: {d.stderr}\n")
                continue
            pages.append({"page": n, **json.loads(line)})
        # Keep the worst page's heatmap and the report; the PNGs are rebuilt
        # by re-running one pack.
        worst = max(pages, key=lambda p: p["mean_de"], default=None)
        for f in out.glob("*.png"):
            if not (worst and f.name == f"heat-{worst['page']:03d}.png"):
                f.unlink()
    else:
        for f in out.glob("cand-*.png"):
            f.unlink()
    (out / "report.json").write_text(json.dumps(pages, indent=1))

    if pages:
        rec["pages_diffed"] = len(pages)
        rec["pages_passing"] = sum(1 for p in pages if p.get("passes"))
        rec["worst_mean_de"] = max(p["mean_de"] for p in pages)
        rec["worst_p99_de"] = max(p["p99_de"] for p in pages)
        rec["worst_ssim"] = min(p["ssim"] for p in pages)
        rec["mean_mean_de"] = round(statistics.fmean(p["mean_de"] for p in pages), 4)

    if rec["stage"] == "gated":
        if not have_pdf:
            return done("gated-failed", "gated but no reference PDF: nothing to measure")
        if not pages:
            return done("gated-failed", "gated but 0 pages paired with the reference")
        g = gate(ctx["thresholds"].get(slug), pages)
        (out / "gate.json").write_text(json.dumps(g, indent=2))
        if not g["passed"]:
            return done("gated-failed", f"{len(g['failures'])} page(s) over budget")
    elif not have_pdf:
        return done("ok", "no reference PDF: rendered only")
    elif not pages:
        return done("error", "0 pages paired with the reference")
    return done("ok", "")


def fmt(v: float | None, spec: str) -> str:
    return "-" if v is None else format(v, spec)


def main() -> int:
    wanted = sys.argv[1:]
    if any(a in ("-h", "--help") for a in wanted):
        print(__doc__)
        return 0
    corpus = corpus_root()
    if corpus is None:
        print("unavailable: private corpus: set PAGED_CORPUS_DIR to the corpus root")
        return 2 if env_flag("PAGED_REQUIRE_CORPUS") else 3
    if shutil.which("pdftoppm") is None:
        print("error: pdftoppm not found (poppler)", file=sys.stderr)
        return 2

    target = Path(os.environ.get("CARGO_TARGET_DIR") or CORE / "target")
    print("==> build paged-inspect + paged-diff (release)", flush=True)
    subprocess.run(
        ["cargo", "build", "--release", "-q", "-p", "paged-renderer", "--bin", "paged-inspect"]
        + ["-p", "paged-fidelity", "--bin", "paged-diff"],
        cwd=CORE,
        check=True,
    )

    manifest = json.loads((corpus / "config" / "manifest.json").read_text())
    thresholds_path = corpus / "config" / "fidelity-thresholds.json"
    thresholds = {}
    if thresholds_path.is_file():
        thresholds = {f["name"]: f for f in json.loads(thresholds_path.read_text())["fixtures"]}
    packs = select_packs(manifest, wanted)
    out = Path(os.environ.get("PAGED_PACK_FIDELITY_OUT") or target / "pack-fidelity")
    out.mkdir(parents=True, exist_ok=True)
    icc = cmyk_profile()
    if icc is None:
        print("warning: no Coated FOGRA39 profile; pdftoppm uses its SWOP default", flush=True)
    ctx = {
        "corpus": corpus,
        "out": out,
        "inspect": target / "release" / "paged-inspect",
        "diff": target / "release" / "paged-diff",
        "dpi": int(os.environ.get("PAGED_PACK_DPI", "144")),
        "timeout": int(os.environ.get("PAGED_PACK_TIMEOUT", "900")),
        "icc": icc,
        "thresholds": thresholds,
    }
    jobs = int(os.environ.get("PAGED_PACK_JOBS") or max(1, (os.cpu_count() or 2) // 2))
    print(f"==> {len(packs)} pack(s), {jobs} in parallel → {out}", flush=True)

    started = time.monotonic()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(run_pack, p, ctx): p for p in packs}
        for fut in concurrent.futures.as_completed(futures):
            try:
                r = fut.result()
            except Exception as e:  # a harness bug in one pack must not end the run
                p = futures[fut]
                r = {"id": p["id"], "stage": p.get("stage", "smoke"), "result": "error"}
                r["note"] = f"harness: {e!r}"
            results.append(r)
            print(f"  {r['result']:<13} {r['id']}  {r.get('note', '')}", flush=True)
    results.sort(key=lambda r: r["id"])
    wall = round(time.monotonic() - started, 1)

    diffed = [r for r in results if r.get("pages_diffed")]
    by = lambda key: sum(1 for r in results if r["result"] == key)  # noqa: E731
    gated = [r for r in results if r["stage"] == "gated"]
    summary = {
        "corpus_packs_selected": len(results),
        "rendered": sum(1 for r in results if r.get("pages_rendered")),
        "no_idml": by("no-idml"),
        "missing": by("missing"),
        "render_errors": by("render-error"),
        "errors": by("error"),
        "with_reference": len(diffed),
        "pages_rendered": sum(r.get("pages_rendered", 0) for r in results),
        "pages_diffed": sum(r["pages_diffed"] for r in diffed),
        "pages_passing_diff": sum(r["pages_passing"] for r in diffed),
        "gated": len(gated),
        "gated_passed": sum(1 for r in gated if r["result"] == "ok"),
        "gated_failed": sum(1 for r in gated if r["result"] not in ("ok", "unavailable")),
        # Neither passed nor failed: a licensed font the pack declares is missing.
        "unavailable": by("unavailable"),
        "required_missing": by("required-missing"),
        "median_pack_mean_de": (
            round(statistics.median(r["mean_mean_de"] for r in diffed), 4) if diffed else None
        ),
        "median_pack_worst_ssim": (
            round(statistics.median(r["worst_ssim"] for r in diffed), 4) if diffed else None
        ),
        "dpi": ctx["dpi"],
        "cmyk_profile": "FOGRA39" if icc and icc.name == FOGRA39.name else (str(icc) if icc else None),
        "seconds": wall,
    }
    (out / "summary.json").write_text(json.dumps({**summary, "packs": results}, indent=2))

    print()
    print(f"{'pack':<52} {'stage':<6} {'result':<13} {'pages':>5} {'pass':>4} "
          f"{'meanΔE':>7} {'worstΔE':>7} {'p99ΔE':>7} {'ssim':>6}")
    for r in results:
        print(
            f"{r['id']:<52} {r['stage']:<6} {r['result']:<13} {r.get('pages_diffed', 0):>5} "
            f"{r.get('pages_passing', 0):>4} {fmt(r.get('mean_mean_de'), '7.3f')} "
            f"{fmt(r.get('worst_mean_de'), '7.3f')} {fmt(r.get('worst_p99_de'), '7.2f')} "
            f"{fmt(r.get('worst_ssim'), '6.3f')}"
        )
    print()
    print("summary:", json.dumps(summary))
    for r in results:
        if r["result"] == "unavailable":
            print(f"unavailable: font: {r['note']} ({r['id']}; skipped, not passed)")
    if summary["required_missing"]:
        # Advisory mode excuses budgets, not an input the run demanded.
        return 1
    failed = summary["gated_failed"] > 0
    if failed and os.environ.get("PAGED_PACK_GATE") == "advisory":
        print("==> gated failures; advisory mode, exiting 0")
        return 0
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
