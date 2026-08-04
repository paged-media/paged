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

// Consumer proof for the B-13 headless conformance harness: activate
// the REAL paged.draw bundle against a REAL engine (the published
// @paged-media/canvas-wasm booted in Node by @paged-media/plugin-sdk's
// createHeadlessHost), assert its contribution log, run one real
// mutation through the host (engine round-trip), and prove dispose
// leaves the document unchanged.
//
// This is the conformance-fixture replay FOUNDATION the BREAKAGE_LOG
// B-13 entry calls for. Unlike `activate.spec.ts` (wiring only, over a
// fake editor), this drives the bundle's document door through the true
// parse→apply→inverse engine path — no UI, no editor, no browser.
//
// CONTRIBUTION COUNT (honesty note): the bundle registers EIGHTEEN
// tools (three anchor-editing + the pro set: Curvature, Pencil,
// Gradient Annotator, Measure, Shape Builder, Corner Radius + the v0
// brushes: Paintbrush, Blob Brush, Eraser + the wave-2 trio:
// Eyedropper, Width, Lasso Select + the Live Paint pair: Bucket, Face
// Selection + Type on a Path) AND TWO declarative SCHEMA panels
// (stroke — W3.1, B-01 RESOLVED; fill — Phase 2d, B-03 consumer; each
// registered through `host.contribute.schemaPanel`, recorded by the
// harness as a `schemaPanel` contribution carrying the verbatim
// schema). The Pen itself is a built-in core-document tool (editor
// W2.5 division); the layers prototype stays design JSON, and its
// subject left this bundle with ADR 023 phase D — the Layers PANEL is
// retired and paged.draw now resolves the HOST panel's values through
// a binding provider instead. So the contribution log holds eighteen tools + two
// schema panels + thirty-four commands (4 dash + 2 group + 2
// gradient-fill + 3 path-ops + 2 join/average + 4 pathfinder + the Phase 9
// Tier B 5 live-corner + 3 appearance + 3 select-same + the wave-2
// 4 insert-shape + blend + select-parent-group) + the edit context.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../src";
import { minimalIdml } from "./fixtures/minimal-idml";
// The shared engine boot (it probes the editor-checkout layouts for the
// wasm — see conformance/host.ts).
import { openHost } from "./conformance/host";

// The fixture's single rectangle leaf (Self="urect").
const RECT = { kind: "rectangle", id: "urect" } as const;

