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

// The interaction inventory guard's own tests: the spec parser on every form
// a requirement is written in, the schema validator (which must refuse what
// it does not implement), and each check against a copy of the real
// inventory with one thing broken. A guard that silently reads less always
// passes, so the parser is pinned against the real spec too.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FLOORS,
  INVENTORY,
  OWNERS_TS,
  ROOT,
  SCHEMA,
  checkInventory,
  parseSpec,
  planTasks,
  readJson,
  readSpec,
  surfaceLookup,
  syncInventory,
  titleOf,
  validate,
} from "./interaction-inventory.mjs";

const TODAY = "2026-11-13";
const spec = readSpec();
const schema = readJson(SCHEMA);
const real = () => structuredClone(readJson(INVENTORY));
/** The real inventory with one exception of the ledger's shape: the real
 *  ledger is empty since IC4 retired EXC-001. */
const withException = () => {
  const inv = real();
  inv.exceptions.push({
    id: "EXC-090",
    contract: ["UXI-ESC-001", "UXI-MIG-002"],
    scope: "a test exception: two Escape listeners in one scope",
    interactions: ["escape.viewport", "escape.tool-handler"],
    tests: ["UXI-T07"],
    why: "A test exception of the ledger's shape: two Escape handlers in one scope.",
    issue: "IC4",
    owner: "editor shell",
    severity: "major",
    expiry: "2027-01-31",
    repro: "Press Escape during a move.",
  });
  return inv;
};
const check = (inv, opts = {}) =>
  checkInventory(inv, { spec, schema, today: TODAY, ...opts });
const matching = (errors, re) => errors.filter((e) => re.test(e));

const SPEC = `
## 2. Principles

### 2.2 Global invariants

| ID            | Requirement |
| ------------- | ----------- |
| \`UXI-INV-001\` | At most one owner processes a pointer sequence; no simultaneous pan. |

## 3. State

### 3.2 Interaction coordinator

\`UXI-STATE-001\` — The host **SHOULD** expose a coordinator. Subsystems may still be separate.

type InteractionPhase =
  | "idle"
  | "settled";

type InteractionOwner =
  | "canvas-select"
  | "modal";

### 12.1 Escape resolution (\`UXI-ESC-001\`)

Mentions \`UXI-INV-001\` again, which defines nothing.

## 23. Executable acceptance scenarios

### 23.1 Test fixture and test method

Use fixtures for: (A) simple page with two rectangles; (B) group containing path and text frame.

#### A. Pointer, selection, gesture, and history

| Test      | Steps                        | Required assertion            |
| --------- | ---------------------------- | ----------------------------- |
| \`UXI-T01\` | Click an unselected rectangle | Only that object selected.    |

### 23.2 Layers and cross-browser matrix

| Layer                 | Required evidence     |
| --------------------- | --------------------- |
| Unit/property tests   | Pure hit/coordinate.  |
| Interpretive dance    | Something new.        |

### 23.4 Acceptance gates

**Gate G0 — Safety:** all cancel tests pass.
`;

