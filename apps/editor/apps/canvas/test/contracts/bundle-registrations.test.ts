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

// THE TWO-WAY CHECK, for every bundle the editor ships (ADR 226).
//
// The host adapter refuses to register what a manifest does not declare.
// Nothing caught the other direction — a manifest promising a tool, panel,
// command, importer, edit context or object kind that the bundle never
// registers — until plugin-sdk's `checkManifestConformance`. This runs it
// over each entry of the editor's bundle table, against the real headless
// engine.
//
// WHY HERE. The editor's canvas app is the one package that depends on all
// nine bundles, plugin-sdk and canvas-wasm. A module may import only the
// contract and its own packages, and platform/extensions only the public
// packages (the lint zones of PM-0002/PM-0003), so neither can host a
// cross-bundle spec; the root `tests/contracts/` the test plan names has no
// package, runner or CI task yet. When it does, this file moves there
// unchanged.
//
// CONDITIONAL REGISTRATIONS are handled one by one, below:
//  · most are gated on a host feature (`host.supports(...)`); the check's
//    host must answer each one true, and `conditions` names every one, so
//    a feature the harness stops answering fails HERE with its name rather
//    than as an unexplained missing id;
//  · slide's Slides and Notes panels also need the page doors
//    (`viewport.pages@1`), which no headless host has by default: the check
//    DRIVES it by handing the harness a pages backend;
//  · nothing in the nine bundles registers a manifest category later than
//    activation (sceneLayer surfaces, data providers and binding providers
//    open lazily, but none of them is declared in `contributes`).
// No bundle needs an allowance, so `allow` is empty for all nine; one, if it
// is ever needed, must give its reason and is reported once it goes stale.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { BundleHost, PagedBundle } from "@paged-media/plugin-api";
import {
  CONTRIBUTION_CATEGORIES,
  checkManifestConformance,
  type ManifestAllowance,
  type ManifestConformanceOptions,
} from "@paged-media/plugin-sdk";

import { PLUGIN_BUNDLES } from "../../src/plugin-bundle-table";

// The engine is this app's own @paged-media/canvas-wasm dependency.
const ENGINE_ANCHOR = fileURLToPath(new URL("../..", import.meta.url));

/** A host feature a bundle probes before it registers something. */
interface Condition {
  feature: string;
  /** What the bundle registers only when the feature is there. */
  gates: string;
}

interface BundleCheck {
  conditions: readonly Condition[];
  /** Harness options that drive a trigger (a capability no headless host
   *  has by default). */
  options?: Pick<ManifestConformanceOptions, "pages">;
  allow?: readonly ManifestAllowance[];
}

const IMPORTER = "contribute.importer@1";
const EXPORTER = "contribute.exporter@1";
const OBJECT_MODEL = "contribute.objectModel@1";
const SCHEMA_PANEL = "contribute.schemaPanel@1";
const EDIT_CONTEXT = "contribute.editContext@1";
const OBJECT_TYPE = "contribute.objectType@1";

/** An inert page backend: enough for `supports("viewport.pages@1")`. */
const PAGES: NonNullable<ManifestConformanceOptions["pages"]> = {
  goToPage: () => false,
  activePage: () => null,
  onDidChangeActivePage: () => () => {},
};

/** The nine built-ins, PINNED. The table is what the check iterates; this
 *  is the third party that notices a bundle leaving it (or a tenth joining
 *  without a row here). Every condition was read from the bundle's source
 *  (`host.supports(...)` before a `host.contribute.*` call). */