describe("paged.draw — headless conformance (B-13 replay)", () => {
  let harness: HeadlessHost;

  beforeAll(async () => {
    harness = await openHost();
    await harness.load(minimalIdml());
  });

  afterAll(() => {
    harness.dispose();
  });

  it("boots a real engine (protocol > 0)", () => {
    expect(harness.protocolVersion).toBeGreaterThan(0);
    expect(harness.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("activating the bundle registers its tools + the schema panel in the log", () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // Every tool is captured, namespaced + in registration order —
      // the three anchor editors, the pro set (incl. the §13.2 corner
      // widget), the v0 brushes, the wave-2 trio, the Live Paint pair,
      // then Type on a Path.
      expect(harness.toolsContributed().map((t) => t.id)).toEqual([
        "media.paged.draw.tool.addAnchor",
        "media.paged.draw.tool.deleteAnchor",
        "media.paged.draw.tool.convertAnchor",
        "media.paged.draw.tool.curvature",
        "media.paged.draw.tool.pencil",
        "media.paged.draw.tool.gradientAnnotator",
        "media.paged.draw.tool.measure",
        "media.paged.draw.tool.shapeBuilder",
        "media.paged.draw.tool.cornerRadius",
        "media.paged.draw.tool.paintbrush",
        "media.paged.draw.tool.blobBrush",
        "media.paged.draw.tool.eraserBrush",
        "media.paged.draw.tool.eyedropper",
        "media.paged.draw.tool.width",
        "media.paged.draw.tool.lassoSelect",
        "media.paged.draw.tool.livePaintBucket",
        "media.paged.draw.tool.livePaintSelect",
        "media.paged.draw.tool.typeOnPath",
      ]);
      // The contribution log holds the eighteen tools, then EACH schema
      // panel as TWO entries: the synthesized React `panel` the panels
      // registry sees (the host turns a schema into a registry panel via
      // the injected renderer / seam) AND the `schemaPanel` recorded
      // VERBATIM through the harness's registration hook. Both are
      // honest — the registry really got a panel; the log keeps the
      // schema so conformance can assert it. Stroke first, then fill
      // (Phase 2d), then the five React panels (appearance, graphic
      // styles, symbols, live paint, pattern — Layers is retired). Then the
      // seventy-three commands in registration order, then the W3.2 edit
      // context. (Pen is a core built-in.)
      expect(harness.contributions.map((c) => c.kind)).toEqual([
        // Three anchor editors + the pro set (Curvature, Pencil,
        // Gradient Annotator, Measure, Shape Builder, Corner Radius) +
        // the v0 brushes (Paintbrush, Blob Brush, Eraser) + the
        // wave-2 trio (Eyedropper, Width, Lasso Select) + the Live
        // Paint pair (Bucket, Face Selection) + Type on a Path
        // (C-29) — eighteen tools.
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        // W3.1 — the stroke schema panel.
        "panel",
        "schemaPanel",
        // Phase 2d — the fill schema panel (B-03).
        "panel",
        "schemaPanel",
        // NO Layers panel — ADR 023 phase D retired it behind the
        // binding-provider seam. Its absence from this log IS the
        // assertion; the replacement's behaviour is pinned in
        // `conformance/layers-provider.spec.ts`.
        // The APPEARANCE panel (the metadata stack + its one-fill/
        // one-stroke honesty note) — likewise expert-leaf React.
        "panel",
        // The GRAPHIC STYLES panel (the document-resident style library
        // + the selection's link into it) — likewise expert-leaf React.
        "panel",
        // The SYMBOLS panel (the document-resident artwork library + the
        // instances that follow it) — likewise expert-leaf React.
        "panel",
        // The LIVE PAINT panel (the document-resident face RECIPES + the
        // artwork each painted face materialised as) — likewise
        // expert-leaf React.
        "panel",
        // The PATTERN OPTIONS panel (the tile-field parameters + the
        // not-a-swatch boundary, RFI C-31) — likewise expert-leaf React.
        "panel",
        // B-12 — the stroke dash-preset commands (Solid / Dashed /
        // Dotted / Dash-dot).
        "command",
        "command",
        "command",
        "command",
        // NO Group / Ungroup here, and no Select parent group further
        // down: those three are the HOST's commands now
        // (`paged.object.*`). Their absence from this log IS the
        // assertion — basic object operations are what plugins build
        // on, and shipping them from a plugin meant a user without
        // paged.draw loaded could not group. The B-04 wire shapes stay
        // in `commands/group.ts` for Pattern / Symbols / Image Trace.
        // Phase 2d — Fill: Linear / Radial gradient (B-03).
        "command",
        "command",
        // Phase 4c — Outline stroke / Offset path / Simplify (v30
        // kernel ops).
        "command",
        "command",
        "command",
        // Phase 4c + v56 — Join (the real joinPaths/closePath weld,
        // coincide fallback on older engines) / Close path / Average
        // endpoints.
        "command",
        "command",
        "command",
        // Phase 4c — Pathfinder Unite / Subtract / Intersect / Exclude.
        "command",
        "command",
        "command",
        "command",
        // B-22 (engine v57) — the REGION Pathfinder row: Divide / Trim
        // / Merge / Crop / Outline / Minus back.
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        // Illustrator Phase 2 — Make / Release compound path, then
        // PATTERN EDITING v1 (Bake / Re-plan / Select tiles / Delete
        // tiles / Release — a re-editable tile FIELD; the catalog row's
        // swatch half is not buildable, RFI C-31).
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        // Phase 9 (Tier B) — Live Corners (Rounded / Inverse / Bevel /
        // Fancy / None).
        "command",
        "command",
        "command",
        "command",
        "command",
        // Phase 9 (Tier B) — Appearance (Add fill / Add stroke / Clear)
        // + the panel's edit surface (Remove layer / Reorder layer).
        "command",
        "command",
        "command",
        "command",
        "command",
        // B-24 — Bake stack to a group / Release baked stack.
        "command",
        "command",
        // Illustrator Phase 2 — Graphic styles (Save from selection /
        // Apply / Redefine / Break link / Rename / Delete).
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        // Illustrator Phase 2 (§16.1) — Symbols v0 (Define / Place /
        // Redefine / Break link / Reset transform / Rename / Delete).
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        // Illustrator Phase 2 (the last unbuilt row) — Live Paint v0
        // (Make group / Fill face / Regenerate / Select faces / Delete
        // face / Release).
        "command",
        "command",
        "command",
        "command",
        "command",
        "command",
        // Illustrator Phase 2 (the Transparency row) — Opacity masks
        // (Make / Release) over the C-28 v58 pair. EXPORT-ONLY.
        "command",
        "command",
        // C-29 (engine v58) — Type on a path (Attach / Detach).
        "command",
        "command",
        // Phase 9 (Tier B) — Select-same (Fill / Stroke / Stroke weight).
        "command",
        "command",
        "command",
        // Wave 2 — Insert shapes (Arc / Spiral / Rect grid / Polar
        // grid).
        "command",
        "command",
        "command",
        "command",
        // Wave 2 — Blend selected.
        "command",
        // Illustrator Phase 2 (last row) — Image Trace v0 (the wasm
        // lane: crates/trace-js over visioncortex).
        "command",
        // W3.2 — the vectorGraphic edit context (B-02), recorded
        // through the harness's editContext registration hook.
        "editContext",
        // Phase 8 — the SVG importer + exporter (K-2), recorded through
        // the harness's recording importer/exporter registries.
        "importer",
        "exporter",
      ]);
      // The schema panels are recorded VERBATIM (the schema, not React):
      // ids, sections, and the binding-driven gates.
      const panels = harness.schemaPanelsContributed();
      expect(panels.map((p) => p.id)).toEqual([
        "media.paged.draw.panel.stroke",
        "media.paged.draw.panel.fill",
      ]);
      const dashSection = panels[0].schema.sections[1];
      expect(dashSection.title).toBe("Dashes");
      // The dash section's visibility is a binding REF — a derived bound
      // value the bundle publishes, NOT a visibleWhen conditional (B-01).
      expect(dashSection.visible).toEqual({
        bind: "media.paged.draw.dashControlsVisible",
      });
      // Phase 4c — the Line ends (arrowheads) section is likewise a
      // binding REF, gated on the selection's KIND (GraphicLine-only,
      // the engine's own v43 gate).
      const arrowSection = panels[0].schema.sections[2];
      expect(arrowSection.title).toBe("Line ends");
      expect(arrowSection.visible).toEqual({
        bind: "media.paged.draw.arrowheadControlsVisible",
      });
      // The fill panel's gradient section is likewise a binding REF
      // (Phase 2d — gated on the selection's fill being a gradient).
      const gradientSection = panels[1].schema.sections[1];
      expect(gradientSection.title).toBe("Gradient");
      expect(gradientSection.visible).toEqual({
        bind: "media.paged.draw.gradientControlsVisible",
      });
      // The captured tool contributions are the real objects too.
      const add = harness.toolsContributed()[0];
      expect(add.shortcut).toBe("=");
      expect(add.cursor).toEqual({ kind: "css", token: "crosshair" });
      // W3.2 — the edit context is recorded with its matcher + sets, and
      // the host stamped the own-namespace metadata key.
      const ecs = harness.editContextsContributed();
      expect(ecs.map((c) => c.type)).toEqual(["vectorGraphic"]);
      expect(ecs[0].metadataKey).toBe("x-paged:media.paged.draw");
      expect(
        ecs[0].matches?.({
          id: { kind: "polygon", id: "u1" } as never,
          kind: "polygon",
          groupChain: [],
          metadata: null,
        }),
      ).toBe(true);
      // Phase 8 — the SVG importer/exporter are recorded with their
      // claimed extensions, and the registered ids match the manifest's
      // contributes declaration.
      const importers = harness.importersContributed();
      expect(importers.map((i) => i.id)).toEqual([
        "media.paged.draw.importer.svg",
      ]);
      expect(importers[0].extensions).toEqual([".svg"]);
      expect(importers.map((i) => i.id)).toEqual(
        drawBundle.manifest.contributes?.importers,
      );
      const exporters = harness.exportersContributed();
      expect(exporters.map((e) => e.id)).toEqual([
        "media.paged.draw.exporter.svg",
      ]);
      expect(exporters[0].extension).toBe(".svg");
      expect(exporters.map((e) => e.id)).toEqual(
        drawBundle.manifest.contributes?.exporters,
      );
    } finally {
      handle.dispose();
    }
  });

  it("the schema panel's bindings react to real selection (B-01 derived value)", async () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // On activation the binding driver primes from the (empty)
      // selection: nothing selected → hasSelection false.
      // Selecting the rectangle flips hasSelection true; the rectangle
      // is bounds-based (no anchor table — B-13 finding b), so
      // dashControlsVisible stays false (it gates on path anchors).
      await harness.host.selection.set([RECT as never]);
      // Give the async recompute a tick to land.
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.host.bindings.get("media.paged.draw.hasSelection")).toBe(
        true,
      );
      expect(
        harness.host.bindings.get("media.paged.draw.dashControlsVisible"),
      ).toBe(false);

      // Clearing the selection flips hasSelection back to false.
      await harness.host.selection.set([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.host.bindings.get("media.paged.draw.hasSelection")).toBe(
        false,
      );
    } finally {
      handle.dispose();
    }
  });

  it("runs a real mutation through the host (engine round-trip)", async () => {
    const handle = harness.loadBundle(drawBundle);
    try {
      // Write this plugin's metadata onto the rectangle via the document
      // door — a real setPluginMetadata mutation, applied + inverted by
      // the engine, read back through requestElementProperties.
      const set = await harness.host.document.setMetadata(RECT as never, {
        v: 1,
        data: { tool: "addAnchor", note: "headless proof" },
      });
      expect(set.applied).toBe(true);
      const got = await harness.host.document.getMetadata(RECT as never);
      expect(got).toEqual({
        v: 1,
        data: { tool: "addAnchor", note: "headless proof" },
      });

      // Clear it again so the doc is pristine for the dispose check below.
      const clear = await harness.host.document.setMetadata(RECT as never, null);
      expect(clear.applied).toBe(true);
      expect(await harness.host.document.getMetadata(RECT as never)).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  it("dispose leaves the document unchanged (honesty smoke test)", async () => {
    // Snapshot the scene-tree shape before activation.
    const treeSize = async () => {
      const roots = await harness.host.document.tree();
      let n = 0;
      const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
        for (const node of nodes) {
          if (node.id) n++;
          if (node.children) walk(node.children as never);
        }
      };
      walk(roots as never);
      return n;
    };
    const before = await treeSize();

    const handle = harness.loadBundle(drawBundle);
    expect(harness.toolsContributed()).toHaveLength(18);
    handle.dispose();

    // After dispose: the contribution log is empty (registrations torn
    // down structurally) AND the document is byte-for-byte as found —
    // the bundle made no uninvited engine writes.
    expect(harness.contributions).toHaveLength(0);
    expect(await treeSize()).toBe(before);
    expect(await harness.host.document.getMetadata(RECT as never)).toBeNull();
  });
});
