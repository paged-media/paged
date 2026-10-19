/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// EVERY built-in panel, enumerated from the registry the app boots with
// (`BUILT_IN_PANELS`), so a panel added there is tested here the day it
// lands, and fails here until it has its own test file.
//
//   · the lane has a test for it: some `*.dom.test.tsx` in this folder
//     calls `covers("panel:<id>")` (the gate counts the same calls);
//   · it mounts in the three base states (no document, a blank page, the
//     rich scene with a frame selected) without a render error and
//     without a request the engine could not dispatch;
//   · the basics of reach: every control has a role and an accessible
//     name and can be reached with Tab (`a11y.ts`).
//
// This file asserts the whole registry at once, so it calls no
// `covers()` (the gate reads string literals only); each panel's own
// file does.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BUILT_IN_PANELS } from "../../src/panels/built-in-panels";
import { a11yProblems } from "./a11y";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

/** The panels the lane has no test file for yet. It only shrinks; a new
 *  panel never joins it (it lands with its test). */
const NOT_YET_TESTED: readonly string[] = [
  "paged.pages",
  "paged.export-center",
  "paged.preflight",
  "paged.separations",
  "paged.publication-health",
  "paged.stories",
  "paged.comments",
  "paged.component-library",
  "paged.document-map",
  "paged.outputs",
  "paged.data-source",
  "paged.data-grid",
  "paged.story-inspector",
  "paged.output-readiness",
  "paged.review-inspector",
  "paged.export-inspector",
  "paged.links",
  "paged.conditions",
  "paged.condition-sets",
  "paged.color-groups",
  "paged.ink-manager",
  "paged.color-settings",
  "paged.style-options",
  "paged.object-options",
  "paged.document-setup",
  "paged.margins-columns",
  "paged.swatch-options",
  "paged.gradient-options",
  "paged.text-variables",
  "paged.color-group-options",
  "paged.numbering-list-options",
  "paged.condition-options",
  "paged.master-options",
  "paged.text-fields",
  "paged.section-options",
  "paged.guides",
  "paged.articles",
  "paged.hyperlinks",
  "paged.bookmarks",
  "paged.cross-references",
  "paged.index",
  "paged.pages-list",
  "paged.spreads",
  "paged.master-pages",
  "paged.cell-styles",
  "paged.table-styles",
  "paged.fonts",
  "paged.align",
  "paged.pathfinder",
  "paged.outline",
  "paged.tree",
  "paged.paragraph-styles",
  "paged.character-styles",
  "paged.object-styles",
  "paged.swatches",
  "paged.schema-list-demo",
  "paged.schema-tree-demo",
  "paged.color",
  "paged.color-wheel",
  "paged.gradients",
  "paged.object-transform",
  "paged.text-frame-options",
  "paged.text-wrap",
  "paged.frame-fitting",
  "paged.effects",
  "paged.layers",
  "paged.attributes",
  "paged.ai-assistant",
  "paged.repl",
  "paged.script-editor",
  "paged.actions",
  "paged.keyboard-shortcuts",
  "paged.problems",
  "paged.journal",
  "paged.library",
  "paged.table",
  "paged.tabs",
  "paged.glyphs",
  "paged.bullets-numbering",
  "paged.anchored",
  "paged.object-export",
  "paged.export-tagging",
];

/** `panel:<id>` literals the lane's files assert, by file. */
function coveredPanels(): Map<string, string[]> {
  const dir = import.meta.dir;
  const out = new Map<string, string[]>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".dom.test.tsx")) continue;
    // Comments name the convention (`covers("panel:<id>")`); only code
    // counts, as at the gate.
    const src = readFileSync(join(dir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const call of src.matchAll(/covers\(([^)]*)\)/g)) {
      for (const m of call[1].matchAll(/"panel:([^"]+)"/g)) {
        out.set(m[1], [...(out.get(m[1]) ?? []), file]);
      }
    }
  }
  return out;
}

/**
 * The controls that break the basics today, by the primitive that renders
 * them (one fix in the primitive fixes every panel that uses it). The
 * signature is `a11yProblems`'s line for such a control.
 */
