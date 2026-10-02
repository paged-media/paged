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

// `installFillPanelBindings` — the driver behind the Fill SCHEMA panel's
// gradient gate. No React (a schema panel is pure data the host renders),
// so this runs in the plain Node environment: what the driver PUBLISHES
// on a selection change and on a document change, and what each costs at
// the host doors (the perf-budgets.spec.ts rules: a COUNT, MEASURED,
// target beside it, only lowered).
//
// `conformance/fill-panel.spec.ts` already proves the gate END TO END
// through the loaded bundle. This file is the driver alone: installed
// HERE over a counting host, on a headless host that was given the
// bundle's MANIFEST with an empty `activate`, so the bundle's own copy of
// the driver is not running beside it and every publish is the one under
// test.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, Disposable, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  fillGradientMutationsFor,
  installFillPanelBindings,
  mintFillGradientIds,
  BIND_GRADIENT_CONTROLS_VISIBLE,
  FILL_GRADIENT_PRESETS,
} from "../../src";
import { openHost } from "../conformance/host";
import { countingHost, type WorkLog } from "../perf/counting-host";
import {
  documentChanges,
  panelDocument,
  plainChange,
  quiesce,
  rectItem,
  selectionChanges,
} from "./panel-document";

/** Solid black, and stays that way. */
const SOLID = { kind: "rectangle", id: "r0" } as ElementId;
/** Given a gradient fill in `beforeAll`. */
const GRADIENT = { kind: "rectangle", id: "r1" } as ElementId;

