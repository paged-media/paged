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

// `installStrokePanelBindings` — the driver behind the Stroke SCHEMA
// panel's gates. There is no React here (a schema panel is pure data the
// host renders), so this runs in the plain Node environment: what the
// driver PUBLISHES on a selection change and on a document change, and
// what each costs at the host doors (the perf-budgets.spec.ts rules: a
// COUNT, MEASURED, target beside it, only lowered).
//
// ISOLATION. The driver is installed HERE, over a counting host. The
// headless host is given the bundle's MANIFEST with an empty `activate`,
// so the bundle's own copy of this driver is not running beside it and
// every publish that lands is the one under test.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, Disposable, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
// Straight from the module: the bundle's index re-exports only two of
// these five binding names.
import {
  installStrokePanelBindings,
  BIND_APPEARANCE_CONTROLS_VISIBLE,
  BIND_ARROWHEAD_CONTROLS_VISIBLE,
  BIND_CORNER_CONTROLS_VISIBLE,
  BIND_DASH_CONTROLS_VISIBLE,
  BIND_HAS_SELECTION,
} from "../../src/panels/stroke-panel";
import { pathItem } from "../fixtures/build-idml";
import { openHost } from "../conformance/host";
import { countingHost, type WorkLog } from "../perf/counting-host";
import {
  documentChanges,
  panelDocument,
  plainChange,
  plainId,
  quiesce,
  rectItem,
  selectionChanges,
} from "./panel-document";

const RECT = { kind: "rectangle", id: "r0" } as ElementId;
const LINE = { kind: "graphicLine", id: "g0" } as ElementId;
const POLYGON = plainId(0);