const A11Y_KNOWN: ReadonlyArray<{ id: string; signature: string }> = [
  // NumberInput (packages/ui): the field's label is a sibling span in the
  // PropertyField row and the input gets an aria-label only when the
  // caller passes one; the scrub label beside it is aria-hidden.
  {
    id: "PN-5",
    signature: "no accessible name: <input role=textbox .flex-1.min-w-0>",
  },
  // KitSelect (packages/ui): a native select with no label association.
  {
    id: "PN-6",
    signature: "no accessible name: <select role=combobox .w-full.h-[30px]>",
  },
  // The shell's Input (components/ui/input.tsx) in text PropertyFields.
  {
    id: "PN-7",
    signature: "no accessible name: <input role=textbox .flex.w-full>",
  },
  // The switch leaf (catalog/leaves.tsx) and the concept-kit switch.
  {
    id: "PN-8",
    signature: "no accessible name: <button role=switch .relative.w-[30px]>",
  },
  // The style apply-list select (cell, table, paragraph, character and
  // object styles: components/cockpit/apply-list.tsx and the two table
  // style panels).
  {
    id: "PN-9",
    signature: "no accessible name: <select role=combobox .h-[30px].w-full>",
  },
  // The options panels' target pickers (object-options-panels.tsx).
  {
    id: "PN-10",
    signature: "no accessible name: <select role=combobox .h-[28px].w-full>",
  },
  // Icon-only row toggles in ListRows (visibility / lock eyes).
  {
    id: "PN-11",
    signature:
      "no accessible name: <button role=button .shrink-0.cursor-pointer>",
  },
  // Icon-only segments in a radio-style toggle group (reference point,
  // fitting).
  { id: "PN-12", signature: "no accessible name: <button role=radio>" },
  // The colour picker's hex field (ColorPicker) and the colour inputs.
  { id: "PN-13", signature: "no accessible name: <input role=textbox>" },
  // Swatch Options' name field.
  {
    id: "PN-14",
    signature: "no accessible name: <input role=textbox .h-[28px].w-full>",
  },
  // The gradient editor's stop colour and location.
  {
    id: "PN-15",
    signature: "no accessible name: <select role=combobox .flex-1.min-w-0>",
  },
  {
    id: "PN-15",
    signature: "no accessible name: <input role=spinbutton .w-[52px].text-xs>",
  },
  // One-off fields with no label and no placeholder: the script editor's
  // source, the Actions name field, the bullet character.
  {
    id: "PN-16",
    signature: "no accessible name: <textarea role=textbox .font-mono.text-xs>",
  },
  { id: "PN-16", signature: "no accessible name: <input role=input>" },
  {
    id: "PN-16",
    signature: "no accessible name: <input role=textbox .w-full.min-w-0>",
  },
];

/** Which of those each panel shows today (the rich scene, a rectangle
 *  selected). A panel listed here has an expected-failure reach test; the
 *  row goes when the panel passes. */
const A11Y_FINDINGS: Record<string, readonly string[]> = {
  "paged.actions": ["PN-16"],
  "paged.align": ["PN-6", "PN-8"],
  "paged.bullets-numbering": ["PN-6", "PN-16"],
  "paged.cell-styles": ["PN-9"],
  "paged.character": ["PN-5", "PN-6"],
  "paged.character-styles": ["PN-9"],
  "paged.color": ["PN-5", "PN-6", "PN-13"],
  "paged.color-group-options": ["PN-7", "PN-10"],
  "paged.color-wheel": ["PN-13"],
  "paged.conditions": ["PN-6"],
  "paged.control": ["PN-5", "PN-6"],
  "paged.document-setup": ["PN-5", "PN-6", "PN-7"],
  "paged.effects": ["PN-6", "PN-8"],
  "paged.export-tagging": ["PN-6", "PN-8"],
  "paged.frame-fitting": ["PN-12"],
  "paged.glyphs": ["PN-6"],
  "paged.gradient-options": ["PN-5", "PN-6", "PN-7", "PN-10"],
  "paged.gradients": ["PN-5", "PN-6", "PN-15"],
  "paged.guides": ["PN-5", "PN-10"],
  "paged.inspector": ["PN-5", "PN-6", "PN-7"],
  "paged.layers": ["PN-11"],
  "paged.margins-columns": ["PN-5", "PN-6", "PN-10"],
  "paged.master-options": ["PN-7", "PN-10"],
  "paged.object-export": ["PN-6"],
  "paged.object-options": ["PN-5", "PN-6", "PN-7"],
  "paged.object-styles": ["PN-9"],
  "paged.object-transform": ["PN-12"],
  "paged.paragraph": ["PN-5", "PN-6", "PN-8"],
  "paged.paragraph-styles": ["PN-9"],
  "paged.pathfinder": ["PN-6"],
  "paged.properties": ["PN-5", "PN-6"],
  "paged.schema-tree-demo": ["PN-11"],
  "paged.script-editor": ["PN-16"],
  "paged.section-options": ["PN-5", "PN-6", "PN-7", "PN-10"],
  "paged.stroke": ["PN-5", "PN-6"],
  "paged.style-options": ["PN-5", "PN-6", "PN-7", "PN-10"],
  "paged.swatch-options": ["PN-5", "PN-6", "PN-7", "PN-10", "PN-14"],
  "paged.swatches": ["PN-6"],
  "paged.table-styles": ["PN-9"],
  "paged.text-frame-options": ["PN-5", "PN-6", "PN-8"],
  "paged.text-variables": ["PN-6", "PN-7", "PN-10"],
  "paged.text-wrap": ["PN-6"],
};