describe("the spec parser", () => {
  it("reads every form a requirement takes: a table row, a line, a heading", () => {
    const s = parseSpec(SPEC);
    expect(s.requirements).toEqual([
      {
        id: "UXI-INV-001",
        domain: "INV",
        section: "2.2",
        title:
          "At most one owner processes a pointer sequence; no simultaneous pan.",
      },
      {
        id: "UXI-STATE-001",
        domain: "STATE",
        section: "3.2",
        title: "The host SHOULD expose a coordinator.",
      },
      {
        id: "UXI-ESC-001",
        domain: "ESC",
        section: "12.1",
        title: "Escape resolution",
      },
    ]);
    expect([...s.mentioned].sort()).toEqual([
      "UXI-ESC-001",
      "UXI-INV-001",
      "UXI-STATE-001",
    ]);
  });

  it("reads the vocabularies: owners, phases, groups, fixtures, gates, layers, tests", () => {
    const s = parseSpec(SPEC);
    expect(s.owners).toEqual(["canvas-select", "modal"]);
    expect(s.phases).toEqual(["idle", "settled"]);
    expect(s.groups).toEqual([
      { id: "A", title: "Pointer, selection, gesture, and history" },
    ]);
    expect(s.fixtures).toEqual([
      { id: "A", description: "simple page with two rectangles" },
      { id: "B", description: "group containing path and text frame" },
    ]);
    expect(s.gates).toEqual([
      { id: "G0", name: "Safety", criterion: "all cancel tests pass." },
    ]);
    expect(s.tests).toEqual([
      {
        id: "UXI-T01",
        group: "A",
        title: "Click an unselected rectangle",
        assertion: "Only that object selected.",
      },
    ]);
    // A layer the guard has no id for is kept, with id null, so the guard
    // can say so instead of dropping it.
    expect(s.layers.map((l) => [l.id, l.name])).toEqual([
      ["unit", "Unit/property tests"],
      [null, "Interpretive dance"],
    ]);
  });

  it("titles are the first sentence, cut at a word when long", () => {
    expect(titleOf("One sentence. Another one.")).toBe("One sentence.");
    expect(titleOf("Keeps e.g., inline. Then More.")).toBe(
      "Keeps e.g., inline.",
    );
    const long = titleOf(`${"word ".repeat(80)}end.`);
    expect(long.length).toBeLessThanOrEqual(221);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reads the whole real spec: every id it mentions is one it defines, above the floors", () => {
    const defined = new Set(spec.requirements.map((r) => r.id));
    expect([...spec.mentioned].filter((id) => !defined.has(id))).toEqual([]);
    expect(defined.size).toBe(spec.requirements.length);
    expect(spec.requirements.length).toBeGreaterThanOrEqual(
      FLOORS.requirements,
    );
    expect(spec.tests.length).toBeGreaterThanOrEqual(FLOORS.tests);
    expect(spec.owners.length).toBeGreaterThanOrEqual(FLOORS.owners);
    expect(spec.layers.every((l) => l.id)).toBe(true);
    expect(spec.tests.map((t) => t.id)).toEqual(
      Array.from(
        { length: 76 },
        (_, i) => `UXI-T${String(i + 1).padStart(2, "0")}`,
      ),
    );
  });
});

describe("the schema validator", () => {
  const S = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: {
      a: {
        type: "array",
        items: { $ref: "#/$defs/id" },
        minItems: 1,
        uniqueItems: true,
      },
      d: { type: "string", format: "date" },
      e: { enum: ["x", "y"] },
      s: { type: "string", minLength: 3 },
    },
    $defs: { id: { type: "string", pattern: "^G[0-4]$" } },
  };

  it("accepts a valid value", () => {
    expect(
      validate(S, { a: ["G0"], d: "2026-11-13", e: "x", s: "abc" }),
    ).toEqual([]);
  });

  it("reports each broken constraint with its path", () => {
    const errors = validate(S, {
      a: ["G0", "G0", "G9"],
      d: "2026-02-30",
      e: "z",
      s: "ab",
      extra: 1,
    });
    expect(errors).toEqual([
      '$.a: lists "G0" twice',
      '$.a[2]: "G9" does not match ^G[0-4]$',
      '$.d: "2026-02-30" is not a YYYY-MM-DD date',
      '$.e: "z" is not one of: x, y',
      "$.s: is shorter than 3 characters",
      '$: has an unknown property "extra"',
    ]);
    expect(validate(S, {})).toEqual(['$: is missing "a"']);
    expect(validate(S, { a: [] })).toEqual(["$.a: has 0 items, fewer than 1"]);
    expect(validate(S, [])).toEqual(["$: is array, expected object"]);
  });

  it("refuses a keyword it does not implement, rather than skipping it", () => {
    expect(() => validate({ type: "object", maxProperties: 2 }, {})).toThrow(
      /maxProperties/,
    );
    expect(() => validate({ $ref: "#/$defs/nope" }, 1)).toThrow(
      /does not resolve/,
    );
  });
});

