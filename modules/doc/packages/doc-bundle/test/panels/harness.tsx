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

// The shared mount of the doc panels' component specs (`*.dom.test.tsx`,
// run by `bun run test:dom`, which preloads happy-dom).
//
// One headless host on the real engine and the bundle activated on it the
// way the editor arranges it: a native-document door that loads the package
// the bundle produces as the active document, and (optionally) a shell with
// a file picker that answers the file a spec hands it.

import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  PanelContribution,
  PluginManifest,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
  type ShellBackend,
} from "@paged-media/plugin-sdk";
import { act, render } from "@testing-library/react";

import { docBundle } from "../../src";
import { fixture } from "../conformance/harness";
import { schemaPanelComponent } from "./schema-renderer";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DocHarness {
  h: HeadlessHost;
  /** The bundle's own host (its object model). */
  host: BundleHost;
  /** What the next pick answers (the shell's picker), when there is one. */
  nextPick: Array<{ name: string; bytes: Uint8Array }>;
  /** Panels the bundle asked the shell to open. */
  opened: string[];
  /** File ▸ Open of a fixture through the bundle's importer. */
  open(name: string): Promise<void>;
  panel(id: string): PanelContribution;
  schemaPanel(id: string): SchemaPanelContribution;
  dispose(): void;
}

export async function docHost(
  options: { picker?: boolean } = {},
): Promise<DocHarness> {
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silent,
  });
  const nextPick: Array<{ name: string; bytes: Uint8Array }> = [];
  const opened: string[] = [];
  // The schema panels the bundle registers, verbatim (the host adapter's
  // registration hook; the headless harness uses the same one).
  const schemaPanels: SchemaPanelContribution[] = [];
  const shell = {
    openPanel: (id: string) => void opened.push(id),
    closePanel: () => {},
    pickFile: async () =>
      nextPick.splice(0).map((f) => ({ ...f, mimeType: DOCX_MIME })),
  } as unknown as ShellBackend;
  const handle = createBundleHost(
    () => h.host.editor,
    docBundle.manifest as PluginManifest,
    {
      console: silent,
      onSchemaPanelRegistered: (c) => void schemaPanels.push(c),
      ...(options.picker ? { shell } : {}),
      nativeDocument: {
        readModel: async () => null,
        readComposition: async () => null,
        listParts: async () => [],
        open: async (bytes) => {
          await h.load(bytes);
        },
      },
    },
  );
  const host = handle.host;
  const bundle = docBundle.activate(host);
  await h.newBlank(612, 792);
  return {
    h,
    host,
    nextPick,
    opened,
    async open(name) {
      const importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      await importer.import({
        name,
        bytes: fixture(name),
        mimeType: DOCX_MIME,
      });
    },
    panel(id) {
      const p = h.panelsContributed().find((c) => c.id === id);
      if (!p) throw new Error(`no panel ${id}`);
      return p;
    },
    schemaPanel(id) {
      const c = schemaPanels.find((p) => p.id === id);
      if (!c) throw new Error(`no schema panel ${id}`);
      return c;
    },
    dispose() {
      bundle.dispose();
      handle.dispose();
      h.dispose();
    },
  };
}

export function mount(panel: PanelContribution) {
  const Component = panel.component;
  return render(
    <Component paged={undefined as never} api={undefined as never} />,
  );
}

export function mountSchema(d: DocHarness, id: string) {
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
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}
