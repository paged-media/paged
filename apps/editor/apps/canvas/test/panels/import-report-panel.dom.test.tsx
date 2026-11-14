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

// The compatibility report panel (editor ADR 1222, UXI-FIL-002): a report
// says its summary and round-trip risk; each loss its meaning, its pages
// and items (a click goes there and selects), and its code on demand. A
// recorded report announces itself once, with View report.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { operationOfKey } from "../../src/panels/compatibility-report";

import { ImportReportPanel } from "../../src/panels/import-report-panel";
import { recordCompatReport } from "../../src/panels/compatibility-report-store";
import { operationFeedbackOf } from "@paged-media/shell";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

describe("Compatibility report", () => {
  test("empty: says nothing was lost", async () => {
    covers("panel:paged.import-report");
    const h = await mountPanel(ImportReportPanel, {
      id: "paged.import-report",
    });
    expect(h.root.querySelector("[data-import-report-empty]")).not.toBeNull();
    expect(operationOfKey("paged.svg", "svg").format).toBe("svg");
  });

  test("a report: summary, risk, entries; code on demand; a page click goes there", async () => {
    covers("panel:paged.import-report");
    const h = await mountPanel(ImportReportPanel, {
      id: "paged.import-report",
      scene: async ({ client }) => {
        await client.mutate({ op: "insertPage", args: {} } as never);
        return null;
      },
    });
    await h.act(() =>
      recordCompatReport(h.scope, {
        id: "test|import",
        direction: "import",
        format: "svg",
        name: "art.svg",
        losses: [
          { code: "filter", count: 2, severity: "dropped", pages: [1] },
          {
            code: "idml.gradient.conic",
            count: 1,
            severity: "approximated",
            message: "A conic gradient drawn as a linear one",
          },
        ],
        source: "test",
      }),
    );
    const card = h.root.querySelector("[data-import-report]")!;
    expect(card.getAttribute("data-format")).toBe("svg");
    expect(
      card.querySelector("[data-import-report-summary]")!.textContent,
    ).toBe("Imported art.svg · 2 unsupported effects · 1 converted object");
    expect(
      card.querySelector("[data-import-report-risk]")!.textContent,
    ).toContain("SVG");
    const rows = [...card.querySelectorAll("[data-loss]")];
    expect(rows.map((r) => r.getAttribute("data-loss-severity"))).toEqual([
      "dropped",
      "approximated",
    ]);
    expect(rows[1]!.querySelector("[data-loss-explanation]")!.textContent).toBe(
      "A conic gradient drawn as a linear one",
    );
    // The technical code only on demand (UXI-ASY-011).
    expect(card.textContent).not.toContain("idml.gradient.conic");
    await h.user.click(rows[1]!.querySelector("[data-loss-code-toggle]")!);
    expect(rows[1]!.querySelector("[data-loss-code-text]")!.textContent).toBe(
      "idml.gradient.conic",
    );
    // The report announced itself once, with View report.
    const toasts = operationFeedbackOf(h.scope).snapshot().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.report.actions?.[0]?.command).toBe(
      "paged.panel.show.paged.import-report",
    );
    // Clear takes it away.
    await h.user.click(card.querySelector("[data-import-report-clear]")!);
    expect(h.root.querySelector("[data-import-report]")).toBeNull();
  });
});
