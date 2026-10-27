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

// Live presets and connectors (slide ADR 717). The importer labels every
// element of a slide's shape with its preset, the box its outline was drawn
// for and, on a connector, the shapes its ends are glued to. After an edit
// the bundle hands the labelled elements of the pages it touched to the
// slide engine (one wasm call, `follow`), which answers what to write: a
// resized preset drawn again for its new box (a rounded rectangle keeps its
// corner radius), a connector re-routed to the sites of the shapes it is
// glued to. The writes join the edit's undo step (extensions ADR 337,
// engine ADR 1004): one undo reverts the resize and the redraw together.
//
// This file only gathers elements and writes answers; the labels and the
// geometry are the Rust side's.

import type {
  BundleHost,
  Disposable,
  DocumentChangeEvent,
  ElementId,
  MutationInput,
  MutationOutcome,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import type { LiveElement, LiveWrite, SlideEngine } from "./engine.js";
import { LABEL_KEY } from "./object-model.js";

type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** A labelled element of the document, as the scene tree lists it. */
interface Labelled {
  id: ElementId;
  label: string;
}

/** The slide label's raw envelope among an item's plugin metadata. */
function slideLabel(meta: SceneTreeNode["pluginMetadata"]) {
  return meta?.find((m) => m.key === LABEL_KEY)?.value ?? null;
}

/** Every element whose slide label gives the box its outline was drawn for
 *  (the shapes live presets and connectors are about), in tree order. */
export async function labelledElements(host: BundleHost): Promise<Labelled[]> {
  const out: Labelled[] = [];
  const walk = (nodes: readonly SceneTreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const label = slideLabel(n.pluginMetadata);
      if (n.id && label && label.includes('"box"'))
        out.push({ id: n.id, label });
      walk(n.children);
    }
  };
  walk(await host.document.tree());
  return out;
}

const idOf = (e: ElementId): string =>
  typeof e.id === "string" ? e.id : JSON.stringify(e.id);

/**
 * The labelled elements on `pages` (all pages for `null`) as the slide
 * engine takes them: anchors for paths, the box for frames, each in its own
 * coordinates with its transform onto the page. Keyed by page.
 */
export async function liveElements(
  host: BundleHost,
  pages: ReadonlySet<string> | null,
): Promise<Map<string, { element: LiveElement; id: ElementId }[]>> {
  const out = new Map<string, { element: LiveElement; id: ElementId }[]>();
  const labelled = await labelledElements(host);
  if (labelled.length === 0) return out;
  const geometry = await host.document.elementGeometry(
    labelled.map((l) => l.id),
  );
  const byId = new Map(geometry.map((g) => [idOf(g.id), g]));
  for (const l of labelled) {
    const g = byId.get(idOf(l.id));
    const page = g?.pageId ?? null;
    if (!g || !page || (pages && !pages.has(page))) continue;
    const element: LiveElement = {
      id: idOf(l.id),
      kind: l.id.kind,
      label: l.label,
      transform: (g.itemTransform ?? IDENTITY) as Affine,
      bounds: g.bounds,
    };
    if (l.id.kind === "polygon") {
      const path = await host.document.pathAnchors(l.id);
      if (!path) continue;
      element.anchors = path.anchors.map((a) => [a.anchor, a.left, a.right]);
      element.starts = path.subpathStarts;
      element.transform = (path.itemTransform ?? element.transform) as Affine;
    }
    const list = out.get(page) ?? [];
    list.push({ element, id: l.id });
    out.set(page, list);
  }
  return out;
}

/** The mutations that write `writes` (one batch). */
export function writeMutation(
  writes: readonly LiveWrite[],
  ids: ReadonlyMap<string, ElementId>,
): MutationInput | null {
  const ops: MutationInput[] = [];
  for (const w of writes) {
    const elementId = ids.get(w.id);
    if (!elementId) continue;
    if (w.anchors) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "framePath",
          value: {
            type: "framePath",
            value: {
              anchors: w.anchors.map(([anchor, left, right]) => ({
                anchor: anchor as [number, number],
                left: left as [number, number],
                right: right as [number, number],
              })),
              subpathStarts: w.starts ?? [],
            },
          },
        },
      } as MutationInput);
    }
    if (w.transform) {
      ops.push({
        op: "moveFrame",
        args: { frameId: w.id, transform: w.transform },
      } as MutationInput);
    }
    if (w.bounds) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameBounds",
          value: { type: "bounds", value: w.bounds },
        },
      } as MutationInput);
    }
    if (w.label) {
      ops.push({
        op: "setPluginMetadata",
        args: { elementId, key: LABEL_KEY, value: w.label },
      } as MutationInput);
    }
  }
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } } as MutationInput;
}

/**
 * Follow edits: after each committed edit on a deck, draw the resized live
 * presets again and re-route the connectors whose shapes moved, in the
 * edit's undo step. Needs `document.mutate.amend@1`: without it a follow-up
 * would be a step of its own, so nothing follows (export then writes a
 * resized preset as custom geometry, as before).
 */
export class LiveFollower implements Disposable {
  private chain: Promise<void> = Promise.resolve();
  /** Steps this follower amended: their echo needs no second look. */
  private readonly own = new Set<number>();
  private readonly sub: Disposable;
  /** Runs settled (for tests: `await follower.idle()`). */
  idle(): Promise<void> {
    return this.chain;
  }

  constructor(
    private readonly host: BundleHost,
    private readonly engine: () => Promise<SlideEngine>,
    private readonly isDeck: () => boolean = () => true,
  ) {
    this.sub = host.document.onDidChange((e) => this.onChange(e));
  }

  private onChange(e: DocumentChangeEvent) {
    const seq = e.appliedSeq;
    if (seq === undefined) return; // an undo, a redo, an older host
    if (this.own.has(seq)) return;
    if (!this.isDeck()) return;
    if (!this.host.supports("document.mutate.amend@1")) return;
    const pages = e.pagesUnknown ? null : new Set(e.pageIds);
    if (pages && pages.size === 0) return;
    this.chain = this.chain
      .then(() => this.run(seq, pages))
      .catch((err: unknown) =>
        this.host.log.warn(`paged.slide live presets: ${String(err)}`),
      );
  }

  /** Follow one committed step. */
  async run(seq: number, pages: ReadonlySet<string> | null): Promise<void> {
    const byPage = await liveElements(this.host, pages);
    if (byPage.size === 0) return;
    const engine = await this.engine();
    let step = seq;
    for (const list of byPage.values()) {
      const writes = engine.follow(list.map((x) => x.element));
      if (writes.length === 0) continue;
      const ids = new Map(list.map((x) => [x.element.id, x.id]));
      const m = writeMutation(writes, ids);
      if (!m) continue;
      const out: MutationOutcome = await this.host.document.mutate(m, {
        amend: step,
      });
      if (!out.applied) {
        // The step is no longer the last (the user moved on): leave it.
        this.host.log.info(
          `paged.slide live presets: not followed (${JSON.stringify(out.error)})`,
        );
        return;
      }
      if (out.appliedSeq !== undefined) {
        step = out.appliedSeq;
        this.own.add(step);
      }
    }
  }

  dispose() {
    this.sub.dispose();
  }
}
