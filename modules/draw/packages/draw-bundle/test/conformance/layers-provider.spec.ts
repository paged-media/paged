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

// draw conformance — the LAYERS BINDING PROVIDER (ADR 023 phase D).
//
// This spec is the MIGRATION half of retiring `panels/layers-panel.tsx`.
// The panel had no behavioural coverage at all: `activate.spec.ts` pinned
// that it was registered and `headless-conformance.spec.ts` pinned that
// it was NOT a schema panel, and nothing anywhere exercised the seven
// `layer*` ops it emitted or the top-first sort it applied. So "move the
// coverage to the new seam first" is, honestly, mostly WRITING it — the
// registration assertions move (see those two specs), and the behaviour
// below is new. Recorded plainly rather than dressed up as a transfer.
//
// Everything runs against the REAL engine (the `appearance-panel.spec.ts`
// doctrine: the provider is the whole surface, so testing it needs no
// DOM). The provider is driven directly because THIS repo installs
// plugin-api/plugin-sdk 0.2.25-canary.0, which predates phase A — so
// `registerBindingProvider` correctly returns `null` here, and that
// honest degradation is itself asserted below.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { ElementId, Mutation, SceneTreeNode } from "@paged-media/plugin-api";

import { drawBundle } from "../../src";
import {
  makeLayersBindingProvider,
  siblingsOf,
  type DrawObjectRow,
} from "../../src/binding-provider/layers-provider";
import {
  registerBindingProvider,
  supportsBindingProviders,
} from "../../src/binding-provider/adr023-seam";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as const;

/** The engine's own frame order for the single page — the ground truth
 *  a reorder has to move, independent of the provider. */
async function frameOrder(h: HeadlessHost): Promise<string[]> {
  const roots: SceneTreeNode[] = await h.host.document.tree();
  const page = roots[0]?.children?.[0];
  return (page?.children ?? [])
    .map((n) => n.id?.id)
    .filter((id): id is string => typeof id === "string");
}

async function boolProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<boolean | undefined> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path && e.value?.type === "bool") return e.value.value;
  }
  return undefined;
}

