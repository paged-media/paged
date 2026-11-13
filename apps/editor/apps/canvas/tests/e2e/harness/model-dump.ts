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

// E2E op suite — model state dumps. The "did the operation land in
// the DOCUMENT" half of the sandwich: stable-JSON snapshots of an
// element's properties, a story's text, or the document-level state
// (meta + named collections) taken before/after an operation and
// after undo (deep-equality = the model restored).

import type { Page } from "@playwright/test";

import { browserModel } from "./gesture-kit";

interface CanvasGlobal {
  __canvas: {
    client: {
      elementProperties: (id: unknown) => Promise<unknown>;
      documentMeta: () => Promise<unknown>;
      collection: (name: string) => Promise<unknown[]>;
      layers: () => Promise<unknown[]>;
      executeScript: (
        src: string,
      ) => Promise<{ output: string[]; error: string | null }>;
    };
  };
}

/** Stable stringify (sorted keys, recursive) so dumps deep-compare
 *  reliably regardless of property order on the wire. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Full property snapshot of one element (kind + every PropertyEntry). */
export async function dumpElement(page: Page, id: unknown): Promise<string> {
  const props = await page.evaluate(async (elementId) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    return await c.client.elementProperties(elementId);
  }, id);
  return stableJson(props);
}

/** Story text + character count via the paged.* scripting surface. */
export async function dumpStory(page: Page, storyId: string): Promise<string> {
  const out = await page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.executeScript(
      `paged.inspect(${JSON.stringify(`story:${id}`)});`,
    );
    if (r.error) {
      // Some builds address stories only through ranges — fall back
      // to the stories() listing entry.
      const s = await c.client.executeScript("paged.stories()");
      const stories = JSON.parse(s.output[0] ?? "[]") as Array<{
        selfId: string;
      }>;
      return JSON.stringify(stories.find((x) => x.selfId === id) ?? null);
    }
    return r.output[0] ?? "";
  }, storyId);
  return out;
}

/** Document-level dump: meta + the named collections that doc-scope
 *  ops mutate. Collection list kept tight to stay fast. */
export async function dumpDoc(
  page: Page,
  collections: string[] = ["swatches", "gradients", "colorGroups"],
): Promise<string> {
  const data = await page.evaluate(
    async ({ collections }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const meta = await c.client.documentMeta();
      const layers = await c.client.layers();
      const cols: Record<string, unknown[]> = {};
      for (const name of collections) {
        try {
          cols[name] = await c.client.collection(name);
        } catch {
          cols[name] = [];
        }
      }
      return { meta, layers, cols };
    },
    { collections },
  );
  return stableJson(data);
}

/** The whole document as the gesture invariants compare it: the scene
 *  tree, every element's properties, the document meta (less `dirty` and
 *  `activePage`) and the pages, spreads, swatches and layers — the test
 *  kit's engine dump (`engineModelChannel`), the same one the headless
 *  suites and `checkUndoRedo` use. Equal strings = equal documents. */
export async function modelSnapshot(page: Page): Promise<string> {
  return browserModel(page).dump();
}

/** What is selected, as the editor's main thread holds it: the element
 *  selection mirror the canvas routes drags by (sorted, so order does not
 *  count), the group the selection is scoped to (its id), and the text
 *  caret or range, if any. Selection is not document state (D-15): compare
 *  it apart from {@link modelSnapshot}. */
export interface SelectionSnapshot {
  elements: Array<{ kind: string; id: string }>;
  activeGroup: string | null;
  text: { storyId: string; start: number; end: number } | null;
}

export async function selectionSnapshot(
  page: Page,
): Promise<SelectionSnapshot> {
  return page.evaluate(() => {
    type Id = { kind: string; id: string };
    const c = (
      globalThis as unknown as {
        __canvas: {
          elementSelection?: Id[] | null;
          activeGroup?: string | null;
          contentSelection?: {
            storyId: string;
            start: number;
            end: number;
          } | null;
        };
      }
    ).__canvas;
    const elements = (c.elementSelection ?? [])
      .map((e) => ({ kind: String(e.kind), id: String(e.id) }))
      .sort((a, b) =>
        a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind < b.kind ? -1 : 1,
      );
    const t = c.contentSelection ?? null;
    return {
      elements,
      activeGroup: c.activeGroup ?? null,
      text: t ? { storyId: t.storyId, start: t.start, end: t.end } : null,
    };
  });
}
