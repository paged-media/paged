/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The surface-conformance gate's own tests: the forms covers() is read in,
// the layer rules, the static evaluator on the table shapes the editor and
// the bundles register through, and the acknowledged-file ratchet. A gate
// that silently reads less than is there always passes, so each reader is
// pinned here against a fixture it must read in full.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layersOf, normaliseId, readCovers } from "./surface/covers-reader.mjs";
import { Evaluator, Pattern, force, plain } from "./surface/static-eval.mjs";
import { loadAcknowledged } from "./surface-coverage.mjs";

const fixture = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "surface-gate-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};

describe("covers() reader", () => {
  it("reads the TS forms: the kit's import and a local no-op, several ids, several lines", () => {
    const dir = fixture({
      "a/test/x.test.ts": `
        import { covers } from "@paged-media/test-kit";
        it("x", () => {
          covers("command:paged.editor.undo");
          covers(
            "panel:paged.layers",
            'setting:paged.tool.polygon.sides',
            \`menu:File/Open…\`,
          );
          // covers("command:in.a.comment") does not count
          const s = 'covers("command:in.a.string")';
        });`,
      "b/tests/y.spec.ts": `
        const covers = (..._ids: string[]): void => {};
        covers("cli:paged-node get");`,
    });
    const r = readCovers(dir, ["a/test/x.test.ts", "b/tests/y.spec.ts"]);
    expect(r.errors).toEqual([]);
    expect(r.calls.flatMap((c) => c.ids)).toEqual([
      "command:paged.editor.undo",
      "panel:paged.layers",
      "setting:paged.tool.polygon.sides",
      "menu:File/Open…",
      "cli:paged-node get",
    ]);
  });

  it("is an error, not a silent zero, for an argument it cannot read", () => {
    const dir = fixture({
      "t/test/z.test.ts": `
        const ID = "command:paged.editor.undo";
        covers(ID);
        covers(\`command:\${ID}\`);
        covers(...["command:x"]);
        covers();
        covers("widget:paged.layers");`,
    });
    const r = readCovers(dir, ["t/test/z.test.ts"]);
    expect(r.errors.map((e) => e.message.split(" (")[0].split(";")[0])).toEqual(
      [
        "covers() argument is not a string literal",
        "covers() argument is not a string literal",
        "covers() argument is not a string literal",
        "covers() with no ids",
        '"widget:paged.layers" is not <kind>:<id> with a known kind',
      ],
    );
  });

  it("reads the Rust forms: covers! (one line, several lines) and the comment", () => {
    const dir = fixture({
      "crates/c/tests/golden_cli.rs": `
        macro_rules! covers { ($($id:literal),+ $(,)?) => {}; }
        #[test]
        fn renders() {
            covers!("cli:paged render");
            covers!(
                "cli:paged read layers",
                "cli:paged read collection",
            );
            // covers: cli:paged inspect, cli:paged digest
            assert!(true);
        }`,
    });
    const r = readCovers(dir, ["crates/c/tests/golden_cli.rs"]);
    expect(r.errors).toEqual([]);
    expect(r.calls.flatMap((c) => c.ids)).toEqual([
      "cli:paged render",
      "cli:paged read layers",
      "cli:paged read collection",
      "cli:paged inspect",
      "cli:paged digest",
    ]);
    expect([...r.calls[0].layers].sort()).toEqual(["golden", "rust"]);
  });

  it("refuses a covers() outside a test file", () => {
    const dir = fixture({
      "src/feature.ts": `covers("command:paged.editor.undo");`,
    });
    const r = readCovers(dir, ["src/feature.ts"]);
    expect(r.calls).toEqual([]);
    expect(r.errors[0].message).toBe(
      "covers() in a file that is not a test file",
    );
  });

  it("with a candidate list, reads only the candidates for calls", () => {
    const dir = fixture({
      "p/test/a.test.ts": `covers("command:paged.editor.undo");`,
      "p/test/b.test.ts": `covers("command:paged.editor.redo");`,
    });
    const files = ["p/test/a.test.ts", "p/test/b.test.ts"];
    const r = readCovers(dir, files, {
      candidates: new Set(["p/test/a.test.ts"]),
      keepTexts: false,
    });
    expect(r.calls.flatMap((c) => c.ids)).toEqual([
      "command:paged.editor.undo",
    ]);
    expect(r.testFiles.sort()).toEqual(files);
    expect(r.texts.size).toBe(0);
  });

  it("normalises keybinding arrows", () => {
    expect(normaliseId("keybinding:cmd+z -> paged.editor.undo")).toEqual({
      kind: "keybinding",
      id: "cmd+z→paged.editor.undo",
    });
  });
});

