#!/usr/bin/env python3
"""fonts-full: fonts.seed.py with every glyph embedded."""
import runpy, sys
from pathlib import Path

sys.argv.append("full")
runpy.run_path(str(Path(__file__).with_name("fonts.seed.py")), run_name="__main__")
