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

// Publication health (paged.publication-health): the document's counts
// and risks. Document tiles read the meta, the load's stats and the links
// collection; the risk rows count missing links, low-res placements and
// missing fonts live from the collections, overset stories from the
// stats, and preflight findings once Validate output has run.
//
// The UX audit's F-09 has two halves: Health counts a document's missing
// links (asserted here, it does) and Problems says "No problems detected"
// for the same document (the Problems panel's file holds that half).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { PublicationHealthPanel } from "../../src/panels/cockpit/publication-health-panel";
import { recordFindings } from "../../src/panels/cockpit/preflight-findings";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { linksDocument, pill } from "./support/cockpit";

afterEach(unmountAll);

type H = PanelHarness<unknown>;

/** Risk row → its count ("—" for a seam). */
function risks(h: H): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of h.root.querySelectorAll("[data-risk-row]")) {
    out[row.getAttribute("data-risk-row")!] = row.hasAttribute("data-seam")
      ? "—"
      : (row.getAttribute("data-risk-count") ?? "");
  }
  return out;
}

/** Document tile label → value (a MetricTile: the value, then its
 *  label in pg-ui-xs; the risk rows are not tiles). */
function tiles(h: H): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of h.root.querySelectorAll(".pg-value")) {
    const label = value.nextElementSibling;
    if (label?.classList.contains("pg-ui-xs")) {
      out[label.textContent ?? ""] = value.textContent ?? "";
    }
  }
  return out;
}

/** The last-export findings live in a module store that a document load
 *  resets (as File ▸ Open does). A test that needs "never validated"
 *  reloads first: this mount's client then broadcasts documentLoaded. */
async function freshLoad(h: H, bytes?: Uint8Array) {
  await h.act(async () => {
    if (bytes) await h.client.loadDocument(bytes);
    else await h.client.newBlankDocument(612, 792);
  });
}

describe("Publication health: states", () => {
  test("no document: dashes and no readiness pill", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: "none",
    });
    expect(pill(h.root, "print-readiness")).toBeNull();
    expect(tiles(h)).toMatchObject({
      Pages: "—",
      Stories: "—",
      Frames: "—",
      "Color mode": "—",
    });
  });

  test("a document: pages, the load's counts and its placed links", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    expect(tiles(h)).toEqual({
      Pages: "2",
      Stories: "0",
      Frames: "2",
      Glyphs: "0",
      "Placed links": "2",
      "Color mode": "—",
    });
    // No CMYK working space, so no output intent: the print PDF is
    // PDF 1.7 and exports, the Export Center's own words (ADR 266).
    expect(pill(h.root, "print-readiness")).toEqual({
      text: "Ready · PDF 1.7",
      tone: "ready",
    });
  });

  test("UX F-09, the Health half: two missing links and one low-res placement are counted", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    await freshLoad(h, linksDocument());
    expect(risks(h)).toEqual({
      overset: "0",
      "missing-links": "2",
      "low-res": "1",
      fonts: "0",
      // Not validated yet: a seam, not zero.
      preflight: "—",
    });
  });

  test("a clean document reads 0 with a check, never a dash, for the live rows", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
    });
    await freshLoad(h);
    expect(risks(h)).toEqual({
      overset: "0",
      "missing-links": "0",
      "low-res": "0",
      fonts: "0",
      preflight: "—",
    });
  });

  test("a placed EPS whose bytes are there is not a missing link (engine ADR 207)", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
    });
    const pageId = h.handle?.pageIds[0];
    const placed = await h.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [72, 72, 200, 200] },
    } as never);
    const frame = (placed as { payload: { createdId: { id: string } } }).payload
      .createdId;
    await h.mutate({
      op: "placeImage",
      args: { elementId: frame.id, uri: "file:///assets/legacy.eps" },
    } as never);
    await h.mutate({
      op: "replaceImageBytes",
      args: {
        elementId: frame.id,
        bytes: Array.from(
          new TextEncoder().encode("%!PS-Adobe-3.0 EPSF-3.0\n%%EOF\n"),
        ),
      },
    } as never);
    expect(risks(h)["missing-links"]).toBe("0");
  });

  test("a font the text names and the session lacks is counted as it is applied", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      scene: richScene,
    });
    await h.mutate({
      op: "set",
      args: {
        address:
          "storyRange:" + (h.scene as { storyId: string }).storyId + "@0..5",
        path: "characterFontFamily",
        value: { type: "text", value: "Courier" },
      },
    } as never);
    expect(risks(h).fonts).toBe("1");
  });

  test("preflight findings count once an export has run: errors and warnings together", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
    });
    await freshLoad(h);
    expect(risks(h).preflight).toBe("—");
    await h.act(() =>
      recordFindings({
        findings: [
          { code: "a", severity: "error", message: "x", pageIndex: 0 },
          { code: "b", severity: "warning", message: "y", pageIndex: null },
        ] as never,
        diagnostics: [],
      }),
    );
    expect(risks(h).preflight).toBe("2");
    // A document load drops the last run's findings.
    await freshLoad(h);
    expect(risks(h).preflight).toBe("—");
  });

  test("it reads; it never writes", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    expect(h.mutations()).toEqual([]);
    // Its only buttons are the section toggles and the risk rows that
    // open where their findings are listed (PN-301); none writes.
    expect(
      [...h.root.querySelectorAll("button:not([data-risk-row])")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Document", "Risks"]);
    for (const b of h.root.querySelectorAll<HTMLElement>(
      "button[data-risk-row]",
    ))
      await h.click(b);
    expect(h.mutations()).toEqual([]);
  });
});

describe("Publication health: findings", () => {
  // UX audit F-44: "Publication health stays at '0 Stories, 0 Frames'
  // after the insert". The tiles read the stats the engine sends at load
  // and in reply to a content selection; an edit sends none.
  test("PN-300 (UX F-44): the Frames and Stories tiles follow an edit that adds a text frame", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    expect(tiles(h).Frames).toBe("2");
    await h.mutate({
      op: "insertTextFrame",
      args: { pageId: "cp2", bounds: [72, 72, 200, 300] },
    } as never);
    expect(tiles(h)).toMatchObject({ Frames: "3", Stories: "1" });
  });

  // A row with a count shows a chevron, the panel's "go there" sign (the
  // header says preflight "chevrons into the Preflight panel's
  // findings"), but the row is not a control: nothing opens.
  test("PN-301: a risk row with findings is a control that opens where they are listed", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(PublicationHealthPanel, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    const row = h.root.querySelector<HTMLElement>(
      '[data-risk-row="missing-links"]',
    )!;
    expect(row.getAttribute("data-risk-count")).toBe("2");
    expect(row.matches("button, a[href], [role=button], [role=link]")).toBe(
      true,
    );
  });
});
