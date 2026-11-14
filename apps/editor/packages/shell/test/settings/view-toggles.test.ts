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

// Settings `view.textThreads`, `view.snapToPoints`, `view.headingAnchors`,
// `view.dataMarkers`
// (view-toggles.ts): the View-menu toggles an overlay or a tool reads and
// a command flips. Module-scope and in memory: they survive a dock
// close/reopen, and a reload starts from the defaults.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  getViewToggle,
  viewModeOf,
  resetViewToggles,
  setViewToggle,
  subscribeViewToggles,
  toggleViewToggle,
  type ViewToggle,
} from "../../src/state/view-toggles";
import { createEditorScope } from "../../src/state/editor-scope";
import { memoryStorage, setEditorStorage } from "../../src/state/storage";
import { overlayShown } from "../../src/state/editing-aids";

// The toggles are an editor's (plan task E1): each test is a new one.
let scope = createEditorScope();
afterEach(() => {
  scope = createEditorScope();
});

const DEFAULTS: Record<ViewToggle, boolean> = {
  textThreads: false,
  snapToPoints: true,
  headingAnchors: false,
  dataMarkers: false,
  // Editor ADR 1223.
  issueMarkers: false,
  // Editor ADR 287.
  outline: false,
  overprintPreview: false,
  pixelPreview: false,
  showGrid: false,
  pixelGrid: true,
  snapToGrid: false,
  snapToPixel: false,
  smartGuides: true,
  // Editor ADR "Editing aids and Proof view".
  frameEdges: false,
  marginsColumns: true,
  guides: true,
  baselineGrid: false,
  oversetMarkers: true,
  hiddenCharacters: false,
  nonprinting: true,
};

describe("view toggles", () => {
  test("defaults: threads off, snap to points on, heading anchors and data markers off", () => {
    covers(
      "setting:view.textThreads",
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
      "setting:view.outline",
      "setting:view.overprintPreview",
      "setting:view.pixelPreview",
      "setting:view.showGrid",
      "setting:view.pixelGrid",
      "setting:view.snapToGrid",
      "setting:view.snapToPixel",
      "setting:view.smartGuides",
    );
    for (const [k, v] of Object.entries(DEFAULTS))
      expect({ k, v: getViewToggle(scope, k as ViewToggle) }).toEqual({ k, v });
  });

  test("each flag changes alone, and toggling returns the new value", () => {
    covers(
      "setting:view.textThreads",
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
    );
    for (const k of Object.keys(DEFAULTS) as ViewToggle[]) {
      resetViewToggles(scope);
      expect(toggleViewToggle(scope, k)).toBe(!DEFAULTS[k]);
      for (const other of Object.keys(DEFAULTS) as ViewToggle[]) {
        expect({ k, other, v: getViewToggle(scope, other) }).toEqual({
          k,
          other,
          v: other === k ? !DEFAULTS[k] : DEFAULTS[other],
        });
      }
      expect(toggleViewToggle(scope, k)).toBe(DEFAULTS[k]);
    }
  });

  test("subscribers hear a change, never a no-op, and stop hearing on unsubscribe", () => {
    covers("setting:view.textThreads", "setting:view.snapToPoints");
    let heard = 0;
    const off = subscribeViewToggles(scope, () => heard++);
    setViewToggle(scope, "textThreads", false); // already false
    expect(heard).toBe(0);
    setViewToggle(scope, "textThreads", true);
    expect(heard).toBe(1);
    toggleViewToggle(scope, "snapToPoints");
    expect(heard).toBe(2);
    off();
    toggleViewToggle(scope, "snapToPoints");
    expect(heard).toBe(2);
  });

  test("the other view options are not persisted: a reload starts from the defaults", async () => {
    covers(
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
    );
    // A reload mounts a new editor, with a new scope, on the same storage.
    const storage = memoryStorage();
    const before = createEditorScope();
    setEditorStorage(before, storage);
    setViewToggle(before, "snapToPoints", false);
    setViewToggle(before, "headingAnchors", true);
    setViewToggle(before, "dataMarkers", true);
    const after = createEditorScope();
    setEditorStorage(after, storage);
    expect({
      snapToPoints: getViewToggle(after, "snapToPoints"),
      headingAnchors: getViewToggle(after, "headingAnchors"),
      dataMarkers: getViewToggle(after, "dataMarkers"),
    }).toEqual({
      snapToPoints: DEFAULTS.snapToPoints,
      headingAnchors: DEFAULTS.headingAnchors,
      dataMarkers: DEFAULTS.dataMarkers,
    });
  });

  test("the editing aids are remembered, each on its own, and read back field by field", () => {
    covers(
      "setting:paged.view.editingAids",
      "setting:view.textThreads",
      "setting:view.frameEdges",
      "setting:view.marginsColumns",
      "setting:view.guides",
      "setting:view.baselineGrid",
      "setting:view.oversetMarkers",
      "setting:view.hiddenCharacters",
      "setting:view.nonprinting",
    );
    const storage = memoryStorage();
    const before = createEditorScope();
    setEditorStorage(before, storage);
    setViewToggle(before, "frameEdges", true);
    setViewToggle(before, "guides", false);
    setViewToggle(before, "textThreads", true);
    expect(JSON.parse(storage.getItem("paged.view.editingAids")!)).toEqual({
      frameEdges: true,
      marginsColumns: true,
      guides: false,
      baselineGrid: false,
      textThreads: true,
      oversetMarkers: true,
      hiddenCharacters: false,
      nonprinting: true,
    });
    const after = createEditorScope();
    setEditorStorage(after, storage);
    expect(getViewToggle(after, "frameEdges")).toBe(true);
    expect(getViewToggle(after, "guides")).toBe(false);
    expect(getViewToggle(after, "textThreads")).toBe(true);
    expect(getViewToggle(after, "baselineGrid")).toBe(false);

    // A stale or hand-edited value: what is not a boolean is ignored, an
    // unknown key is dropped, the rest is taken.
    const edited = memoryStorage();
    edited.setItem(
      "paged.view.editingAids",
      JSON.stringify({ frameEdges: "yes", guides: false, snapToPoints: false }),
    );
    const third = createEditorScope();
    setEditorStorage(third, edited);
    expect(getViewToggle(third, "frameEdges")).toBe(false);
    expect(getViewToggle(third, "guides")).toBe(false);
    expect(getViewToggle(third, "snapToPoints")).toBe(true);
    edited.setItem("paged.view.editingAids", "not json");
    const fourth = createEditorScope();
    setEditorStorage(fourth, edited);
    expect(getViewToggle(fourth, "guides")).toBe(true);
  });

  test("reset restores the defaults and tells subscribers once", () => {
    covers("setting:view.headingAnchors");
    setViewToggle(scope, "headingAnchors", true);
    setViewToggle(scope, "textThreads", true);
    let heard = 0;
    const off = subscribeViewToggles(scope, () => heard++);
    resetViewToggles(scope);
    expect(heard).toBe(1);
    resetViewToggles(scope); // nothing to reset
    expect(heard).toBe(1);
    off();
    expect(getViewToggle(scope, "headingAnchors")).toBe(false);
  });
});