describe("installStrokePanelBindings — what it publishes, and what that costs", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let work: WorkLog;
  /** What installing the driver cost (nothing was selected). */
  let installed: WorkLog;
  let sub: Disposable;

  /** The five gates as the HOST would look them up. */
  const gates = () => ({
    hasSelection: h.host.bindings.get(BIND_HAS_SELECTION),
    arrowheads: h.host.bindings.get(BIND_ARROWHEAD_CONTROLS_VISIBLE),
    corners: h.host.bindings.get(BIND_CORNER_CONTROLS_VISIBLE),
    appearance: h.host.bindings.get(BIND_APPEARANCE_CONTROLS_VISIBLE),
    dashes: h.host.bindings.get(BIND_DASH_CONTROLS_VISIBLE),
  });
  /** Do `fn` through the RAW host, wait for the driver, report its work. */
  const costOf = async (fn: () => Promise<unknown>) => {
    work.reset();
    await fn();
    await quiesce(work);
    return {
      publishes: work.count("bindings.publish"),
      reads: work.reads(),
    };
  };

  beforeAll(async () => {
    h = await openHost();
    await h.load(
      panelDocument(
        rectItem("r0", 40, 40) +
          pathItem("GraphicLine", "g0", "40 140 40 240", true, [
            { a: [140, 40] },
            { a: [240, 40] },
          ]),
      ),
    );
    // The manifest without the bundle's own drivers (see the header).
    h.loadBundle({
      manifest: drawBundle.manifest,
      activate: () => ({ dispose() {} }),
    });
    ({ host, work } = countingHost(h.host));
    sub = installStrokePanelBindings(host);
    await quiesce(work);
    installed = work.snapshot();
  });
  afterAll(() => {
    sub?.dispose();
    h?.dispose();
  });
  beforeEach(async () => {
    await h.host.selection.set([]);
    await quiesce(work);
  });

  it("installs by priming from the current selection and subscribing to the SELECTION only", () => {
    expect(installed.calls).toEqual({
      "selection.get": 1,
      "bindings.publish": 5,
      "selection.onDidChange": 1,
    });
    // No `document.onDidChange`: this driver never hears a document change.
    expect(installed.count("document.onDidChange")).toBe(0);
    expect(gates()).toEqual({
      hasSelection: false,
      arrowheads: false,
      corners: false,
      appearance: false,
      dashes: false,
    });
  });

  it("a selection change publishes all five gates, from the selection's KIND and one read", async () => {
    // A polygon: corners render, it is a path, it has no arrowheads.
    expect(await costOf(() => h.host.selection.set([POLYGON]))).toEqual({
      publishes: 5,
      // One `pathAnchors` — the dash gate asks "is this a path?".
      reads: 1,
    });
    expect(work.count("document.pathAnchors")).toBe(1);
    expect(gates()).toEqual({
      hasSelection: true,
      arrowheads: false,
      corners: true,
      appearance: true,
      dashes: true,
    });

    // A graphic line: the only kind with arrowheads, and no corners.
    await h.host.selection.set([LINE]);
    await quiesce(work);
    expect(gates()).toEqual({
      hasSelection: true,
      arrowheads: true,
      corners: false,
      appearance: true,
      dashes: true,
    });

    // A rectangle: corners, no arrowheads — and NO dash section. It is
    // bounds-based: `pathAnchors` answers no anchor table for it, so the
    // dash gate reads false although a rectangle's stroke dashes like any
    // other (the B-13 finding the driver's own comment records).
    await h.host.selection.set([RECT]);
    await quiesce(work);
    expect(gates()).toEqual({
      hasSelection: true,
      arrowheads: false,
      corners: true,
      appearance: true,
      dashes: false,
    });
  });

  it("clearing the selection publishes five falses and reads nothing", async () => {
    await h.host.selection.set([POLYGON]);
    await quiesce(work);
    expect(await costOf(() => h.host.selection.set([]))).toEqual({
      publishes: 5,
      reads: 0,
    });
    expect(gates()).toEqual({
      hasSelection: false,
      arrowheads: false,
      corners: false,
      appearance: false,
      dashes: false,
    });
  });

  it("only the FIRST selected element decides the kind gates", async () => {
    await h.host.selection.set([LINE, POLYGON]);
    await quiesce(work);
    expect(gates().arrowheads).toBe(true);
    expect(gates().corners).toBe(false);
  });

  it("a document change publishes NOTHING and costs nothing", async () => {
    await h.host.selection.set([POLYGON]);
    await quiesce(work);
    // The driver holds no document subscription, so nothing it derived
    // from the document (the dash gate's "is it a path?") is re-derived.
    expect(await costOf(() => plainChange(h, 0))).toEqual({ publishes: 0, reads: 0 });
    expect(work.calls).toEqual({});
  });

  it("a burst of 20 document changes = 0 publishes, 0 reads", async () => {
    await h.host.selection.set([POLYGON]);
    await quiesce(work);
    expect(await costOf(() => documentChanges(h))).toEqual({ publishes: 0, reads: 0 });
  });

  it("a burst of 20 selection changes = 100 publishes, 20 reads", async () => {
    expect(await costOf(() => selectionChanges(h))).toEqual({
      // 5 per change, every time, changed or not: four of the five did
      // not move once after the first. No debounce. TARGET 5 — the gates
      // of the selection the burst ends on (fewer still if an unchanged
      // value is not re-published).
      publishes: 100,
      // One `pathAnchors` per change. TARGET 1.
      reads: 20,
    });
    expect(gates().dashes).toBe(true);
  });

  // BUG (measured). `recompute` publishes four gates synchronously and
  // the fifth — the dash gate — after awaiting `pathAnchors`, and nothing
  // cancels or sequences it. When the selection is cleared while that
  // read is in flight, "nothing selected ⇒ false" is published FIRST and
  // the older read's "it is a path ⇒ true" lands on top of it: the Dashes
  // section stays visible with nothing selected (and `hasSelection`
  // false) until the next selection change. In the editor the window is
  // one worker round trip. Flip to `it` when a stale recompute is dropped.
  it.fails("the dash gate ends on the LATEST selection when two changes overlap", async () => {
    // Two changes with no reply in between — the second lands while the
    // first's `pathAnchors` is still out.
    await Promise.all([
      h.host.selection.set([POLYGON]),
      h.host.selection.set([]),
    ]);
    await quiesce(work);
    expect(h.host.selection.get()).toEqual([]);
    expect(gates().hasSelection).toBe(false);
    // MEASURED true.
    expect(gates().dashes).toBe(false);
  });

  it("dispose drops the subscription: a later selection change publishes nothing", async () => {
    sub.dispose();
    expect(await costOf(() => h.host.selection.set([POLYGON]))).toEqual({
      publishes: 0,
      reads: 0,
    });
    // The bindings keep their last value — the driver does not clear them.
    expect(gates().hasSelection).toBe(false);
  });
});
