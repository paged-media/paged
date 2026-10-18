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

// ADR 023 phase D — paged.draw as the LAYERS BINDING PROVIDER, and the
// retirement of `panels/layers-panel.tsx`.
//
// WHAT THIS REPLACES, and why the replacement is not a like-for-like.
// The old panel read `document.collection("layers")` and wrote the
// `layer*` ops — i.e. it was a second rendering of the DOCUMENT'S OWN
// layers, in a second dock tab, with a second implementation of the
// same seven ops. That is the duplication ADR 023 exists to end, and
// serving the same rows through the seam would have ended the panel
// without ending the duplication: the host panel would show identical
// content whether draw was active or not, and "it retargets" would be
// unfalsifiable.
//
// So the provider serves what paged.draw ACTUALLY OWNS while its
// `vectorGraphic` context is active: THE OBJECT STACK the user is
// inside — the entered path and its siblings, in engine paint order.
// That is what Illustrator's Layers panel shows when you are inside a
// group, it is the list a vector editor needs, and it is genuinely
// different content, so the retarget is visible rather than asserted.
//
// THE VOCABULARY RULE (§18.6) governs every line below. Rows carry
// CORE's row shape for `"layers"` (`LayerSummary`), reads answer typed
// core `PropertyPath`s, and writes accept core's own op names. Nothing
// synthetic is minted — a synthetic path is identity-shaped by
// construction, which is the anti-pattern the ADR names.
//
// WHAT IS DELIBERATELY NOT DECLARED, and what that buys:
//   · `layerName` — an element has no name property in core (there is
//     no element-name `PropertyPath` and `layerSetName` resolves to
//     `NodeId::Layer`). Leaving the path OUT of `provides.paths` is the
//     contract's own way to suppress a control (§18.6), so the host
//     panel DISABLES rename while this provider is active instead of
//     writing a layer op with an element id in it. A row-scoped read of
//     it answers `absent`, never `decline` — the rule that stops the
//     panel showing a core layer's name for a row core never had.
//   · `layerPrintable` — same, and for the same reason.
//   · `layerInsert` / `layerRemove` — "add an object to the stack" is
//     not what those ops mean, and there is no core op that MOVES an
//     element into the stack from a Layers panel. Undeclared, so the
//     host sends them to core, where they still do the honest thing to
//     the document's layers.
//
// TWO REORDER LANES MEET HERE. The host panel speaks `layerMove`
// (layer order is `NodeId::Layer`; the wire `ElementId` has no layer
// variant, so the schema's `reorderElement` lane cannot express it).
// This provider honours that op by translating it into
// `reorderElement` on the element it handed out — the reconciliation
// §18.10 describes. One vocabulary at the panel, two ops at the engine,
// and no branch in between.
//
// UNDO: every write goes through `host.document.mutate`, so it lands on
// the document's own undo stack. The contract states that as a
// requirement it cannot enforce; this is the compliance.

import type {
  BundleHost,
  ElementId,
  PropertyPath,
  SceneTreeNode,
  MutationInput,
  BindingProviderScope,
} from "@paged-media/plugin-api";

import {
  reorderElementMutationFor,
  setBoolPropertyMutationFor,
  type BindingCollection,
  type BindingProvider,
  type BindingRead,
  type BindingWrite,
} from "./adr023-seam";

/**
 * The row shape, structurally `LayerSummary` (the vocabulary rule
 * applied to collections — one host renderer draws provider rows and
 * core rows because they ARE the same shape).
 *
 * `printable` carries the honest default `true`: an element has no
 * printable flag, and the path is left out of `provides.paths` so the
 * host suppresses the control rather than trusting this field.
 */
export interface DrawObjectRow {
  selfId: string;
  name: string | null;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  z: number;
  parentId: string | null;
}

/**
 * The fan-out cap. Building a row needs one `elementProperties` read
 * per sibling, so a spread with thousands of objects would be a
 * thousand round trips on every panel refresh. Past the cap the
 * provider DECLINES the collection — the host then shows the document's
 * layers, which is a truthful answer, rather than a truncated object
 * list that would silently hide the rest of the stack.
 */
export const MAX_ROWS = 200;

/** An `ElementId`'s addressable STRING id, or `null`.
 *
 *  `ElementId.id` is a union — a plain element self-id, a `storyRange`
 *  `{story_id,start,end}`, a `tableCell` address. A Layers row addresses
 *  a page ITEM, so only the string form is a row; the range forms are
 *  the Character-panel lane's business and this provider does not claim
 *  them. Narrowed in ONE place so nothing downstream re-guesses. */