describe('the overlay rule (editor ADR "Editing aids and Proof view")', () => {
  test("an aid's overlay draws while its aid is on and the view is not a proof", () => {
    covers("setting:view.frameEdges", "setting:view.guides");
    const on = (which: ViewToggle) => getViewToggle(scope, which);
    expect(overlayShown("paged.overlay.frameEdges", on, "normal")).toBe(false);
    setViewToggle(scope, "frameEdges", true);
    expect(overlayShown("paged.overlay.frameEdges", on, "normal")).toBe(true);
    expect(overlayShown("paged.overlay.frameEdges", on, "preview")).toBe(false);
    expect(overlayShown("paged.guide-overlay", on, "normal")).toBe(true);
    setViewToggle(scope, "guides", false);
    expect(overlayShown("paged.guide-overlay", on, "normal")).toBe(false);
    expect(overlayShown("paged.ruler-guides", on, "normal")).toBe(false);
  });

  test("Proof view hides the editing chrome, keeps the gesture feedback and shows its surface", () => {
    const on = (which: ViewToggle) => getViewToggle(scope, which);
    for (const mode of ["preview", "bleed", "slug"] as const) {
      expect(overlayShown("paged.selection-chrome", on, mode)).toBe(false);
      expect(overlayShown("paged.resize-handles", on, mode)).toBe(false);
      expect(overlayShown("paged.margin-guides", on, mode)).toBe(false);
      expect(overlayShown("paged.page-decorations", on, mode)).toBe(false);
      expect(overlayShown("paged.marquee", on, mode)).toBe(true);
      expect(overlayShown("paged.caret", on, mode)).toBe(true);
      expect(overlayShown("paged.overlay.proofSurface", on, mode)).toBe(true);
    }
    expect(overlayShown("paged.selection-chrome", on, "normal")).toBe(true);
    expect(overlayShown("paged.overlay.proofSurface", on, "normal")).toBe(
      false,
    );
    // Without a screen mode (no provider) nothing is a proof.
    expect(overlayShown("paged.selection-chrome", on, null)).toBe(true);
  });
});

describe("view modes (editor ADR 287)", () => {
  test("the toggles add up to one engine mode, Outline first", () => {
    covers(
      "setting:view.outline",
      "setting:view.overprintPreview",
      "setting:view.pixelPreview",
      "setting:view.showGrid",
      "setting:view.pixelGrid",
      "setting:view.snapToGrid",
      "setting:view.snapToPixel",
      "setting:view.smartGuides",
    );
    expect(viewModeOf(scope)).toBe("preview");
    setViewToggle(scope, "overprintPreview", true);
    expect(viewModeOf(scope)).toBe("overprintPreview");
    setViewToggle(scope, "outline", true);
    expect(viewModeOf(scope)).toBe("outline");
    setViewToggle(scope, "outline", false);
    expect(viewModeOf(scope)).toBe("overprintPreview");
  });

  test("Overprint Preview and Pixel Preview exclude each other", () => {
    covers("setting:view.overprintPreview", "setting:view.pixelPreview");
    setViewToggle(scope, "overprintPreview", true);
    setViewToggle(scope, "pixelPreview", true);
    expect(getViewToggle(scope, "overprintPreview")).toBe(false);
    expect(viewModeOf(scope)).toBe("pixelPreview");
    toggleViewToggle(scope, "overprintPreview");
    expect(getViewToggle(scope, "pixelPreview")).toBe(false);
    expect(viewModeOf(scope)).toBe("overprintPreview");
    // Turning one OFF leaves the other alone.
    setViewToggle(scope, "overprintPreview", false);
    expect(viewModeOf(scope)).toBe("preview");
  });
});
