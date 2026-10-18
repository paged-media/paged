#!/usr/bin/env python3
"""The mechanical half of B7's vitest -> bun:test flip (docs/migration/bun-test.md).

    python3 tooling/migration/vitest-to-bun.py <package dir>...

For every source file under each package (node_modules/dist skipped) that
imports "vitest":

- `from "vitest"` -> `from "bun:test"`;
- `it.fails` / `test.fails` -> `.failing`; `.runIf(` -> `.if(`;
- `vi.setConfig({ testTimeout: N })` -> `setDefaultTimeout(N)` (bun:test);
- `vi.waitFor`, `vi.stubGlobal`, `vi.unstubAllGlobals` -> the test kit's
  `waitFor`, `stubGlobal`, `unstubAllGlobals`;
- `vi.advanceTimersByTimeAsync(x)` -> the test kit's
  `advanceTimersByTimeAsync(vi, x)`;

and adds the imports these need. It REFUSES nothing and prints, per file,
what it left for a person: expect.poll, vi.mock factories that take importOriginal,
vi.doMock / vi.resetModules, test-context parameters (ctx.skip), vitest
environments and bench files. Those are the reviewed refactors.
"""

import re
import sys
from pathlib import Path

KIT = "@paged-media/test-kit"
SKIP = {"node_modules", "dist", "target", ".git"}


def files(pkg: Path):
    for p in pkg.rglob("*"):
        if any(part in SKIP for part in p.relative_to(pkg).parts):
            continue
        if p.is_file() and re.search(r"\.(m|c)?[jt]sx?$", p.name):
            yield p


def add_named(src: str, module: str, names: list[str]) -> str:
    """Add `names` to the (first) named import from `module`, or a new import line."""
    if not names:
        return src
    rx = re.compile(r'import\s*\{([^}]*)\}\s*from\s*"' + re.escape(module) + r'";?')
    m = rx.search(src)
    if m:
        have = [n.strip() for n in m.group(1).split(",") if n.strip()]
        merged = have + [n for n in names if n not in have]
        multiline = "\n" in m.group(1)
        body = (",\n  ".join(merged)).join(["\n  ", ",\n"]) if multiline else " " + ", ".join(merged) + " "
        return src[: m.start()] + f'import {{{body}}} from "{module}";' + src[m.end():]
    # after the bun:test import
    anchor = re.search(r'import[^;]*from\s*"bun:test";?\n', src)
    line = f'import {{ {", ".join(names)} }} from "{module}";\n'
    if anchor:
        return src[: anchor.end()] + line + src[anchor.end():]
    return line + src


def drop_unused_vi(src: str) -> str:
    """Remove `vi` from the bun:test import once nothing else uses it."""
    m = re.search(r'import\s*\{([^}]*)\}\s*from\s*"bun:test";?', src)
    if not m:
        return src
    rest = src[: m.start()] + src[m.end():]
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    code = re.sub(r"/\*[\s\S]*?\*/|//[^\n]*", "", rest)
    if "vi" not in names or re.search(r"\bvi\b", code):
        return src
    names.remove("vi")
    multiline = "\n" in m.group(1)
    body = (",\n  ".join(names)).join(["\n  ", ",\n"]) if multiline else " " + ", ".join(names) + " "
    return src[: m.start()] + f'import {{{body}}} from "bun:test";' + src[m.end():]


def convert(src: str) -> tuple[str, list[str]]:
    notes = []
    out = re.sub(r'from\s*"vitest"', 'from "bun:test"', src)
    out = re.sub(r"\b(it|test)\.fails\b", r"\1.failing", out)
    out = re.sub(r"\.runIf\(", ".if(", out)

    bun_names, kit_names = [], []

    def set_config(m):
        body = m.group(1)
        t = re.search(r"testTimeout\s*:\s*([\w_.]+)", body)
        if not t:
            notes.append(f"vi.setConfig without testTimeout: {m.group(0)}")
            return m.group(0)
        rest = re.sub(r"(testTimeout|hookTimeout)\s*:\s*[\w_.]+\s*,?", "", body).strip()
        if rest:
            notes.append(f"vi.setConfig keys dropped: {rest}")
        bun_names.append("setDefaultTimeout")
        return f"setDefaultTimeout({t.group(1)})"

    out = re.sub(r"vi\.setConfig\(\s*\{([^}]*)\}\s*\)", set_config, out)

    for old, new in (("vi.waitFor(", "waitFor("), ("vi.stubGlobal(", "stubGlobal("), ("vi.unstubAllGlobals(", "unstubAllGlobals(")):
        if old in out:
            out = out.replace(old, new)
            kit_names.append(new[:-1])
    if "vi.advanceTimersByTimeAsync(" in out:
        out = out.replace("vi.advanceTimersByTimeAsync(", "advanceTimersByTimeAsync(vi, ")
        kit_names.append("advanceTimersByTimeAsync")

    out = add_named(out, "bun:test", sorted(set(bun_names)))
    out = add_named(out, KIT, sorted(set(kit_names)))
    out = drop_unused_vi(out)

    for pat, why in (
        (r"vi\.mock\([^)]*,\s*async\s*\(\s*\w+", "vi.mock factory takes importOriginal"),
        (r"\bimportOriginal\b|vi\.importActual", "importOriginal / importActual"),
        (r"vi\.doMock|vi\.resetModules", "vi.doMock / vi.resetModules"),
        (r"\b(it|test)\([^,]+,\s*(async\s*)?\(\s*\{?\s*\w+", "test callback takes a context/done parameter"),
        (r"\b(ctx|context)\.skip\(", "ctx.skip()"),
        (r"@vitest-environment", "vitest environment docblock"),
        (r"\bbench\(", "vitest bench"),
        (r"waitFor\(", "waitFor: pass { clock: vi } if fake timers are on"),
        (r"expect\.poll\(", "expect.poll"),
    ):
        if re.search(pat, out):
            notes.append(why)
    return out, notes


def main():
    for arg in sys.argv[1:]:
        pkg = Path(arg)
        for p in sorted(files(pkg)):
            src = p.read_text()
            if not re.search(r'from\s*"vitest"', src):
                continue
            out, notes = convert(src)
            if out != src:
                p.write_text(out)
            rel = p.relative_to(pkg)
            for n in notes:
                print(f"{pkg}/{rel}: {n}")


if __name__ == "__main__":
    main()
