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

// The shared mount of the slide panels' component specs (`*.dom.test.tsx`,
// run by `bun run test:dom`, which preloads happy-dom).
//
// One headless host on the real engine, with the page doors the Slides and
// Notes panels need (`viewport.pages@1`): a recording page backend whose
// active page a spec moves, as the canvas does when the user scrolls. The
// bundle is activated on it and a PowerPoint-authored deck is opened
// through the bundle's own typed command, so every panel shows a real deck.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  PanelContribution,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import { act, render } from "@testing-library/react";

import slideBundle from "../../src/index";
import { IMPORT_PPTX_COMMAND } from "../../src/object-model";
import { schemaPanelComponent } from "./schema-renderer";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));

export const deckBytes = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../../slide-conformance/fixtures/${name}.pptx`,
        import.meta.url,
      ),
    ),
  );

export interface DeckHarness {
  h: HeadlessHost;
  /** The bundle's own host (its object model, its manifest). */
  host: BundleHost;
  /** The slide addresses the import answered, in deck order. */
  slides: string[];
  /** Every `goToPage` the panels asked for. */
  wentTo: string[];
  /** Move the active page, as scrolling the canvas does. */
  setActivePage(pageId: string | null): void;
  /** The page ids, in document order. */
  pageIds(): Promise<string[]>;
  /** The latest registration of a React panel. */
  panel(id: string): PanelContribution;
  /** The schema panel contribution of `id`. */
  schemaPanel(id: string): SchemaPanelContribution;
  dispose(): void;
}

export async function openDeck(name = "placeholders"): Promise<DeckHarness> {
  let active: string | null = null;
  const listeners = new Set<(id: string | null) => void>();
  const wentTo: string[] = [];
  const setActivePage = (id: string | null) => {
    active = id;
    for (const l of listeners) l(id);
  };
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: { debug() {}, info() {}, warn() {}, error() {} },
    pages: {
      goToPage(pageId) {
        wentTo.push(pageId);
        setActivePage(pageId);
        return true;
      },
      activePage: () => active,
      onDidChangeActivePage(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  });
  let host!: BundleHost;
  h.loadBundle({
    manifest: slideBundle.manifest,
    activate(x) {
      host = x;
      return slideBundle.activate(x);
    },
  });
  const out = (await h.objects.invoke(IMPORT_PPTX_COMMAND, {
    bytes: deckBytes(name),
    name: `${name}.pptx`,
  })) as { slides: string[] };
  const pageIds = async () =>
    (await h.host.document.collection<{ selfId: string }>("pages")).map(
      (p) => p.selfId,
    );
  setActivePage((await pageIds())[0] ?? null);
  return {
    h,
    host,
    slides: out.slides,
    wentTo,
    setActivePage,
    pageIds,
    panel(id) {
      const all = h.panelsContributed().filter((p) => p.id === id);
      const last = all.at(-1);
      if (!last) throw new Error(`no panel ${id}`);
      return last;
    },
    schemaPanel(id) {
      const c = h.schemaPanelsContributed().find((p) => p.id === id);
      if (!c) throw new Error(`no schema panel ${id}`);
      return c;
    },
    dispose: () => h.dispose(),
  };
}

/** Mount a React panel's component. */
export function mount(panel: PanelContribution) {
  const Component = panel.component;
  return render(
    <Component paged={undefined as never} api={undefined as never} />,
  );
}

/** Mount a schema panel through the SDK's schema-panel component and the
 *  test renderer. */
export function mountSchema(d: DeckHarness, id: string) {
  const Component = schemaPanelComponent(d.host, d.schemaPanel(id));
  return render(
    <Component paged={undefined as never} api={undefined as never} />,
  );
}

/** Run `fn` inside `act`, then let the engine's replies and React settle. */
export async function drive(fn: () => unknown): Promise<void> {
  await act(async () => {
    await fn();
  });
  await settle();
}

export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}