describe("installFillPanelBindings — what it publishes, and what that costs", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let work: WorkLog;
  /** What installing the driver cost (nothing was selected). */
  let installed: WorkLog;
  let sub: Disposable;

  /** The gate as the HOST would look it up. */
  const gate = () => h.host.bindings.get(BIND_GRADIENT_CONTROLS_VISIBLE);
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
    await h.load(panelDocument(rectItem("r0", 40, 40) + rectItem("r1", 140, 40)));
    // The manifest without the bundle's own drivers (see the header).
    h.loadBundle({
      manifest: drawBundle.manifest,
      activate: () => ({ dispose() {} }),
    });
    // The bundle's own wire sequence for "Fill: Linear gradient": two
    // stops, the gradient, the fill ref.
    for (const mutation of fillGradientMutationsFor(
      [GRADIENT],
      FILL_GRADIENT_PRESETS[0]!,
      mintFillGradientIds(),
    )) {
      const out = await h.host.document.mutate(mutation);
      if (!out.applied) {
        throw new Error(`gradient seed refused: ${JSON.stringify(out.error)}`);
      }
    }
    ({ host, work } = countingHost(h.host));
    sub = installFillPanelBindings(host);
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

  it("installs by priming from the current selection and subscribing to BOTH events", () => {
    expect(installed.calls).toEqual({
      "selection.get": 1,
      "bindings.publish": 1,
      "selection.onDidChange": 1,
      "document.onDidChange": 1,
    });
    expect(gate()).toBe(false);
  });

  it("a selection change derives the gate from ONE read of the first selected element", async () => {
    expect(await costOf(() => h.host.selection.set([SOLID]))).toEqual({
      // The gate was false and a solid fill leaves it false: nothing to
      // publish. As found: 1.
      publishes: 0,
      reads: 1,
    });
    expect(work.count("document.elementProperties")).toBe(1);
    expect(gate()).toBe(false);

    expect(await costOf(() => h.host.selection.set([GRADIENT]))).toEqual({
      publishes: 1,
      reads: 1,
    });
    expect(gate()).toBe(true);

    // Only the FIRST element counts.
    await h.host.selection.set([SOLID, GRADIENT]);
    await quiesce(work);
    expect(gate()).toBe(false);
  });

  it("clearing the selection publishes false and reads nothing", async () => {
    await h.host.selection.set([GRADIENT]);
    await quiesce(work);
    expect(gate()).toBe(true);
    expect(await costOf(() => h.host.selection.set([]))).toEqual({
      publishes: 1,
      reads: 0,
    });
    expect(gate()).toBe(false);
  });

  it("a document change re-derives the gate for the CURRENT selection: one read, no publish", async () => {
    await h.host.selection.set([SOLID]);
    await quiesce(work);
    // The change touches a plain leaf — nothing the gate depends on.
    expect(await costOf(() => plainChange(h, 0))).toEqual({
      // The value did not change, so it is not published again. As
      // found: 1.
      publishes: 0,
      // TARGET 0 — the selected element was not in the change (the
      // event names pages, not elements, so the driver cannot know).
      reads: 1,
    });
    // The selection is the one the last selection event handed over; it
    // is not asked for again. As found: 1.
    expect(work.count("selection.get")).toBe(0);
    expect(gate()).toBe(false);
  });

  it("a document change that swaps the fill flips the gate with no selection change", async () => {
    await h.host.selection.set([SOLID]);
    await quiesce(work);
    expect(gate()).toBe(false);

    // Point the selected rectangle's fill at the gradient r1 already uses.
    const props = await h.host.document.elementProperties(GRADIENT);
    const ref = props?.entries.find((e) => e.path === "frameFillColor")?.value;
    expect(ref?.type).toBe("colorRef");
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: SOLID, path: "frameFillColor", value: ref! },
    });
    expect(out.applied).toBe(true);
    await quiesce(work);
    expect(gate()).toBe(true);

    // …and an UNDO is a document change too.
    await h.host.document.undo();
    await quiesce(work);
    expect(gate()).toBe(false);
  });

  it("with nothing selected a document change publishes nothing, and reads nothing", async () => {
    expect(await costOf(() => plainChange(h, 1))).toEqual({
      // The value was false and is false. As found: 1.
      publishes: 0,
      reads: 0,
    });
    expect(gate()).toBe(false);
  });

  it("a burst of 20 document changes = ONE recompute: 0 publishes, 1 read", async () => {
    await h.host.selection.set([SOLID]);
    await quiesce(work);
    expect(await costOf(() => documentChanges(h))).toEqual({
      // Nothing changed, so nothing is published. As found: 20 — one
      // recompute per change, each re-publishing the same false.
      publishes: 0,
      // The selection's fill at the revision the burst ends on. As
      // found: 20.
      reads: 1,
    });
    expect(gate()).toBe(false);
  });

  it("a burst of 20 selection changes = ONE recompute: 0 publishes, 1 read", async () => {
    expect(await costOf(() => selectionChanges(h))).toEqual({
      // Twenty solid-filled leaves: the gate never leaves false. As
      // found: 20.
      publishes: 0,
      // The selection the burst ends on. As found: 20.
      reads: 1,
    });
    expect(gate()).toBe(false);
  });

  // WAS A BUG (measured, then fixed). `recompute` awaited
  // `elementProperties` before it published, an empty selection published
  // `false` WITHOUT awaiting, and nothing cancelled or sequenced the two.
  // Select a gradient-filled object and then clear the selection: the
  // clear's `false` was published first and the older read's `true`
  // landed on top of it, so the Gradient section stayed up with nothing
  // selected, until the next selection or document change. No overlap
  // trick was needed — each `selection.set` below is awaited — because
  // the listener fired inside `set` and the read outlived it. A recompute
  // now holds a ticket (`src/panels/reload.ts`) and publishes nothing
  // once a newer one has started.
  it("the gate ends on the LATEST selection (select a gradient, then clear)", async () => {
    await h.host.selection.set([GRADIENT]);
    await h.host.selection.set([]);
    await quiesce(work);
    expect(h.host.selection.get()).toEqual([]);
    expect(gate()).toBe(false);
  });

  // The case above is settled by COALESCING here — both changes arrive
  // before the task the first one armed, so only the clear is ever
  // recomputed. This is the overlap itself: the gradient's read is held
  // open until the clear has been recomputed and published.
  it("…and when the older recompute's read comes back AFTER the newer one published", async () => {
    const raw = h.host.document as {
      elementProperties: BundleHost["document"]["elementProperties"];
    };
    const elementProperties = raw.elementProperties;
    let held = 0;
    raw.elementProperties = async function heldOpen(this: unknown, id: ElementId) {
      const props = await elementProperties.call(this, id);
      held += 1;
      await new Promise((r) => setTimeout(r, 20));
      return props;
    };
    try {
      await h.host.selection.set([GRADIENT]);
      // The recompute for the gradient starts, and waits on its read.
      await new Promise((r) => setTimeout(r, 0));
      await h.host.selection.set([]);
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      raw.elementProperties = elementProperties;
    }
    expect(held).toBe(1);
    expect(gate()).toBe(false);
  });

  it("dispose drops both subscriptions", async () => {
    sub.dispose();
    expect(await costOf(() => h.host.selection.set([GRADIENT]))).toEqual({
      publishes: 0,
      reads: 0,
    });
    expect(await costOf(() => plainChange(h, 2))).toEqual({ publishes: 0, reads: 0 });
  });
});