describe("the guard", () => {
  // The enumeration reads the whole editor and every bundle: seconds on a
  // warm disk, far more on a cold one.
  it("passes the real inventory, with the real surface and plan", async () => {
    const { enumerateSurface } = await import("./surface/enumerate.mjs");
    expect(
      check(real(), { surface: enumerateSurface(ROOT), plan: planTasks(ROOT) }),
    ).toEqual([]);
  }, 120_000);

  it("fails an inventory out of sync with the spec, and --sync repairs it", () => {
    const inv = real();
    inv.requirements[0].title = "something the spec does not say";
    [inv.requirements[1], inv.requirements[2]] = [
      inv.requirements[2],
      inv.requirements[1],
    ];
    inv.tests[3].assertion = "edited by hand";
    const errors = check(inv);
    expect(
      matching(
        errors,
        /out of sync with the spec, requirements: 1 differ: UXI-INV-001 \(title\); the order differs/,
      ),
    ).toHaveLength(1);
    expect(matching(errors, /out of sync with the spec, tests:/)).toHaveLength(
      1,
    );
    expect(check(syncInventory(inv, spec))).toEqual([]);
  });

  it("--sync keeps the curated fields and leaves a new test for curation", () => {
    const inv = real();
    const curated = inv.tests.find((t) => t.id === "UXI-T07");
    inv.tests = inv.tests.filter((t) => t.id !== "UXI-T76");
    const synced = syncInventory(inv, spec);
    const t07 = synced.tests.find((t) => t.id === "UXI-T07");
    expect(t07.gates).toEqual(curated.gates);
    expect(t07.requirements).toEqual(curated.requirements);
    const t76 = synced.tests.find((t) => t.id === "UXI-T76");
    expect(t76).toMatchObject({
      gates: [],
      fixture: "",
      layers: [],
      requirements: [],
    });
    expect(
      matching(check(synced), /^schema: \$\.tests\[75\]/).length,
    ).toBeGreaterThan(0);
  });

  it("fails a reference that resolves to nothing", () => {
    const inv = withException();
    inv.tests[0].requirements.push("UXI-SEL-999");
    inv.interactions[0].uxi.push("UXI-NOPE-001");
    inv.interactions[0].states.push("hovering");
    inv.exceptions[0].tests.push("UXI-T99");
    inv.exceptions[0].interactions.push("no.such-interaction");
    const errors = check(inv);
    expect(
      matching(errors, /UXI-SEL-999 is not a requirement id/),
    ).toHaveLength(1);
    expect(
      matching(errors, /UXI-NOPE-001 is not a requirement id/),
    ).toHaveLength(1);
    expect(matching(errors, /hovering is not a phase/)).toHaveLength(1);
    expect(matching(errors, /UXI-T99 is not a UXI test/)).toHaveLength(1);
    expect(
      matching(errors, /no.such-interaction is not an interaction/),
    ).toHaveLength(1);
  });

  it("fails an owner outside §3.2 at the schema", () => {
    const inv = real();
    inv.interactions[0].owner = "canvas-everything";
    expect(
      matching(check(inv), /^schema: \$\.interactions\[0\]\.owner/),
    ).toHaveLength(1);
  });

  it("checks surface ids against the enumeration, family members included", () => {
    const surface = {
      items: [
        { kind: "tool", id: "paged.tool.select" },
        {
          kind: "keybinding",
          id: "*→paged.tool.activate.*",
          family: true,
          members: ["v→paged.tool.activate.paged.tool.select"],
        },
      ],
    };
    const is = surfaceLookup(surface);
    expect(is("tool:paged.tool.select")).toBe(true);
    expect(is("keybinding:v→paged.tool.activate.paged.tool.select")).toBe(true);
    expect(is("tool:paged.tool.lasso")).toBe(false);
    const inv = real();
    inv.interactions = inv.interactions.filter((x) => x.id === "select.click");
    inv.interactions[0].surfaceIds = [
      "tool:paged.tool.select",
      "tool:paged.tool.lasso",
    ];
    expect(matching(check(inv, { surface }), /surface id/)).toEqual([
      "select.click: tool:paged.tool.lasso is not an enumerated surface id (scripts/surface/enumerate.mjs)",
    ]);
  });

  it("fails a site that does not exist", () => {
    const inv = real();
    inv.interactions[0].site = "apps/editor/apps/canvas/src/ui/Gone.tsx";
    expect(matching(check(inv), /site .* does not exist/)).toHaveLength(1);
  });

  it("fails an exception past its expiry", () => {
    const inv = withException();
    const e = inv.exceptions[0];
    expect(matching(check(inv, { today: e.expiry }), /EXPIRED/)).toEqual([]);
    const after = new Date(Date.parse(`${e.expiry}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(
      matching(check(inv, { today: after }), new RegExp(`${e.id}: EXPIRED`)),
    ).toHaveLength(1);
  });

  it("UXI-MIG-002: two owners of one event class in one scope fail, unless an exception lists one", () => {
    const inv = real();
    const click = inv.interactions.find((x) => x.id === "select.click");
    inv.interactions.push({
      ...structuredClone(click),
      id: "rival.click",
      owner: "plugin-surface",
    });
    const errors = check(inv);
    expect(
      matching(
        errors,
        /^UXI-MIG-002: pointer:primary-click @ canvas\/tool:select/,
      ),
    ).toHaveLength(1);

    // An exception that does not name UXI-MIG-002 excuses nothing here.
    inv.exceptions.push({
      id: "EXC-099",
      contract: ["UXI-SEL-001"],
      scope: "a plugin's click",
      interactions: ["rival.click"],
      why: "A test exception that lists the rival but not the migration rule it breaks.",
      issue: "IC4",
      owner: "editor shell",
      severity: "minor",
      expiry: "2027-01-31",
      repro: "Click with the rival plugin loaded.",
    });
    expect(matching(check(inv), /^UXI-MIG-002/)).toHaveLength(1);
    inv.exceptions.at(-1).contract.push("UXI-MIG-002");
    expect(check(inv)).toEqual([]);
    // An expired one excuses nothing either.
    expect(
      matching(
        check(inv, { today: "2027-02-01" }),
        /^UXI-MIG-002: pointer:primary-click/,
      ),
    ).toHaveLength(1);
  });

  it("the canvas's Escape handlers are scoped apart: no exception holds them since IC4 retired EXC-001", () => {
    expect(matching(check(real()), /^UXI-MIG-002/)).toEqual([]);
    // Put back in one scope, they collide.
    const inv = real();
    for (const x of inv.interactions)
      if (["escape.viewport", "escape.tool-handler"].includes(x.id))
        x.scope = "editor";
    expect(
      matching(check(inv), /^UXI-MIG-002: key:Escape @ editor /),
    ).toHaveLength(1);
  });

  it("an interaction marked exception needs an exception entry", () => {
    const inv = real();
    inv.interactions.find((x) => x.id === "hand.pan").status = "exception";
    expect(matching(check(inv), /hand\.pan: status "exception"/)).toHaveLength(
      1,
    );
  });

  it("an exception's task is a task of the plan", () => {
    const inv = withException();
    inv.exceptions[0].issue = "IC99";
    const plan = planTasks(ROOT);
    expect(check(real(), { plan })).toEqual([]);
    expect(
      matching(check(inv, { plan }), /issue IC99 is not a task of/),
    ).toHaveLength(1);
  });

  it("gate G4 requires every exception to link a GitHub issue", () => {
    const inv = real();
    inv.enforcedGates = ["G4"];
    const errors = matching(check(inv), /gate G4 is enforced/);
    expect(errors).toEqual(
      inv.exceptions
        .filter((e) => !/github\.com|^#\d+$/.test(e.issue))
        .map((e) => expect.stringContaining(`${e.id}:`)),
    );
  });

  it("fails an inventory that lost its interactions (the floor)", () => {
    const inv = real();
    inv.interactions = inv.interactions.slice(0, 3);
    inv.exceptions = [];
    expect(matching(check(inv), /interactions, under the floor/)).toHaveLength(
      1,
    );
  });

  it("the shell's owners module must name every owner once it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "uxi-owners-"));
    mkdirSync(join(root, OWNERS_TS, ".."), { recursive: true });
    writeFileSync(
      join(root, OWNERS_TS),
      `export const OWNERS = ${JSON.stringify(spec.owners.slice(1))} as const;`,
    );
    const errors = matching(check(real(), { root }), /owners\.ts/);
    expect(errors).toEqual([
      `${OWNERS_TS} does not name the owner "${spec.owners[0]}"`,
    ]);
  });

  it("the schema's owner enum is the spec's InteractionOwner", () => {
    expect(schema.$defs.ownerName.enum).toEqual(spec.owners);
  });
});
