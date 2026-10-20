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

// The print-output facts (ADR 265), surface by surface. Three documents:
// one with no CMYK working space, one that DECLARES a profile the editor
// has no bytes for, and one whose profile is registered and active. For
// each, every surface that names the working profile, the output intent
// or the print PDF's standard must say the same thing:
//
//   - the Prepress bar's working-profile chip,
//   - the PDF/X-4 checklist's "CMYK working space active" row,
//   - Publication health's and the Document Map's print readiness,
//   - the Export Center's and the Export inspector's Print PDF pill.
//
// Found while filming: the bar read "Coated FOGRA39" while the checklist
// failed the working space, and Health warned "No output intent" while
// Export read "Ready · PDF 1.7".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { CanvasClient } from "@paged-media/client";

import { PrepressToolbar } from "../../src/cockpit/toolbars";
import { DocumentMapPanel } from "../../src/panels/cockpit/document-map-panel";
import { ExportCenterPanel } from "../../src/panels/cockpit/export-center-panel";
import { setSelectedExportTarget } from "../../src/panels/cockpit/export-targets";
import { ExportInspectorPanel } from "../../src/panels/cockpit/export-views";
import { OutputReadinessPanel } from "../../src/panels/cockpit/mode-inspectors";
import { PublicationHealthPanel } from "../../src/panels/cockpit/publication-health-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  activateProfile,
  declaredProfileDocument,
  pill,
  PRESS_PROFILE,
} from "./support/cockpit";

beforeEach(() => setSelectedExportTarget("pdf-x4"));
afterEach(unmountAll);

type H = PanelHarness<unknown>;

/** The three documents. */
type Case = "none" | "declared" | "active";
const document = (c: Case) =>
  c === "none" ? ("blank" as const) : declaredProfileDocument();
const scene = (c: Case) =>
  c === "active"
    ? async ({ client }: { client: CanvasClient }) => activateProfile(client)
    : undefined;

const mount = (panel: Parameters<typeof mountPanel>[0], id: string, c: Case) =>
  mountPanel(panel, { id, document: document(c), scene: scene(c) });

/** What each surface says, per case. One table: the surfaces agree. */
const EXPECT: Record<
  Case,
  { chip: string; cmykPass: string; cmykDetail: string; print: string }
> = {
  none: {
    chip: "No CMYK profile",
    cmykPass: "false",
    cmykDetail: "No CMYK profile",
    print: "Ready · PDF 1.7",
  },
  declared: {
    chip: `${PRESS_PROFILE} · not loaded`,
    cmykPass: "false",
    cmykDetail: `${PRESS_PROFILE} · not loaded`,
    print: "Ready · PDF 1.7",
  },
  active: {
    chip: PRESS_PROFILE,
    cmykPass: "true",
    cmykDetail: PRESS_PROFILE,
    print: "Ready · X-4",
  },
};

const chip = (h: H) =>
  h.root.querySelector<HTMLElement>('[data-cockpit-action="output-profile"]')!;
const cmykRow = (h: H) =>
  h.root.querySelector<HTMLElement>('[data-readiness-row="cmyk"]')!;

for (const c of ["none", "declared", "active"] as const) {
  describe(`print-output facts: ${c} working space`, () => {
    test("the meta the surfaces read", async () => {
      covers("panel:paged.output-readiness");
      const h = await mount(OutputReadinessPanel, "paged.output-readiness", c);
      const meta = await h.client.documentMeta();
      expect(meta.cmykProfileName ?? null).toBe(
        c === "none" ? null : PRESS_PROFILE,
      );
      expect(meta.cmykProfileActive ?? false).toBe(c === "active");
    });

    test("the Prepress bar names the profile the checklist checks", async () => {
      const h = await mount(PrepressToolbar, "test.prepress-bar", c);
      expect(chip(h).textContent).toBe(EXPECT[c].chip);
    });

    test("the PDF/X-4 checklist's working-space row", async () => {
      covers("panel:paged.output-readiness");
      const h = await mount(OutputReadinessPanel, "paged.output-readiness", c);
      expect(cmykRow(h).getAttribute("data-readiness-pass")).toBe(
        EXPECT[c].cmykPass,
      );
      expect(cmykRow(h).textContent).toContain(EXPECT[c].cmykDetail);
    });

    test("Publication health reads the Export Center's Print PDF pill", async () => {
      covers("panel:paged.publication-health");
      const h = await mount(
        PublicationHealthPanel,
        "paged.publication-health",
        c,
      );
      expect(pill(h.root, "print-readiness")).toEqual({
        text: EXPECT[c].print,
        tone: "ready",
      });
    });

    test("the Document Map's health footer reads the same pill", async () => {
      covers("panel:paged.document-map");
      const h = await mount(DocumentMapPanel, "paged.document-map", c);
      expect(pill(h.root, "map-print-readiness")).toEqual({
        text: EXPECT[c].print,
        tone: "ready",
      });
    });

    test("the Export Center and the Export inspector", async () => {
      covers("panel:paged.export-center");
      covers("panel:paged.export-inspector");
      const center = await mount(ExportCenterPanel, "paged.export-center", c);
      expect(pill(center.root, "readiness-pdf-x4")).toEqual({
        text: EXPECT[c].print,
        tone: "ready",
      });
      const inspector = await mount(
        ExportInspectorPanel,
        "paged.export-inspector",
        c,
      );
      expect(pill(inspector.root, "export-inspector-readiness")).toEqual({
        text: EXPECT[c].print,
        tone: "ready",
      });
      // Without an output intent the pill says why it is PDF 1.7.
      const title = center.root
        .querySelector('[data-status-pill="readiness-pdf-x4"]')!
        .getAttribute("title");
      if (c === "active") expect(title).toBeNull();
      else expect(title).toContain("No output intent");
    });
  });
}
