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

// The UXI coverage report's own tests: every form a claim is read in (and
// the ones that must not count), the layer attribution, and the two-way
// ratchet and the gates on a small inventory. A reader that silently reads
// less always passes, so each is pinned against a fixture it must read in
// full.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INVENTORY,
  ROOT,
  planTasks,
  readJson,
} from "./interaction-inventory.mjs";
import {
  GPU_ONLY_JOURNEYS,
  claimLayers,
  claimsInTitle,
  computeCoverage,
  loadAcknowledged,
  readClaims,
} from "./uxi-coverage.mjs";

const fixture = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "uxi-coverage-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return { dir, files: Object.keys(files) };
};
const read = (files) => {
  const f = fixture(files);
  return readClaims(f.dir, f.files);
};
const brief = (claims) =>
  claims.map((c) => ({
    line: c.line,
    ids: c.ids,
    counts: !c.quarantined && !c.notRun,
  }));

describe("claims in a title", () => {
  it("reads the leading id and the uxi tags", () => {
    expect(
      claimsInTitle("UXI-T07 — Escape aborts a move @feat:x @level:edge"),
    ).toEqual({ ids: ["UXI-T07"], bad: [] });
    expect(claimsInTitle("UXI-T07: the spec's own form")).toEqual({
      ids: ["UXI-T07"],
      bad: [],
    });
    expect(
      claimsInTitle(
        "a move cancels @uxi:UXI-T08 @uxi:UXI-GST-006 (@uxi:UXI-T09)",
      ),
    ).toEqual({ ids: ["UXI-T08", "UXI-GST-006", "UXI-T09"], bad: [] });
    expect(claimsInTitle("regression for UXI-T07, not a claim")).toEqual({
      ids: [],
      bad: [],
    });
  });

  it("is an error, not a silent zero, for a claim it cannot read", () => {
    expect(claimsInTitle("UXI-T7 — one digit").bad).toHaveLength(1);
    expect(claimsInTitle("UXI-T077 — three digits").bad).toHaveLength(1);
    expect(claimsInTitle("x @uxi:T07").bad).toHaveLength(1);
    expect(claimsInTitle("x @uxi:UXI-SEL-4").bad).toHaveLength(1);
  });
});

describe("the TS / JS reader", () => {
  it("reads test, it and describe titles; a describe claims for what it holds", () => {
    const r = read({
      "apps/editor/apps/canvas/tests/e2e/uxi.spec.ts": `
        import { test } from "@playwright/test";
        test("UXI-T01 — click selects one object", async () => {});
        test.describe("UXI-T31 — Escape unwinds one level", () => {
          test("inner", async () => {});
        });
        it("tags @uxi:UXI-T02 @uxi:UXI-SEL-004", () => {});
        test(\`UXI-T03 — marquee \${"direction"}\`, async () => {});
        const s = 'test("UXI-T04 — in a string")';
        // test("UXI-T05 — in a comment")
        helper("UXI-T06 — not a test function");
      `,
    });
    expect(r.errors).toEqual([]);
    expect(brief(r.claims)).toEqual([
      { line: 3, ids: ["UXI-T01"], counts: true },
      { line: 4, ids: ["UXI-T31"], counts: true },
      { line: 7, ids: ["UXI-T02", "UXI-SEL-004"], counts: true },
      { line: 8, ids: ["UXI-T03"], counts: true },
    ]);
  });

  it("reads skipped, expected-failure and quarantined tests, and counts none of them", () => {
    const r = read({
      "apps/editor/packages/shell/src/focus/keys.test.ts": `
        test.skip("UXI-T20 — skipped", () => {});
        test.fixme("UXI-T21 — fixme", () => {});
        it.todo("UXI-T22 — todo");
        test.fail("UXI-T23 — expected to fail", () => {});
        test("UXI-T24 — quarantined by tag", { tag: "@quarantine" }, () => {});
        test("UXI-T25 — quarantined in the title @quarantine", () => {});
        test.describe("flaky group", { tag: ["@slow", "@quarantine"] }, () => {
          test("UXI-T26 — inherits the quarantine", () => {});
        });
        describe.skip("skipped group", () => {
          it("UXI-T27 — inherits the skip", () => {});
        });
        test("UXI-T28 — this one counts", () => {});
      `,
    });
    expect(r.errors).toEqual([]);
    expect(brief(r.claims).map((c) => [c.ids[0], c.counts])).toEqual([
      ["UXI-T20", false],
      ["UXI-T21", false],
      ["UXI-T22", false],
      ["UXI-T23", false],
      ["UXI-T24", false],
      ["UXI-T25", false],
      ["UXI-T26", false],
      ["UXI-T27", false],
      ["UXI-T28", true],
    ]);
  });

  it("reports a malformed claim, and reads nothing outside test files", () => {
    const r = read({
      "apps/editor/packages/shell/src/a.test.ts": `
        test("UXI-T7 — one digit", () => {});
        test("x @uxi:UXI-T", () => {});
      `,
      "apps/editor/packages/shell/src/not-a-test.ts": `
        test("UXI-T01 — a source file is not a test file", () => {});
      `,
    });
    expect(r.claims).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.filesRead).toBe(1);
  });
});