describe("draw conformance — the Layers binding provider (ADR 023)", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  // ------------------------------------------------------ declaration

  it("declares exactly what it can serve, and no more", () => {
    const { provider } = makeLayersBindingProvider(h.host);
    expect(provider.provides.collections).toEqual(["layers"]);
    // `layerName` and `layerPrintable` are ABSENT on purpose: an element
    // has no name and no printable flag in core, and leaving the path
    // out of `provides` is the contract's own way to suppress a control
    // (§18.6) — the host DISABLES rename rather than sending a layer op
    // with an element id in it.
    expect(provider.provides.paths).toEqual(["layerVisible", "layerLocked"]);
    expect(provider.provides.paths).not.toContain("layerName");
    expect(provider.provides.paths).not.toContain("layerPrintable");
    // Ops likewise: no `layerSetName`, no `layerInsert`/`layerRemove` —
    // those still mean something true about the document's layers, so
    // they are left to core rather than intercepted and refused.
    expect(provider.provides.ops).toEqual([
      "layerMove",
      "layerSetVisible",
      "layerSetLocked",
    ]);
    // Every declared lane has its callback — phase A refuses a
    // declaration the registry could never call.
    expect(typeof provider.readCollection).toBe("function");
    expect(typeof provider.readProperty).toBe("function");
    expect(typeof provider.applyMutation).toBe("function");
    // …and `writeProperty` is NOT declared, so it is NOT implemented:
    // this provider's writes are structural.
    expect(provider.provides.paths?.length).toBeGreaterThan(0);
    expect((provider as { writeProperty?: unknown }).writeProperty).toBe(
      undefined,
    );
  });

  it("degrades honestly on a host with no binding-provider registry", () => {
    // This repo's installed plugin-sdk predates ADR 023 phase A, so the
    // door is absent. The seam must answer `null` — not throw, and not
    // register something nothing will consult.
    expect(supportsBindingProviders(h.host)).toBe(false);
    const { provider } = makeLayersBindingProvider(h.host);
    expect(registerBindingProvider(h.host, "vectorGraphic", provider)).toBe(
      null,
    );
  });

  // ------------------------------------------------------- collection

  it("serves the entered element's OBJECT STACK, in engine paint order", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    const read = await p.provider.readCollection!({ collection: "layers" });
    expect(read.kind).toBe("rows");
    const rows = (read as unknown as { rows: DrawObjectRow[] }).rows;
    // F1 puts three shapes on one page; the entered rectangle's
    // siblings are all three, in the engine's own order.
    expect(rows.map((r) => r.selfId)).toEqual(await frameOrder(h));
    // The row shape is CORE's row shape for `layers` (`LayerSummary`) —
    // the vocabulary rule, and what lets one host renderer draw both.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["locked", "name", "parentId", "printable", "selfId", "visible", "z"].sort(),
      );
      expect(typeof row.visible).toBe("boolean");
      expect(typeof row.locked).toBe("boolean");
    }
    // `z` is the SIBLING INDEX — index 0 backmost, the number
    // `reorderElement` speaks. The host's front-first display reverses
    // only the DRAWING, never this.
    expect(rows.map((r) => r.z)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.parentId === null)).toBe(true);
  });

  it("DECLINES rather than answering empty when nothing is entered", async () => {
    const p = makeLayersBindingProvider(h.host);
    // No enter() — the context is not active on any element.
    const read = await p.provider.readCollection!({ collection: "layers" });
    // A refusal that looked like an empty result would show the user an
    // empty Layers panel over a non-empty document; `decline` makes the
    // host read core instead. (The `planarRegions` lesson.)
    expect(read.kind).toBe("decline");
  });

  it("declines a collection it does not own", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    const read = await p.provider.readCollection!({ collection: "swatches" });
    expect(read.kind).toBe("decline");
  });

  it("exit() clears the stack, so the panel retargets back to core", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    expect((await p.provider.readCollection!({ collection: "layers" })).kind).toBe(
      "rows",
    );
    p.exit();
    expect((await p.provider.readCollection!({ collection: "layers" })).kind).toBe(
      "decline",
    );
  });

  // --------------------------------------------------------- property

  it("reads a row's visible/locked from the ELEMENT's own core paths", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const read = await p.provider.readProperty!({
      path: "layerVisible",
      target: { kind: "row", collection: "layers", id: RECT.id },
    });
    expect(read.kind).toBe("value");
    expect((read as { value: { type: string } }).value.type).toBe("bool");
  });

  it("answers ABSENT — never decline — for an owned row and an inapplicable path", async () => {
    // THE load-bearing distinction of the whole contract. `decline`
    // would fall through to core and show a CORE LAYER's name for a row
    // core has never heard of.
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const read = await p.provider.readProperty!({
      path: "layerName",
      target: { kind: "row", collection: "layers", id: RECT.id },
    });
    expect(read.kind).toBe("absent");
    expect(read.kind).not.toBe("decline");
  });

  it("answers ABSENT for a stale row id it owns the collection for", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const read = await p.provider.readProperty!({
      path: "layerVisible",
      target: { kind: "row", collection: "layers", id: "no-such-row" },
    });
    expect(read.kind).toBe("absent");
  });

  it("declines a selection-scoped read — it is a ROW provider", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const read = await p.provider.readProperty!({
      path: "layerVisible",
      target: { kind: "selection", scope: "element" },
    });
    expect(read.kind).toBe("decline");
  });

  // ---------------------------------------------------------- writes

  it("honours the panel's layerMove by REORDERING THE ELEMENT (the second lane)", async () => {
    // The host panel speaks `layerMove` whoever is listening — layer
    // order resolves to `NodeId::Layer` and the wire `ElementId` has no
    // layer variant, so the schema's `reorderElement` lane cannot
    // express it. This provider translates the SAME op into
    // `reorderElement` on the element it handed out. Two ops at the
    // engine, one vocabulary at the panel, no branch in between.
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    const before = await frameOrder(h);
    expect(before.length).toBeGreaterThanOrEqual(3);
    await p.provider.readCollection!({ collection: "layers" });

    const write = await p.provider.applyMutation!({
      op: "layerMove",
      args: { layerId: before[0], newIndex: before.length - 1 },
    } as unknown as Mutation);
    expect(write.kind).toBe("applied");
    expect((write as { outcome: { applied: boolean } }).outcome.applied).toBe(
      true,
    );

    const after = await frameOrder(h);
    expect(after[after.length - 1]).toBe(before[0]);
    expect(after).not.toEqual(before);

    // It landed through `host.document.mutate`, so it is on the
    // document's undo stack — the contract's undo rule, honoured.
    await h.host.document.undo();
    expect(await frameOrder(h)).toEqual(before);
  });

  it("honours layerSetVisible / layerSetLocked as element property writes", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const id = RECT as unknown as ElementId;

    const hide = await p.provider.applyMutation!({
      op: "layerSetVisible",
      args: { layerId: RECT.id, visible: false },
    } as unknown as Mutation);
    expect(hide.kind).toBe("applied");
    expect(await boolProp(h, id, "elementVisible")).toBe(false);

    const lock = await p.provider.applyMutation!({
      op: "layerSetLocked",
      args: { layerId: RECT.id, locked: true },
    } as unknown as Mutation);
    expect(lock.kind).toBe("applied");
    expect(await boolProp(h, id, "elementLocked")).toBe(true);

    await h.host.document.undo();
    await h.host.document.undo();
    expect(await boolProp(h, id, "elementVisible")).not.toBe(false);
  });

  it("DECLINES an op naming a row it does not own, so core still answers", async () => {
    const p = makeLayersBindingProvider(h.host);
    p.enter(RECT as unknown as ElementId);
    await p.provider.readCollection!({ collection: "layers" });
    const write = await p.provider.applyMutation!({
      op: "layerMove",
      args: { layerId: "a-real-document-layer", newIndex: 0 },
    } as unknown as Mutation);
    // Decline, NOT `{applied:false}`: the provider did not own it, so
    // the host must send it to core rather than report a refusal.
    expect(write.kind).toBe("decline");
  });

  // ------------------------------------------------------ the walk

  it("siblingsOf finds the sibling list, not just the node", () => {
    const roots: SceneTreeNode[] = [
      {
        kind: "spread",
        label: "s",
        children: [
          {
            kind: "page",
            label: "p",
            id: undefined,
            children: [
              { kind: "rectangle", label: "r", id: { kind: "rectangle", id: "a" } },
              { kind: "polygon", label: "p", id: { kind: "polygon", id: "b" } },
            ],
          },
        ],
      },
    ] as unknown as SceneTreeNode[];
    const found = siblingsOf(roots, "b");
    expect(found?.siblings.map((n) => n.id?.id)).toEqual(["a", "b"]);
    expect(siblingsOf(roots, "nope")).toBe(null);
  });
});