const findingOf = (problem: string) =>
  A11Y_KNOWN.find((k) => k.signature === problem)?.id ?? null;

describe("the built-in panel registry", () => {
  test("is what the app registers (a floor, so a broken import cannot pass empty)", () => {
    expect(BUILT_IN_PANELS.length).toBeGreaterThanOrEqual(89);
    const ids = BUILT_IN_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every panel has a component test in this lane (or is on the shrinking list)", () => {
    const covered = coveredPanels();
    const missing = BUILT_IN_PANELS.map((p) => p.id).filter(
      (id) => !covered.has(id),
    );
    // Both ways: a panel that gains a test must leave NOT_YET_TESTED.
    expect(missing.sort()).toEqual([...NOT_YET_TESTED].sort());
  });

  test("the lane tags no panel the registry does not have", () => {
    const registered = new Set(BUILT_IN_PANELS.map((p) => p.id));
    const stray = [...coveredPanels().keys()].filter(
      (id) => !registered.has(id),
    );
    expect(stray).toEqual([]);
  });
});

describe("every built-in panel mounts", () => {
  for (const panel of BUILT_IN_PANELS) {
    test(`${panel.id}: no document, a blank page, a selected frame`, async () => {
      const none = await mountPanel(panel, { document: "none" });
      expect(none.engine.errors).toEqual([]);
      none.unmount();

      const blank = await mountPanel(panel, { document: "blank" });
      expect(blank.engine.errors).toEqual([]);
      blank.unmount();

      const rich = await mountPanel(panel, { scene: richScene });
      await rich.select([rich.scene.rect]);
      expect(rich.engine.errors).toEqual([]);
      expect(rich.root.isConnected).toBe(true);
    });
  }
});

describe("every built-in panel's controls are named and reachable", () => {
  // One mount per panel serves both of its tests (the ratchet and the
  // expected failure).
  const seen = new Map<string, Promise<string[]>>();
  const reach = (panel: (typeof BUILT_IN_PANELS)[number]) => {
    let problems = seen.get(panel.id);
    if (!problems) {
      problems = (async () => {
        const h = await mountPanel(panel, { scene: richScene });
        await h.select([h.scene.rect]);
        const found = a11yProblems(h.root);
        h.unmount();
        return found;
      })();
      seen.set(panel.id, problems);
    }
    return problems;
  };
  for (const panel of BUILT_IN_PANELS) {
    const listed = A11Y_FINDINGS[panel.id] ?? [];
    // The ratchet: nothing beyond the listed findings, and every listed
    // finding still there (a fixed one must leave the table).
    test(`${panel.id}: no problem beyond ${listed.length ? listed.join(", ") : "none"}`, async () => {
      const problems = await reach(panel);
      expect(
        problems.filter((p) => !listed.includes(findingOf(p) ?? "")),
      ).toEqual([]);
      expect([...new Set(problems.map(findingOf))].sort()).toEqual(
        [...listed].sort(),
      );
    });
    if (listed.length > 0) {
      test.failing(
        `${panel.id} (${listed.join(", ")}): every control is named and reachable`,
        async () => {
          expect(await reach(panel)).toEqual([]);
        },
      );
    }
  }
});
