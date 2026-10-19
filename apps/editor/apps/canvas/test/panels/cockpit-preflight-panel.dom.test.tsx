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

// Preflight (paged.preflight): "Validate output" runs the real PDF export
// (the bytes are discarded) and lists the exporter's structured findings
// by severity, each a jump to its page; the Links section lists the
// document's placed links.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { setCockpitPageNavigator } from "@paged-media/shell";

import { PreflightPanel } from "../../src/panels/cockpit/preflight-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { action, linksDocument, pill } from "./support/cockpit";

afterEach(() => {
  setCockpitPageNavigator(null);
  unmountAll();
});

type H = PanelHarness<unknown>;

const mount = (document?: "none" | "blank" | Uint8Array) =>
  mountPanel(PreflightPanel, { id: "paged.preflight", document });

/** A document load resets the module-level findings store (File ▸ Open
 *  does the same), so "not validated yet" holds whatever ran before. */
async function freshLoad(h: H, bytes?: Uint8Array) {
  await h.act(async () => {
    if (bytes) await h.client.loadDocument(bytes);
    else await h.client.newBlankDocument(612, 792);
  });
}

async function validate(h: H) {
  const from = h.mark();
  await h.click(action(h.root, "run-validation"));
  await h.settle();
  return h.sent(undefined, from);
}

describe("Preflight: states", () => {
  test("no document: Validate is disabled and the links ask for a document", async () => {
    covers("panel:paged.preflight");
    const h = await mount("none");
    expect(action(h.root, "run-validation").disabled).toBe(true);
    expect(h.root.textContent).toContain("Open a document to inspect links.");
    expect(pill(h.root, "validation-state")).toBeNull();
  });

  test("a blank page: Validate is offered, nothing has run, no links", async () => {
    covers("panel:paged.preflight");
    const h = await mount();
    await freshLoad(h);
    expect(action(h.root, "run-validation").disabled).toBe(false);
    expect(action(h.root, "run-validation").textContent).toBe(
      "Validate output",
    );
    expect(pill(h.root, "validation-state")).toBeNull();
    expect(h.root.textContent).toContain("No placed links.");
  });

  test("the Links section lists each placed link by its host kind and file name", async () => {
    covers("panel:paged.preflight");
    const h = await mount(linksDocument());
    const rows = [...h.root.querySelectorAll("[data-preflight-link]")].map(
      (r) => r.textContent,
    );
    expect(rows).toEqual(["Rectanglelow-res-photo.jpg", "Rectanglecover.tif"]);
  });
});

describe("Preflight: Validate output", () => {
  test("runs the real PDF export: begin (PDF 1.7), one call per page, finish", async () => {
    covers("panel:paged.preflight");
    const h = await mount(linksDocument());
    const sent = await validate(h);
    expect(sent.map((m) => [m.kind, m.payload])).toEqual([
      ["exportPdfBegin", { options: { standard: "pdf17" } }],
      ["exportPdfPage", { session: 1 }],
      ["exportPdfPage", { session: 1 }],
      ["exportPdfFinish", { session: 1 }],
    ]);
    expect(h.mutations()).toEqual([]);
  });

  test("a clean document: No findings, and says it exports cleanly", async () => {
    covers("panel:paged.preflight");
    const h = await mount();
    await validate(h);
    expect(pill(h.root, "validation-state")).toEqual({
      text: "No findings",
      tone: "ok",
    });
    expect(h.root.querySelector("[data-preflight-clean]")?.textContent).toBe(
      "No findings — the document exports cleanly.",
    );
  });

  test("missing links: two warnings, grouped, each naming its page", async () => {
    covers("panel:paged.preflight");
    const h = await mount(linksDocument());
    await validate(h);
    expect(pill(h.root, "validation-state")).toEqual({
      text: "2 finding(s)",
      tone: "warn",
    });
    expect(
      h.root.querySelector('[data-preflight-group="warnings"]')?.textContent,
    ).toBe("Warnings · 2");
    expect(h.root.querySelector('[data-preflight-group="errors"]')).toBeNull();
    const findings = [
      ...h.root.querySelectorAll<HTMLButtonElement>("[data-preflight-finding]"),
    ];
    expect(
      findings.map((f) => [
        f.getAttribute("data-finding-code"),
        f.getAttribute("data-finding-page"),
        f.title,
        f.disabled,
      ]),
    ).toEqual([
      ["image_link_missing", "0", "Go to page 1", false],
      ["image_link_missing", "0", "Go to page 1", false],
    ]);
  });

  test("a finding with a page jumps the canvas there", async () => {
    covers("panel:paged.preflight");
    const h = await mount(linksDocument());
    const jumps: number[][] = [];
    setCockpitPageNavigator((pages) => jumps.push(pages));
    await validate(h);
    await h.click(h.root.querySelector("[data-preflight-finding]")!);
    expect(jumps).toEqual([[0]]);
  });

  test("validating again replaces the findings, it does not add to them", async () => {
    covers("panel:paged.preflight");
    const h = await mount(linksDocument());
    await validate(h);
    await validate(h);
    expect(h.root.querySelectorAll("[data-preflight-finding]").length).toBe(2);
  });
});

describe("Preflight: findings", () => {
  // The links collection carries every placement's effective PPI (Health
  // and Output readiness count the low-res ones from it), yet the section
  // said those checks waited for the engine. Fixed: it runs the check.
  test(
    "PN-302: Images & bleed reports the effective-PPI check the links already carry, not a seam",
    async () => {
      covers("panel:paged.preflight");
      const h = await mount(linksDocument());
      const links = (await h.client.collection("links")) as Array<{
        effectivePpi: number | null;
      }>;
      expect(links.map((l) => l.effectivePpi)).toEqual([72, 300]);
      const section = [...h.root.querySelectorAll("button")].find(
        (b) => b.textContent === "Images & bleed",
      )!;
      await h.click(section);
      expect(h.root.textContent).not.toContain(
        "Effective-PPI and bleed-coverage checks land with the engine's preflight accessors.",
      );
      // The check itself: the 72-ppi placement is the low one.
      expect(h.root.textContent).toContain("1 of 2 placed images below 150 ppi");
    },
  );
});