export function elementIdString(id: ElementId | undefined): string | null {
  const raw = (id as { id?: unknown } | undefined)?.id;
  return typeof raw === "string" ? raw : null;
}

/** Depth-first search for the node carrying `id`, returning the
 *  SIBLING LIST it belongs to (its parent's children, or the roots).
 *  `null` when the id is not in the tree. */
export function siblingsOf(
  roots: readonly SceneTreeNode[],
  id: string,
): { siblings: readonly SceneTreeNode[]; parentId: string | null } | null {
  const walk = (
    nodes: readonly SceneTreeNode[],
    parentId: string | null,
  ): { siblings: readonly SceneTreeNode[]; parentId: string | null } | null => {
    for (const node of nodes) {
      const own = elementIdString(node.id ?? undefined);
      if (own !== null && own === id) return { siblings: nodes, parentId };
      const kids = node.children;
      if (kids && kids.length > 0) {
        const hit = walk(kids, own ?? parentId);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(roots, null);
}

/** The paths this provider serves for its rows. `layerName` and
 *  `layerPrintable` are absent BY DESIGN — see the module header. */
const SERVED_PATHS: readonly PropertyPath[] = ["layerVisible", "layerLocked"];

/** Core ops this provider takes first refusal on. */
const SERVED_OPS: BindingProviderScope["ops"] = [
  "layerMove",
  "layerSetVisible",
  "layerSetLocked",
];

/** The core `PropertyPath` a served layer path maps to on an ELEMENT.
 *  The whole translation, in one table — this is the "who answers
 *  changes, the binding does not" of ADR 023 made concrete. */
const ELEMENT_PATH: Partial<Record<PropertyPath, PropertyPath>> = {
  layerVisible: "elementVisible",
  layerLocked: "elementLocked",
};

export interface LayersBindingProvider {
  provider: BindingProvider;
  /** Called from the edit context's own `onEnter`. */
  enter(id: ElementId | undefined): void;
  /** Called from the edit context's own `onExit`. */
  exit(): void;
  /** The rows last served — exposed for conformance, not for the host. */
  rows(): readonly DrawObjectRow[];
}

/**
 * Build the Layers provider for the `vectorGraphic` edit context.
 *
 * Lifetime is NOT managed here: it is BORROWED from the edit context
 * (phase A wraps the context's own `onEnter`/`onExit`, so the shell's
 * stack is the single source of "who is active"). `enter`/`exit` below
 * only track WHICH element was entered — the scope root whose siblings
 * are the rows.
 */
export function makeLayersBindingProvider(
  host: BundleHost,
): LayersBindingProvider {
  let entered: ElementId | null = null;
  /** Row id → the element it addresses. The host treats a row id as
   *  OPAQUE (§18.2), so this map is where the provider's vocabulary
   *  comes back to core's. */
  let byRow = new Map<string, ElementId>();
  let served: DrawObjectRow[] = [];

  const readFlags = async (
    id: ElementId,
  ): Promise<{ visible: boolean; locked: boolean }> => {
    try {
      const props = await host.document.elementProperties(id);
      let visible = true;
      let locked = false;
      for (const entry of props?.entries ?? []) {
        const v = entry.value;
        if (v == null || v.type !== "bool") continue;
        if (entry.path === "elementVisible") visible = v.value;
        else if (entry.path === "elementLocked") locked = v.value;
      }
      return { visible, locked };
    } catch {
      // An unreadable element is not a reason to invent a flag; the
      // engine's own defaults (visible, unlocked) are what a document
      // without the property means.
      return { visible: true, locked: false };
    }
  };

  const buildRows = async (): Promise<DrawObjectRow[] | null> => {
    const enteredId = elementIdString(entered ?? undefined);
    if (enteredId === null) return null;
    let roots: SceneTreeNode[];
    try {
      roots = await host.document.tree();
    } catch {
      return null;
    }
    const found = siblingsOf(roots, enteredId);
    if (!found) return null;
    // Only SELECTABLE siblings are rows: a Spread/Page node carries no
    // element id, so it cannot be addressed, reordered or toggled.
    const addressable: { key: string; id: ElementId; label: string }[] = [];
    for (const node of found.siblings) {
      const key = elementIdString(node.id ?? undefined);
      if (key === null || node.id == null) continue;
      addressable.push({ key, id: node.id, label: node.label });
    }
    if (addressable.length > MAX_ROWS) return null;
    const flags = await Promise.all(addressable.map((n) => readFlags(n.id)));
    byRow = new Map(addressable.map((n) => [n.key, n.id]));
    served = addressable.map((n, i) => ({
      selfId: n.key,
      name: n.label,
      visible: flags[i].visible,
      locked: flags[i].locked,
      // No element printable flag exists; the path is undeclared so the
      // host never renders a control over this default.
      printable: true,
      // SIBLING INDEX = the engine's paint order, index 0 backmost.
      // This is the number `reorderElement` speaks, and the number the
      // host's front-first display reverses only for DRAWING.
      z: i,
      // One flat sibling list — an object stack has no nesting to show
      // until a group is entered, which pushes its own context frame.
      parentId: null,
    }));
    return served;
  };

  const provider: BindingProvider = {
    provides: {
      paths: SERVED_PATHS,
      collections: ["layers"],
      ops: SERVED_OPS,
    },

    async readCollection(request): Promise<BindingCollection> {
      if (request.collection !== "layers") {
        return { kind: "decline", reason: "only the layers collection" };
      }
      const rows = await buildRows();
      if (rows === null) {
        // A DECLINE, not empty rows. The distinction is the whole
        // `planarRegions` lesson: a refusal that looks like a result is
        // a bug generator, and here it decides whether the user sees
        // the document's layers or an empty panel.
        return {
          kind: "decline",
          reason:
            `no addressable object stack for the entered element ` +
            `(or more than ${MAX_ROWS} siblings — see MAX_ROWS)`,
        };
      }
      return { kind: "rows", rows };
    },

    async readProperty(request): Promise<BindingRead> {
      const target = request.target;
      if (target.kind !== "row" || target.collection !== "layers") {
        // Not one of our rows. Selection- and element-scoped reads
        // belong to whoever owns that addressing; declining lets them
        // (or core) answer.
        return { kind: "decline", reason: "row-scoped provider" };
      }
      const element = byRow.get(target.id);
      if (!element) {
        // We own the collection but not this row — it is stale. `absent`
        // rather than `decline`: core has never heard of this id either,
        // so falling through could only produce a wrong answer.
        return {
          kind: "absent",
          reason: `row "${target.id}" is not in the current object stack`,
        };
      }
      const elementPath = ELEMENT_PATH[request.path];
      if (!elementPath) {
        // An owned-but-inapplicable path. MUST NOT fall through.
        return {
          kind: "absent",
          reason: `an object has no "${request.path}"`,
        };
      }
      const flags = await readFlags(element);
      const value =
        elementPath === "elementVisible" ? flags.visible : flags.locked;
      return { kind: "value", value: { type: "bool", value } };
    },

    async applyMutation(mutation): Promise<BindingWrite> {
      const m = mutation as unknown as {
        op: string;
        args?: Record<string, unknown>;
      };
      const layerId = m.args?.layerId;
      if (typeof layerId !== "string") {
        return { kind: "decline", reason: "no layerId in the op" };
      }
      const element = byRow.get(layerId);
      if (!element) {
        // Not one of our rows — let it go to core untouched.
        return {
          kind: "decline",
          reason: `"${layerId}" is not in the current object stack`,
        };
      }
      let translated: MutationInput;
      switch (m.op) {
        case "layerMove": {
          const newIndex = m.args?.newIndex;
          if (typeof newIndex !== "number") {
            return { kind: "decline", reason: "layerMove without newIndex" };
          }
          // THE SECOND REORDER LANE. `layerMove` resolves to
          // `NodeId::Layer` in core and would refuse an element id; the
          // equivalent verb for an object stack is `reorderElement` on
          // the wire `ElementId`. Same absolute-index meaning, so the
          // index passes through unchanged.
          translated = reorderElementMutationFor(element, newIndex);
          break;
        }
        case "layerSetVisible": {
          const visible = m.args?.visible;
          if (typeof visible !== "boolean") {
            return {
              kind: "decline",
              reason: "layerSetVisible without a flag",
            };
          }
          translated = setBoolPropertyMutationFor(
            element,
            "elementVisible",
            visible,
          );
          break;
        }
        case "layerSetLocked": {
          const locked = m.args?.locked;
          if (typeof locked !== "boolean") {
            return { kind: "decline", reason: "layerSetLocked without a flag" };
          }
          translated = setBoolPropertyMutationFor(
            element,
            "elementLocked",
            locked,
          );
          break;
        }
        default:
          return { kind: "decline", reason: `unhandled op "${m.op}"` };
      }
      // Through `host.document.mutate` — the undo rule the contract
      // states and cannot enforce.
      const outcome = await host.document.mutate(translated);
      return { kind: "applied", outcome };
    },
  };

  return {
    provider,
    enter(id) {
      entered = id ?? null;
      byRow = new Map();
      served = [];
    },
    exit() {
      entered = null;
      byRow = new Map();
      served = [];
    },
    rows: () => served,
  };
}
