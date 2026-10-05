#!/usr/bin/env python3
"""Local fidelity check (maintainer tool, not CI): every corpus deck through
pptx2idml and the engine's CPU renderer, each slide against PowerPoint's own
PDF (ADR 705), scored with the engine's paged-diff (SSIM, mean ΔE2000).

  python3 scripts/fidelity-local.py [--core <core checkout with release
      paged-inspect + paged-diff>] [--dpi 48] [--deck <name>] [--out <dir>]

Fonts: the families each deck names are registered from the same files
PowerPoint draws with on this Mac (its bundled fonts, Office's cloud-font
cache, the user and system font folders). A family PowerPoint does not have
is drawn by PowerPoint in Calibri, so the engine gets Calibri for it too.
"""
import argparse, glob, json, os, re, subprocess, sys, tempfile, statistics

ap = argparse.ArgumentParser()
ap.add_argument("--core", default=os.path.expanduser("~/paged/core-tools"))
ap.add_argument("--corpus", default=os.path.expanduser("~/paged/corpus"))
ap.add_argument("--dpi", default="48")
ap.add_argument("--deck", default=None)
ap.add_argument("--out", default=None)
a = ap.parse_args()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inspect = os.path.join(a.core, "target/release/paged-inspect")
diff = os.path.join(a.core, "target/release/paged-diff")
out = a.out or tempfile.mkdtemp(prefix="slide-fidelity-")

FONT_DIRS = ["/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts",
             os.path.expanduser("~/Library/Group Containers/UBF8T346G9.Office/FontCache/4/CloudFonts"),
             os.path.expanduser("~/Library/Fonts"), "/Library/Fonts"]
fonts = {}  # (family, style) -> path
for d in FONT_DIRS:
    for p in glob.glob(d + "/**/*.[ot]t[fc]", recursive=True):
        q = subprocess.run(["fc-query", "-f", "%{family}|%{style}\n", p], capture_output=True, text=True).stdout.splitlines()
        # A variable font reports one line per named instance, and every
        # face lists its typographic and its legacy names ("Work Sans" /
        # "SemiBold" and "Work Sans SemiBold" / "Regular"); decks use
        # either, so each pairing maps to the file.
        for line in q:
            fams, _, styles = line.partition("|")
            fams, styles = fams.split(","), styles.split(",")
            fonts.setdefault((fams[0], styles[0]), p)
            for fam in fams[1:]:
                for style in styles[1:] or styles:
                    fonts.setdefault((fam, style), p)
def face(fam, style):
    return fonts.get((fam, style)) or fonts.get((fam, {"Bold": "Bold", "Italic": "Italic"}.get(style, style)))

subprocess.run(["cargo", "build", "-q", "-p", "slide-idml", "--example", "pptx2idml"], cwd=ROOT, check=True)
conv = os.path.join(ROOT, "target/debug/examples/pptx2idml")
summary = {}
for deck in sorted(glob.glob(a.corpus + "/pptx/packs/*/primary.pptx")):
    pack = os.path.basename(os.path.dirname(deck))
    if a.deck and a.deck not in pack:
        continue
    oracle = os.path.join(os.path.dirname(deck), "oracle/primary.ppt.pdf")
    if not os.path.exists(oracle):
        continue
    d = os.path.join(out, pack)
    os.makedirs(d + "/ours", exist_ok=True)
    os.makedirs(d + "/ppt", exist_ok=True)
    r = subprocess.run([conv, deck, d + "/deck.idml"], capture_output=True, text=True)
    fams = json.loads(re.search(r"fonts (\[.*\])", r.stderr).group(1).replace("'", '"')) if "fonts [" in r.stderr else []
    args = [inspect, d + "/deck.idml", "--render", d + "/ours/page.png", "--dpi", a.dpi]
    for fam in fams:
        for style in ["Regular", "Bold", "Italic", "Bold Italic"]:
            p = face(fam, style) or face("Calibri", style)
            if p:
                args += ["--font-family", f"{fam}{'' if style == 'Regular' else '/' + style}={p}"]
    if face("Calibri", "Regular"):
        args += ["--default-font", face("Calibri", "Regular")]
    subprocess.run(args, capture_output=True)
    subprocess.run(["pdftoppm", "-r", a.dpi, "-png", oracle, d + "/ppt/p"], check=True)
    ours = sorted(glob.glob(d + "/ours/page-*.png"))
    ppt = sorted(glob.glob(d + "/ppt/p-*.png"))
    scores = []
    for i, (o, p) in enumerate(zip(ours, ppt)):
        rep = json.loads(subprocess.run([diff, "--json", p, o], capture_output=True, text=True).stdout or "{}")
        ssim = rep.get("ssim") if "ssim" in rep else rep.get("ssim_mean")
        de = rep.get("mean_de")
        scores.append((i + 1, ssim, de))
    ss = [s for _, s, _ in scores if s is not None]
    summary[pack] = {"slides": len(scores), "median_ssim": statistics.median(ss) if ss else None,
                     "min_ssim": min(ss) if ss else None, "per_slide": scores}
    print(f"{pack}: {len(scores)} slides, median SSIM {summary[pack]['median_ssim']:.3f}, min {summary[pack]['min_ssim']:.3f}" if ss else f"{pack}: no scores")
json.dump(summary, open(os.path.join(out, "summary.json"), "w"), indent=1)
print("out:", out)