describe("layers from the path", () => {
  const L = (f, text) => [...layersOf(f, text)].sort();
  it("one tier per file", () => {
    expect(L("apps/editor/packages/shell/test/x.test.ts")).toEqual(["unit"]);
    expect(
      L("apps/editor/apps/canvas/test/panels/layers.dom.test.tsx"),
    ).toEqual(["component"]);
    expect(L("apps/editor/apps/canvas/tests/headless/undo.test.ts")).toEqual([
      "headless",
    ]);
    expect(L("apps/editor/apps/canvas/tests/actions.spec.ts")).toEqual(["e2e"]);
    expect(L("apps/editor/apps/canvas/tests/e2e/menus.spec.ts")).toEqual([
      "e2e",
    ]);
    expect(L("engine/core/crates/paged-cli/tests/it/read.rs")).toEqual([
      "rust",
    ]);
  });
  it("tags: golden, script, gesture", () => {
    expect(L("engine/core/crates/paged-cli/tests/it/golden_read.rs")).toEqual([
      "golden",
      "rust",
    ]);
    expect(
      L("platform/extensions/packages/cli/test/cli.golden.spec.ts"),
    ).toEqual(["golden", "unit"]);
    expect(L("engine/core/crates/paged-script/tests/it/basics.rs")).toEqual([
      "rust",
      "script",
    ]);
    expect(L("apps/editor/apps/canvas/tests/script-console.spec.ts")).toEqual([
      "e2e",
      "script",
    ]);
    expect(L("apps/editor/packages/x/test/description.test.ts")).toEqual([
      "unit",
    ]);
    expect(
      L(
        "apps/editor/packages/tools/test/rect.test.ts",
        "await g.tool('r'); gestures(fake)",
      ),
    ).toEqual(["gesture", "unit"]);
  });
});

describe("the static evaluator", () => {
  const evalConst = (files, file, name) => {
    const dir = fixture(files);
    const ev = new Evaluator({ root: dir, resolvePackage: () => null });
    const program = ev.program(join(dir, file));
    for (const s of program.body) {
      const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
      if (d?.type === "VariableDeclaration")
        for (const v of d.declarations)
          if (v.id.name === name) return plain(ev.eval(v.init, new Map()));
    }
    throw new Error(`no ${name}`);
  };

  it("unrolls a table through .map, a local helper and an import", () => {
    const v = evalConst(
      {
        "ids.ts": `export const PREFIX = "media.paged.sheet.command";`,
        "menu.ts": `
          import { PREFIX as C } from "./ids";
          const ENTRIES: [string, string][] = [["Sheet/Sort range…", "sortRange"], ["Sheet/Add sheet", "addSheet"]];
          const cmd = (suffix: string) => \`\${C}.\${suffix}\`;
          export const ITEMS = ENTRIES.map(([path, suffix]) => ({ path, command: cmd(suffix) }));`,
      },
      "menu.ts",
      "ITEMS",
    );
    expect(v).toEqual([
      {
        path: "Sheet/Sort range…",
        command: "media.paged.sheet.command.sortRange",
      },
      {
        path: "Sheet/Add sheet",
        command: "media.paged.sheet.command.addSheet",
      },
    ]);
  });

  it("makes a pattern of what it cannot know, and a feature gate of a null branch", () => {
    const dir = fixture({
      "d.ts": `
        export function derive(panel: { id: string }) { return { id: \`paged.panel.show.\${panel.id}\` }; }
        const table = supports("x") ? { a: 1 } : null;
        export const A = table.a;`,
    });
    const ev = new Evaluator({ root: dir, resolvePackage: () => null });
    const program = ev.program(join(dir, "d.ts"));
    let tpl = null;
    let a = null;
    for (const s of program.body) {
      if (
        s.type === "ExportNamedDeclaration" &&
        s.declaration.type === "FunctionDeclaration"
      )
        tpl = s.declaration.body.body[0].argument.properties[0].value;
      if (
        s.type === "ExportNamedDeclaration" &&
        s.declaration.type === "VariableDeclaration"
      )
        a = s.declaration.declarations[0].init;
    }
    const [{ value }] = ev.evalAll(tpl);
    expect(value).toBeInstanceOf(Pattern);
    expect(value.glob).toBe("paged.panel.show.*");
    expect(force(ev.eval(a, new Map()))).toBe(1);
  });

  it("binds a free parameter through every call site", () => {
    const dir = fixture({
      "c.ts": `
        function build() {
          const cmd = (id: string, title: string) => ({ id, title, handler: () => 0 });
          return [cmd("paged.insert.textFrame", "Text frame"), cmd("paged.insert.line", "Line")];
        }`,
    });
    const ev = new Evaluator({ root: dir, resolvePackage: () => null });
    const program = ev.program(join(dir, "c.ts"));
    const arrow = program.body[0].body.body[0].declarations[0].init;
    const idNode = arrow.body.properties[0].value;
    expect(ev.evalAll(idNode).map((x) => x.value)).toEqual([
      "paged.insert.textFrame",
      "paged.insert.line",
    ]);
  });
});

describe("acknowledged files", () => {
  it("reads <origin>.<kind>.<clause>.json and refuses other names and clauses", () => {
    const dir = fixture({
      "host.menu.e2e.json": JSON.stringify({
        "menu:File/Open…":
          "a reason long enough to say what is missing and why",
      }),
      "plugin.command.unit.json": JSON.stringify({}),
      "host.panel.unit.json": JSON.stringify({}),
      "notes.json": JSON.stringify({}),
    });
    const { entries, problems } = loadAcknowledged(dir);
    expect(entries.map((e) => [e.origin, e.kind, e.clause, e.id])).toEqual([
      ["host", "menu", "e2e", "File/Open…"],
    ]);
    expect(problems.sort()).toEqual([
      'host.panel.unit.json: panel has no clause "unit"',
      "notes.json: not <host|plugin>.<kind>.<clause>.json",
    ]);
  });
});
