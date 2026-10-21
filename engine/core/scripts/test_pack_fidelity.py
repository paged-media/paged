#!/usr/bin/env python3
"""Tests for pack-fidelity.py's licensed-font contract.

    python3 engine/core/scripts/test_pack_fidelity.py

A pack's fonts.sh may declare `LICENSED_FONTS=("Name=path")`: faces its
reference PDF was set in that the corpus may not ship. A pack missing one is
`unavailable` (neither passed nor failed) and is not rendered;
`PAGED_REQUIRE_FONTS=1` fails it. These tests build a throwaway corpus tree, so
they need neither the private corpus nor the engine binaries.
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pack_fidelity", HERE / "pack-fidelity.py")
pf = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(pf)

CLEAN_ENV = {
    k: v
    for k, v in os.environ.items()
    if k not in ("PAGED_REQUIRE_FONTS", "PAGED_FORCE_NO_LICENSED_FONTS", "PAGED_SKIP_LOG")
}


class Corpus:
    """A minimal corpus: one IDML pack whose fonts.sh says what the test needs."""

    def __init__(self, root: Path, fonts_sh: str, slug: str = "some-pack") -> None:
        self.root = root
        self.slug = slug
        (root / "fonts").mkdir(parents=True)
        (root / "fonts" / "Stand-In.ttf").write_bytes(b"\0\1\0\0")
        overrides = root / "config" / "overrides"
        (overrides / "_default").mkdir(parents=True)
        (overrides / "_default" / "fonts.sh").write_text('DEFAULT_FONT="$FONTS/Stand-In.ttf"\n')
        (overrides / slug).mkdir()
        (overrides / slug / "fonts.sh").write_text(fonts_sh)
        pack = root / "idml" / "packs" / slug
        pack.mkdir(parents=True)
        (pack / "template.idml").write_bytes(b"PK\3\4 not a real package")
        self.out = root / "out"

    def ctx(self, inspect: str = "/nonexistent/paged-inspect") -> dict:
        return {
            "corpus": self.root,
            "out": self.out,
            "inspect": Path(inspect),
            "diff": Path("/nonexistent/paged-diff"),
            "dpi": 72,
            "timeout": 30,
            "icc": None,
            "thresholds": {},
        }

    def run(self, **kw) -> dict:
        pack = {"id": f"idml/{self.slug}", "name": self.slug, "stage": "gated"}
        return pf.run_pack(pack, self.ctx(**kw))


def licensed_sh(path: str) -> str:
    return (
        'DEFAULT_FONT="$FONTS/Stand-In.ttf"\n'
        f'FACE="{path}"\n'
        'LICENSED_FONTS=("Licensed Sans=$FACE")\n'
        '[ -n "$FACE" ] || FACE="$FONTS/Stand-In.ttf"\n'
        'FONT_FLAGS=(--font-family "Body=$FACE" --font-family "Head/Bold=$FONTS/Stand-In.ttf")\n'
    )


class ReadFontsSh(unittest.TestCase):
    def test_reads_default_flags_and_licensed_fonts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            face = Path(tmp) / "with space" / "Licensed.otf"
            face.parent.mkdir()
            face.write_bytes(b"OTTO")
            c = Corpus(Path(tmp) / "corpus", licensed_sh(str(face)))
            default, flags, licensed = pf.font_flags(c.root, c.slug)
            self.assertEqual(default, str(c.root / "fonts" / "Stand-In.ttf"))
            self.assertEqual(
                flags,
                [
                    "--font-family",
                    f"Body={face}",
                    "--font-family",
                    f"Head/Bold={c.root / 'fonts' / 'Stand-In.ttf'}",
                ],
            )
            self.assertEqual(licensed, [("Licensed Sans", str(face))])

    def test_a_pack_without_the_declaration_has_no_licensed_fonts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            c = Corpus(Path(tmp), 'FONT_FLAGS=(--font-family "A=$FONTS/Stand-In.ttf")\n')
            default, flags, licensed = pf.font_flags(c.root, c.slug)
            self.assertEqual(default, str(c.root / "fonts" / "Inter.ttf"))
            self.assertEqual(len(flags), 2)
            self.assertEqual(licensed, [])


class MissingLicensed(unittest.TestCase):
    def test_present_empty_and_absent_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, CLEAN_ENV, clear=True):
            face = Path(tmp) / "F.otf"
            face.write_bytes(b"OTTO")
            licensed = [("Here", str(face)), ("Empty", ""), ("Gone", str(Path(tmp) / "no.otf"))]
            self.assertEqual(pf.missing_licensed(licensed), ["Empty", "Gone"])

    def test_force_no_licensed_fonts_hides_installed_faces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            face = Path(tmp) / "F.otf"
            face.write_bytes(b"OTTO")
            env = dict(CLEAN_ENV, PAGED_FORCE_NO_LICENSED_FONTS="1")
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(pf.missing_licensed([("Here", str(face))]), ["Here"])


class RunPack(unittest.TestCase):
    def test_missing_licensed_font_is_unavailable_and_not_rendered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            c = Corpus(Path(tmp), licensed_sh(""))
            skip_log = Path(tmp) / "skips.tsv"
            env = dict(CLEAN_ENV, PAGED_SKIP_LOG=str(skip_log))
            with mock.patch.dict(os.environ, env, clear=True):
                rec = c.run()
            self.assertEqual(rec["result"], "unavailable")
            self.assertEqual(rec["note"], "needs licensed font Licensed Sans")
            self.assertEqual(rec["pages_rendered"], 0)
            self.assertEqual(
                skip_log.read_text(),
                "pack-fidelity\tidml/some-pack\tFONTS\t"
                "unavailable: font: needs licensed font Licensed Sans\n",
            )
            self.assertIn("unavailable: font:", (c.out / c.slug / "test.log").read_text())

    def test_require_fonts_turns_unavailable_into_a_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            c = Corpus(Path(tmp), licensed_sh(""))
            with mock.patch.dict(os.environ, dict(CLEAN_ENV, PAGED_REQUIRE_FONTS="1"), clear=True):
                rec = c.run()
            self.assertEqual(rec["result"], "required-missing")
            self.assertEqual(rec["note"], "PAGED_REQUIRE_FONTS=1: needs licensed font Licensed Sans")

    def test_present_licensed_font_goes_on_to_render(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            face = Path(tmp) / "Licensed.otf"
            face.write_bytes(b"OTTO")
            c = Corpus(Path(tmp) / "corpus", licensed_sh(str(face)))
            with mock.patch.dict(os.environ, CLEAN_ENV, clear=True):
                # `false` stands in for paged-inspect: reaching it proves the
                # gate let the pack through.
                rec = c.run(inspect="/usr/bin/false")
            self.assertEqual(rec["result"], "render-error")

    def test_force_no_licensed_fonts_makes_a_present_face_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            face = Path(tmp) / "Licensed.otf"
            face.write_bytes(b"OTTO")
            c = Corpus(Path(tmp) / "corpus", licensed_sh(str(face)))
            env = dict(CLEAN_ENV, PAGED_FORCE_NO_LICENSED_FONTS="1")
            with mock.patch.dict(os.environ, env, clear=True):
                rec = c.run(inspect="/usr/bin/false")
            self.assertEqual(rec["result"], "unavailable")


if __name__ == "__main__":
    unittest.main()