const CHECKS: Record<string, BundleCheck> = {
  "media.paged.draw": {
    conditions: [
      { feature: IMPORTER, gates: "importer.svg (io/svg.ts)" },
      { feature: EXPORTER, gates: "exporter.svg (io/svg.ts)" },
      {
        feature: OBJECT_MODEL,
        gates: "the object model, and with it panel.properties (activate.ts)",
      },
    ],
  },
  "media.paged.web": {
    conditions: [
      { feature: IMPORTER, gates: "importer.html" },
      { feature: OBJECT_MODEL, gates: "the object model" },
      {
        feature: SCHEMA_PANEL,
        gates: "panel.properties (also needs the object model)",
      },
    ],
  },
  "media.paged.data": {
    conditions: [
      { feature: IMPORTER, gates: "importer.table" },
      { feature: EDIT_CONTEXT, gates: "the dataBinding edit context" },
      { feature: OBJECT_MODEL, gates: "the object model" },
      {
        feature: SCHEMA_PANEL,
        gates: "panel.objects (also needs the object model)",
      },
    ],
  },
  "media.paged.sheet": {
    // The object model registers unconditionally.
    conditions: [
      { feature: SCHEMA_PANEL, gates: "panel.properties" },
      { feature: OBJECT_TYPE, gates: "the sheetFrame object type" },
      { feature: EDIT_CONTEXT, gates: "the sheet edit context" },
      { feature: IMPORTER, gates: "importer.xlsx, importer.csv" },
      { feature: EXPORTER, gates: "exporter.xlsx" },
    ],
  },
  "media.paged.image": {
    conditions: [
      { feature: IMPORTER, gates: "importer.raster" },
      { feature: EXPORTER, gates: "exporter.psd, exporter.png, exporter.jpeg" },
      { feature: EDIT_CONTEXT, gates: "the rasterImage edit context" },
      { feature: OBJECT_MODEL, gates: "the object model" },
      {
        feature: SCHEMA_PANEL,
        gates: "panel.properties (also needs the object model)",
      },
    ],
  },
  "media.paged.publish": {
    conditions: [
      { feature: IMPORTER, gates: "importer.idml" },
      { feature: EXPORTER, gates: "exporter.idml" },
      {
        feature: OBJECT_MODEL,
        gates:
          "the typed commands (exportPdf, exportIdml, exportPaged, importIdml)",
      },
    ],
  },
  "media.paged.pdf": {
    conditions: [
      { feature: IMPORTER, gates: "importer.pdf" },
      { feature: OBJECT_MODEL, gates: "the typed command importPdf" },
    ],
  },
  "media.paged.doc": {
    conditions: [
      { feature: IMPORTER, gates: "importer.docx" },
      { feature: EXPORTER, gates: "exporter.docx" },
      { feature: OBJECT_TYPE, gates: "the wordDocument object type" },
      { feature: EDIT_CONTEXT, gates: "the wordDocument edit context" },
      { feature: OBJECT_MODEL, gates: "the object model" },
      {
        feature: SCHEMA_PANEL,
        gates: "panel.properties (also needs the object model)",
      },
    ],
  },
  "media.paged.slide": {
    conditions: [
      {
        feature: OBJECT_MODEL,
        gates: "the object model, and with it the schema panels",
      },
      { feature: IMPORTER, gates: "importer.pptx" },
      { feature: EXPORTER, gates: "exporter.pptx (with storage.parts@1)" },
      { feature: "storage.parts@1", gates: "exporter.pptx" },
      {
        feature: SCHEMA_PANEL,
        gates:
          "panel.slide, .transition, .placeholder, .deck (and .notes without the page doors)",
      },
      { feature: "contribute.panel@1", gates: "panel.slides, panel.notes" },
      { feature: "render.snapshot@1", gates: "panel.slides, panel.notes" },
      {
        feature: "viewport.pages@1",
        gates:
          "panel.slides, panel.notes — DRIVEN: the check passes a pages backend",
      },
    ],
    options: { pages: PAGES },
  },
};

describe("every bundle the editor ships registers what its manifest declares, and nothing else", () => {
  test("the bundle table holds exactly the pinned built-ins", () => {
    expect(PLUGIN_BUNDLES.map((b) => b.id).sort()).toEqual(
      Object.keys(CHECKS).sort(),
    );
  });

  for (const entry of PLUGIN_BUNDLES) {
    const check = CHECKS[entry.id];
    test(
      entry.id,
      async () => {
        expect(check).toBeDefined();
        const bundle = (await entry.load()) as unknown as PagedBundle;
        expect(bundle.manifest.id).toBe(entry.id);

        let unsupported: string[] = [];
        const report = await checkManifestConformance(bundle, {
          resolveFrom: ENGINE_ANCHOR,
          ...check!.options,
          allow: check!.allow ?? [],
          drive(_h, host: BundleHost) {
            unsupported = check!.conditions
              .filter((c) => !host.supports(c.feature))
              .map((c) => `${c.feature} (gates ${c.gates})`);
          },
        });

        // A missing feature first: it explains any id missing below.
        expect(unsupported).toEqual([]);
        const drift = CONTRIBUTION_CATEGORIES.flatMap((cat) => [
          ...report.categories[cat].declaredNotRegistered.map(
            (id) => `${cat}: declared, never registered: ${id}`,
          ),
          ...report.categories[cat].registeredNotDeclared.map(
            (id) => `${cat}: registered, not declared: ${id}`,
          ),
        ]);
        expect(drift).toEqual([]);
        expect(report.unusedAllowances).toEqual([]);
        // In 'warn' mode an undeclared door use is logged, not refused.
        expect(report.warnings).toEqual([]);
        expect(report.ok).toBe(true);
      },
      60_000,
    );
  }
});

describe("the check has teeth against a real bundle", () => {
  test("a declared tool draw never registers, and a command draw registers undeclared", async () => {
    const entry = PLUGIN_BUNDLES.find((b) => b.id === "media.paged.draw")!;
    const draw = (await entry.load()) as unknown as PagedBundle;
    const c = draw.manifest.contributes!;
    const [dropped, ...commands] = c.commands!;
    const ghost = "media.paged.draw.tool.ghost";
    const report = await checkManifestConformance(
      {
        ...draw,
        manifest: {
          ...draw.manifest,
          contributes: { ...c, tools: [...c.tools!, ghost], commands },
        },
      },
      { resolveFrom: ENGINE_ANCHOR },
    );
    expect(report.ok).toBe(false);
    expect(report.categories.tools.declaredNotRegistered).toEqual([ghost]);
    expect(report.categories.commands.registeredNotDeclared).toEqual([dropped]);
  }, 60_000);
});
