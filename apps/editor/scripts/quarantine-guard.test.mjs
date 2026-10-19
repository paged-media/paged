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

// The quarantine guard and the flake-rate count, against fixtures: a guard
// that reads less than is there passes everything, so each rule is pinned.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { flakeRate } from "./flake-rate.mjs";
import {
  LIST,
  MAX_DAYS,
  checkEntries,
  checkListing,
} from "./quarantine-guard.mjs";

const entry = (over = {}) => ({
  id: "e2e/x.spec.ts › group › does a thing",
  owner: "@paged-media/editor",
  added: "2026-10-19",
  expires: "2026-11-01",
  reason: "polls a fixed sleep; fix tracked in the reason",
  ...over,
});

/** A Playwright JSON report: one file suite, one describe, specs with tests. */
const report = (specs) => ({
  suites: [
    {
      title: "e2e/x.spec.ts",
      file: "e2e/x.spec.ts",
      specs: [],
      suites: [
        {
          title: "group",
          file: "e2e/x.spec.ts",
          specs: specs.map(([title, tags, statuses]) => ({
            title,
            file: "e2e/x.spec.ts",
            tags,
            tests: [
              {
                projectName: "chromium",
                status: "expected",
                results: statuses.map((status) => ({ status })),
              },
            ],
          })),
        },
      ],
    },
  ],
});

describe("checkEntries", () => {
  it("accepts a complete entry inside its window", () => {
    expect(checkEntries([entry()], "2026-10-20")).toEqual([]);
  });

  it("fails an expired entry, naming the owner", () => {
    const errors = checkEntries([entry()], "2026-11-02");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("EXPIRED");
    expect(errors[0]).toContain("@paged-media/editor");
  });

  it("is still valid on the expiry day itself", () => {
    expect(checkEntries([entry()], "2026-11-01")).toEqual([]);
  });

  it(`refuses a window longer than ${MAX_DAYS} days`, () => {
    const errors = checkEntries(
      [entry({ expires: "2027-01-01" })],
      "2026-10-20",
    );
    expect(errors.join("\n")).toContain(`more than ${MAX_DAYS} days`);
  });

  it("requires owner, reason and dates", () => {
    const errors = checkEntries(
      [{ id: "e2e/x.spec.ts › t", added: "2026-10-19" }],
      "2026-10-20",
    );
    expect(errors.join("\n")).toContain("missing `owner`");
    expect(errors.join("\n")).toContain("missing `expires`");
    expect(errors.join("\n")).toContain("missing `reason`");
  });

  it("refuses an owner that is not a handle, and a duplicate id", () => {
    const errors = checkEntries(
      [entry({ owner: "someone" }), entry()],
      "2026-10-20",
    );
    expect(errors.join("\n")).toContain("GitHub handle");
    expect(errors.join("\n")).toContain("listed twice");
  });
});

describe("checkListing", () => {
  it("agrees when the tagged tests are exactly the listed ones", () => {
    const listing = report([
      ["does a thing", ["quarantine"], []],
      ["does another", [], []],
    ]);
    expect(checkListing([entry()], listing)).toEqual([]);
  });

  it("fails both directions: stale entry, untagged test, unlisted tag", () => {
    const listing = report([
      ["does a thing", [], []],
      ["is tagged only", ["quarantine"], []],
    ]);
    const errors = checkListing(
      [entry(), entry({ id: "e2e/x.spec.ts › group › gone" })],
      listing,
    );
    expect(errors.join("\n")).toContain(
      "untagged: e2e/x.spec.ts › group › does a thing",
    );
    expect(errors.join("\n")).toContain("stale: e2e/x.spec.ts › group › gone");
    expect(errors.join("\n")).toContain(
      "unlisted: e2e/x.spec.ts › group › is tagged only",
    );
  });

  it("refuses an empty listing instead of passing it", () => {
    expect(checkListing([], { suites: [] })).toHaveLength(1);
  });
});

describe("flakeRate", () => {
  it("classifies retries and repeats, and keeps quarantine out of the rate", () => {
    const r = flakeRate([
      report([
        ["steady", [], ["passed"]],
        ["retried", [], ["failed", "passed"]],
        ["broken", [], ["failed", "failed"]],
        ["parked", ["quarantine"], ["failed", "passed"]],
      ]),
      report([["steady", [], ["passed"]]]),
    ]);
    expect(r.tests).toEqual({
      passed: 1,
      failed: 1,
      flaky: 1,
      skipped: 0,
      ran: 3,
    });
    expect(r.flakeRate).toBeCloseTo(1 / 3);
    expect(r.quarantined.flaky).toBe(1);
    expect(r.flakyTests).toEqual([
      "[chromium] e2e/x.spec.ts › group › retried (1 passed, 1 failed)",
    ]);
  });

  it("judges an expected failure (test.fail) by what it expects", () => {
    const listing = report([["known bug", [], ["failed"]]]);
    listing.suites[0].suites[0].specs[0].tests[0].expectedStatus = "failed";
    const r = flakeRate([listing]);
    expect(r.tests).toEqual({
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      ran: 1,
    });
  });

  it("counts repeats that disagree as flaky", () => {
    const r = flakeRate([
      report([["repeat", [], ["passed"]]]),
      report([["repeat", [], ["timedOut"]]]),
    ]);
    expect(r.tests.flaky).toBe(1);
  });
});

it("the committed list is valid today", () => {
  const { entries } = JSON.parse(readFileSync(LIST, "utf8"));
  expect(checkEntries(entries, new Date().toISOString().slice(0, 10))).toEqual(
    [],
  );
});