describe("the Rust reader", () => {
  it("reads uxi_tNN fn names and /// doc lines; #[ignore] reads but does not count", () => {
    const r = read({
      "engine/core/crates/paged-canvas/tests/uxi.rs": `
#[test]
fn uxi_t60_script_waits_for_the_gesture() {}

/// UXI-T61 — the worker fails after the press
/// More prose; @uxi:UXI-ASY-005 too.
#[test]
fn worker_failure_ends_the_gesture() {
    let s = "fn uxi_t62_in_a_string";
}

#[test]
#[ignore = "slow"]
fn uxi_t63_ignored() {}

// fn uxi_t64_in_a_comment() {}
#[test]
fn uxi_t7_malformed() {}
`,
    });
    expect(brief(r.claims)).toEqual([
      { line: 3, ids: ["UXI-T60"], counts: true },
      { line: 8, ids: ["UXI-T61", "UXI-ASY-005"], counts: true },
      { line: 14, ids: ["UXI-T63"], counts: false },
    ]);
    expect(r.errors).toEqual([
      expect.stringContaining("uxi_t7_malformed starts uxi_t but is not"),
    ]);
  });
});

describe("the layers", () => {
  it("are read from the path, with the surface gate's rules", () => {
    const L = (f, text) => [...claimLayers(f, text)].sort();
    expect(L("apps/editor/packages/shell/src/x.dom.test.tsx")).toEqual([
      "component",
    ]);
    expect(L("apps/editor/packages/shell/src/x.test.ts")).toEqual(["unit"]);
    expect(L("apps/editor/apps/canvas/tests/e2e/x.spec.ts")).toEqual(["e2e"]);
    expect(L("apps/editor/apps/canvas/tests/headless/x.test.ts")).toEqual([
      "engine",
    ]);
    expect(L("engine/core/crates/paged-canvas/tests/x.rs")).toEqual(["engine"]);
    expect(
      L("apps/editor/apps/canvas/tests/journey/focused/x.journey.spec.ts"),
    ).toEqual(["journey-cpu", "journey-gpu"]);
    expect(
      L(
        "apps/editor/apps/canvas/tests/journey/focused/gpu-backend.journey.spec.ts",
      ),
    ).toEqual(["journey-gpu"]);
  });

  it("the GPU-only journeys are the journeys project's testIgnore", () => {
    const config = readFileSync(
      join(ROOT, "apps/editor/apps/canvas/playwright.config.ts"),
      "utf8",
    );
    const block = /name: "journeys",[\s\S]*?testIgnore: \[([\s\S]*?)\]/.exec(
      config,
    );
    expect(block).not.toBeNull();
    const ignored = [...block[1].matchAll(/"\*\*\/([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ignored)).toEqual(GPU_ONLY_JOURNEYS);
  });
});

describe("the ratchet and the gates", () => {
  const inventory = {
    tests: [
      {
        id: "UXI-T01",
        group: "A",
        title: "a",
        gates: ["G0"],
        fixture: "A",
        layers: ["journey-cpu"],
        requirements: ["UXI-SEL-003"],
      },
      {
        id: "UXI-T02",
        group: "A",
        title: "b",
        gates: ["G0"],
        fixture: "A",
        layers: ["engine"],
        requirements: ["UXI-SEL-004"],
      },
      {
        id: "UXI-T03",
        group: "A",
        title: "c",
        gates: ["G1"],
        fixture: "A",
        layers: ["unit"],
        requirements: ["UXI-SEL-005"],
      },
    ],
    requirements: [
      "UXI-SEL-003",
      "UXI-SEL-004",
      "UXI-SEL-005",
      "UXI-GST-006",
    ].map((id) => ({
      id,
      domain: id.split("-")[1],
      section: "6.2",
      title: "t",
    })),
    gates: [
      { id: "G0", name: "Safety" },
      { id: "G1", name: "Core input" },
    ],
    groups: [{ id: "A", title: "A" }],
    exceptions: [],
    enforcedGates: [],
  };
  const claim = (ids, layers = ["e2e"], extra = {}) => ({
    file: "apps/editor/apps/canvas/tests/e2e/x.spec.ts",
    line: 1,
    title: "t",
    ids,
    layers: new Set(layers),
    quarantined: false,
    notRun: false,
    ...extra,
  });
  const ack = (ids) => ({
    entries: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          task: "IC2",
          reason: "No test claims it yet: the coordinator is not there.",
        },
      ]),
    ),
  });
  const run = (opts) =>
    computeCoverage({
      inventory: structuredClone({ ...inventory, ...opts.inventory }),
      claims: opts.claims ?? [],
      acknowledged: opts.acknowledged ?? ack([]),
      quarantine: opts.quarantine ?? [],
      today: opts.today ?? "2026-11-13",
    });

  it("passes when every test is claimed or acknowledged", () => {
    const r = run({
      claims: [claim(["UXI-T01"])],
      acknowledged: ack(["UXI-T02", "UXI-T03"]),
    });
    expect([r.lost, r.stale, r.errors, r.ackProblems]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(r.tests.map((t) => t.state)).toEqual([
      "covered",
      "acknowledged",
      "acknowledged",
    ]);
    // journey-cpu evidence comes from an e2e spec too.
    expect(r.tests[0].layersWithoutEvidence).toEqual([]);
  });

  it("fails an acknowledged test that is claimed now, and a claimed one that lost its claim", () => {
    const r = run({
      claims: [claim(["UXI-T01"])],
      acknowledged: ack(["UXI-T01", "UXI-T02"]),
    });
    expect(r.stale.map((t) => t.id)).toEqual(["UXI-T01"]);
    expect(r.lost.map((t) => t.id)).toEqual(["UXI-T03"]);
  });

  it("a quarantined or skipped claim covers nothing, by tag or by the quarantine list", () => {
    const r = run({
      claims: [
        claim(["UXI-T01"], ["e2e"], { quarantined: true }),
        claim(["UXI-T02"], ["e2e"], { notRun: true }),
        claim(["UXI-T03"], ["e2e"], { title: "UXI-T03 — listed" }),
      ],
      quarantine: [{ file: "e2e/x.spec.ts", title: "UXI-T03 — listed" }],
    });
    expect(r.lost.map((t) => t.id)).toEqual(["UXI-T01", "UXI-T02", "UXI-T03"]);
  });

  it("an unknown claimed id is an error; a bad acknowledged entry is a problem", () => {
    const r = run({
      claims: [claim(["UXI-T99", "UXI-SEL-999"])],
      acknowledged: {
        entries: {
          "UXI-T01": { task: "IC2", reason: "short" },
          "UXI-T02": {
            task: "someday",
            reason: "No test claims it yet: nothing is there yet at all.",
          },
          "UXI-T03": {
            task: "IC6",
            reason: "No test claims it yet: the selection model is not there.",
          },
          "UXI-T98": {
            task: "IC2",
            reason: "No test claims it yet: this id is not in the inventory.",
          },
        },
      },
    });
    expect(r.errors).toHaveLength(2);
    expect(r.ackProblems).toEqual([
      expect.stringContaining('UXI-T01: "reason"'),
      expect.stringContaining('UXI-T02: "task"'),
      expect.stringContaining("UXI-T98: not a UXI test"),
    ]);
  });

  it("requirements are proved through a claimed test or claimed directly", () => {
    const r = run({
      claims: [claim(["UXI-T01"]), claim(["UXI-GST-006"], ["unit"])],
      acknowledged: ack(["UXI-T02", "UXI-T03"]),
    });
    expect(r.requirements.filter((q) => q.covered).map((q) => q.id)).toEqual([
      "UXI-SEL-003",
      "UXI-GST-006",
    ]);
  });

  it("--gate: an enforced gate fails on an open test unless an unexpired exception lists it", () => {
    const opts = { acknowledged: ack(["UXI-T01", "UXI-T02", "UXI-T03"]) };
    expect(run(opts).gateFailures).toEqual([]);
    const enforced = { ...opts, inventory: { enforcedGates: ["G0"] } };
    expect(run(enforced).gateFailures).toEqual([
      { gate: "G0", id: "UXI-T01" },
      { gate: "G0", id: "UXI-T02" },
    ]);
    const exception = {
      id: "EXC-001",
      tests: ["UXI-T02"],
      expiry: "2027-01-31",
    };
    const excused = {
      ...opts,
      inventory: { enforcedGates: ["G0"], exceptions: [exception] },
    };
    expect(run(excused).gateFailures).toEqual([{ gate: "G0", id: "UXI-T01" }]);
    expect(run({ ...excused, today: "2027-02-01" }).gateFailures).toHaveLength(
      2,
    );
  });

  it("an acknowledged task must be a task of the plan", () => {
    const r = computeCoverage({
      inventory: structuredClone(inventory),
      claims: [],
      acknowledged: ack(["UXI-T01", "UXI-T02", "UXI-T03"]),
      plan: new Set(["IC4"]),
      today: "2026-11-13",
    });
    expect(r.ackProblems).toHaveLength(3);
    expect(r.ackProblems[0]).toContain("task IC2 is not a task of");
  });

  it("the real acknowledged file is well formed against the real inventory and plan", () => {
    const plan = planTasks(ROOT);
    expect(plan?.size ?? 0).toBeGreaterThan(50);
    const r = computeCoverage({
      inventory: readJson(INVENTORY),
      claims: [],
      acknowledged: loadAcknowledged(),
      plan,
      today: "2026-11-13",
    });
    expect(r.ackProblems).toEqual([]);
    expect(r.floors).toEqual([]);
  });
});
