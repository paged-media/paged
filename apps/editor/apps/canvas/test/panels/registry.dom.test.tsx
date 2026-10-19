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
const NOT_YET_TESTED: readonly string[] = [];

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
 *
 * Empty since the panel kit's field naming (`LabelledBy`, `NamedAs`,
 * `useFieldName`, platform/shared/panel-kit): a row's label names the
 * controls of the row, a field with no visible label is named after its
 * row's title, and the one-off controls carry their own names. That closed
 * PN-5 to PN-16. A new unnamed control is fixed, not listed here.
 */
const A11Y_KNOWN: ReadonlyArray<{ id: string; signature: string }> = [];

/** Which of those each panel shows today (the rich scene, a rectangle
 *  selected). A panel listed here has an expected-failure reach test; the
 *  ratchet test below holds the list exact. */
const A11Y_FINDINGS: Readonly<Record<string, readonly string[]>> = {};

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
