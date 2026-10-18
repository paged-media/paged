#!/usr/bin/env python3
"""B7: vi.resetModules + vi.doMock / vi.mock(P, async (orig) => ({ ...(await orig()), ... })) -> mock.module.

    python3 tooling/migration/vitest-domock-to-bun.py <file>...

bun:test has no per-test module reset, but `mock.module` re-patches a module
that is already loaded, in place (its live bindings change for every
importer). So the per-test fresh module graph vitest built becomes one
module instance per file whose mocked exports each helper re-patches:

    vi.resetModules();                                  (dropped)
    vi.doMock(P, async (orig) => ({
      ...(await orig<typeof import(P)>()),              ->  mock.module(P, () => ({
      key: value,                                             ...actualX,
    }));                                                      key: value,
                                                            }));

with `const actualX = await importActual(() => import(P));` once at the top
of the file, before anything mocks P. The later `await import(...)` of the
module under test loads it once and returns that instance afterwards. This
is right only where the modules involved keep no module-level state that a
test depends on being fresh; the reviewed diff says so per file.
"""

import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("v2b", HERE / "vitest-to-bun.py")
v2b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v2b)

DOMOCK = re.compile(
    r'vi\.(?:doMock|mock)\(\s*(?P<q>["\'])(?P<p>[^"\']+)(?P=q),\s*async\s*\(\s*(?P<o>\w+)\s*\)\s*=>\s*\(\{\s*'
    r'\.\.\.\(await (?P=o)(?:<[^>]*>)?\(\)\),?'
)
RESET = re.compile(r"^[ \t]*vi\.resetModules\(\);[ \t]*\n", re.M)
IMPORT_END = re.compile(r"^import\b[\s\S]*?[\"'];?[ \t]*$", re.M)


def var_for(path: str) -> str:
    base = path.rstrip("/").split("/")[-1]
    return "actual" + "".join(w[:1].upper() + w[1:] for w in re.split(r"[^A-Za-z0-9]+", base) if w)


def convert(src: str) -> tuple[str, list[str]]:
    paths: list[str] = []

    def rep(m):
        p = m.group("p")
        if p not in paths:
            paths.append(p)
        return f'mock.module("{p}", () => ({{\n    ...{var_for(p)},'

    out = DOMOCK.sub(rep, src)
    out = RESET.sub("", out)
    if not paths:
        return src, []
    ends = [m.end() for m in IMPORT_END.finditer(out)]
    at = ends[-1] if ends else 0
    decl = "\n\n// bun:test hoists no vi.mock and has no vi.doMock / vi.resetModules: the\n" \
           "// real exports are taken once, before anything is mocked, and mock.module\n" \
           "// patches the loaded module in place (every importer sees the change).\n" + \
           "".join(f'const {var_for(p)} = await importActual(() => import("{p}"));\n' for p in paths)
    out = out[:at] + decl.rstrip("\n") + out[at:]
    out = v2b.add_named(out, "bun:test", ["mock"])
    out = v2b.add_named(out, "@paged-media/test-kit", ["importActual"])
    out = v2b.drop_unused_vi(out)
    left = [x for x in ("vi.doMock(", "vi.resetModules(") if x in out]
    return out, left


def main():
    for f in sys.argv[1:]:
        p = Path(f)
        src = p.read_text()
        out, left = convert(src)
        if out != src:
            p.write_text(out)
        print(f, "converted" if out != src else "unchanged", ("LEFT: " + ", ".join(left)) if left else "")


if __name__ == "__main__":
    main()
