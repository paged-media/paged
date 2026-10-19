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

// The shared mount of the web panels' component specs (`*.dom.test.tsx`,
// run by `bun run test:dom`, which preloads happy-dom): the bundle on the
// headless host over the real engine, an empty page loaded.

import type {
  BundleHost,
  PanelContribution,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { act, render } from "@testing-library/react";

import { webBundle } from "../../src";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { schemaPanelComponent } from "./schema-renderer";

export interface WebHarness {
  h: HeadlessHost;
  host: BundleHost;
  panel(id: string): PanelContribution;
  schemaPanel(id: string): SchemaPanelContribution;
}

export async function webHost(): Promise<WebHarness> {
  const h = await openHost();
  await h.load(W1_EMPTY_PAGE.bytes());
  h.loadBundle(webBundle);
  return {
    h,
    host: h.host as unknown as BundleHost,
    panel(id) {
      const p = h.panelsContributed().find((c) => c.id === id);
      if (!p) throw new Error(`no panel ${id}`);
      return p;
    },
    schemaPanel(id) {
      const c = h.schemaPanelsContributed().find((p) => p.id === id);
      if (!c) throw new Error(`no schema panel ${id}`);
      return c;
    },
  };
}

export function mount(panel: PanelContribution) {
  const Component = panel.component;
  return render(
    <Component paged={undefined as never} api={undefined as never} />,
  );
}

export function mountSchema(w: WebHarness, id: string) {
  const Component = schemaPanelComponent(w.host, w.schemaPanel(id));
  return render(
    <Component paged={undefined as never} api={undefined as never} />,
  );
}

/** Run `fn` inside `act`, then let the engine's replies and React settle. */
export async function drive(fn: () => unknown): Promise<void> {
  await act(async () => {
    await fn();
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}
