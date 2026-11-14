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

// The living publication contract (editor ADR 1236): the contract is read
// field by field; the assessment reuses the export's own readiness check
// (one checker, not two) and adds what the contract promises beyond it;
// its readiness reacts to the document's facts.

import { describe, expect, test } from "bun:test";

import type { PrintOutputFacts } from "@paged-media/shell";

import {
  assessContract,
  type ContractFacts,
} from "../../../src/contract/assess";
import {
  CONTRACT_LABEL,
  contractMutation,
  contractOfMeta,
  readContract,
  type PublicationContract,
} from "../../../src/contract/model";
import { contractIssues } from "../../../src/contract/source";

const print = (profileActive: boolean): PrintOutputFacts => ({
  profileName: profileActive ? "ISO Coated v2" : null,
  profileActive,
  outputIntent: profileActive ? "ISO Coated v2" : null,
  standard: profileActive ? "pdfx4" : "pdf17",
});

const page = (w = 612, h = 792, bleed = 9) => ({
  sizePt: [w, h] as const,
  bleedTopPt: bleed,
  bleedLeftPt: bleed,
  bleedBottomPt: bleed,
  bleedRightPt: bleed,
});

function facts(over: Partial<ContractFacts> = {}): ContractFacts {
  return {
    loaded: true,
    print: print(true),
    pages: [page(), page()],
    fonts: [{ family: "Minion Pro" }, { family: "Myriad Pro" }],
    links: [
      {
        status: "ok",
        effectivePpi: 320,
        colorspace: "CMYK",
        element: { kind: "rectangle", id: "r1" },
      },
    ],
    oversetStories: 0,
    emptyRequiredFields: 0,
    dataIssues: 0,
    documentName: "Annual",
    ...over,
  };
}

const contract: PublicationContract = {
  standard: "pdfx4",
  page: { widthPt: 612, heightPt: 792 },
  bleedPt: 9,
  outputIntent: { required: true, profile: "Coated" },
  noRgbImages: true,
  fonts: { available: true, allowed: ["Minion Pro", "Myriad Pro"] },
  minImagePpi: 300,
  dataComplete: true,
  approval: { status: "draft", reviewers: ["Art desk"] },
};

describe("the publication contract", () => {
  test("the record round-trips; what cannot be read is left out", () => {
    const m = contractMutation(contract);
    expect(m.args.key).toBe(CONTRACT_LABEL);
    expect(readContract(m.args.value)).toEqual(contract);
    expect(
      contractOfMeta({
        pluginMetadata: [{ key: CONTRACT_LABEL, value: m.args.value! }],
      }),
    ).toEqual(contract);
    expect(contractMutation(null).args.value).toBeNull();
    const odd = readContract(
      JSON.stringify({
        v: 1,
        data: {
          standard: "pdf/z",
          page: { widthPt: -1, heightPt: 10 },
          minImagePpi: "lots",
          approval: { status: "rubber-stamped", reviewers: ["A", 3] },
        },
      }),
    );
    expect(odd).toEqual({
      standard: "pdf17",
      approval: { status: "draft", reviewers: ["A"] },
    });
  });

  test("a document that meets it is ready; approved, it is approved", () => {
    const ready = assessContract(contract, facts());
    expect(ready.readiness).toBe("ready");
    expect(ready.checks.filter((c) => c.level === "blocker")).toEqual([]);
    expect(ready.checks.find((c) => c.id === "approval")?.level).toBe("info");
    const approved = assessContract(
      {
        ...contract,
        approval: { status: "approved", reviewers: [], by: "Kim", at: 1 },
      },
      facts(),
    );
    expect(approved.readiness).toBe("approved");
    // Edited after the approval: the approval is for an earlier state.
    const stale = assessContract(
      {
        ...contract,
        approval: { status: "approved", reviewers: [], by: "Kim", at: 1 },
      },
      facts({ editedSinceApproval: true }),
    );
    expect(stale.readiness).toBe("attention");
  });

  test("each requirement it promises is checked against the document", () => {
    const a = assessContract(
      contract,
      facts({
        print: print(false),
        pages: [page(), page(595, 842, 3)],
        fonts: [
          { family: "Minion Pro" },
          { family: "Comic Sans", isMissing: true },
        ],
        links: [
          {
            status: "ok",
            effectivePpi: 200,
            colorspace: "RGB",
            element: { kind: "rectangle", id: "r1" },
          },
          {
            status: "ok",
            effectivePpi: 120,
            colorspace: "CMYK",
            element: { kind: "rectangle", id: "r2" },
          },
        ],
        emptyRequiredFields: 2,
      }),
    );
    expect(a.readiness).toBe("blocked");
    const level = (id: string) => a.checks.find((c) => c.id === id)?.level;
    // The export's own check: PDF/X-4 cannot be met without an intent.
    expect(level("export-standard")).toBe("blocker");
    // The contract needs every font: the export's warning is a blocker.
    expect(level("export-fonts")).toBe("blocker");
    expect(level("page-size")).toBe("blocker");
    expect(a.checks.find((c) => c.id === "page-size")?.pages).toEqual([1]);
    expect(level("bleed")).toBe("blocker");
    expect(level("output-intent")).toBe("blocker");
    expect(level("rgb")).toBe("blocker");
    expect(level("fonts-allowed")).toBe("blocker");
    expect(a.checks.find((c) => c.id === "fonts-allowed")?.text).toContain(
      "Comic Sans",
    );
    expect(level("image-ppi")).toBe("blocker");
    // The contract's own floor replaces the export's 150 ppi check.
    expect(a.checks.some((c) => c.id === "export-resolution")).toBe(false);
    expect(level("data-fields")).toBe("blocker");
    // Blockers first.
    expect(a.checks[0]!.level).toBe("blocker");
    expect(a.checks.at(-1)!.level).not.toBe("blocker");
  });

  test("unmet requirements Publication health does not report itself become issues, on their pages and items", () => {
    const a = assessContract(
      contract,
      facts({
        pages: [page(), page(595, 842)],
        fonts: [{ family: "Comic Sans", isMissing: true }],
        links: [
          {
            status: "ok",
            effectivePpi: 200,
            colorspace: "CMYK",
            element: { kind: "rectangle", id: "r1" },
          },
          {
            status: "ok",
            effectivePpi: 100,
            colorspace: "CMYK",
            element: { kind: "rectangle", id: "r2" },
          },
        ],
      }),
    );
    const issues = contractIssues(a, ["p1", "p2"]);
    expect(issues.map((i) => [i.id, i.severity, i.pageIndex ?? null])).toEqual([
      ["contract:page-size:page:1", "error", 1],
      ["contract:fonts-allowed", "error", null],
      // r2 is below 150 ppi: Publication health's own low-res issue says so.
      ["contract:image-ppi:item:r1", "error", null],
    ]);
    // Missing fonts are Publication health's own issue: not repeated.
    expect(issues.some((i) => i.id.startsWith("contract:export-fonts"))).toBe(
      false,
    );
  });
});
