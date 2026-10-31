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

// Extensions ADR 349 (C6) — host.shell.enterSubContext / exitSubContext /
// subContext / onDidChangeSubContext and contribute.subContextProvider:
// a header, footer or note edited in place (editor ADR 301).

import { describe, expect, it } from "bun:test";

import type {
  BundleHost,
  EditContextContribution,
  PluginManifest,
  SubContextProviderContribution,
  SubContextRegistry,
  SubContextSpec,
  SubContextState,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { createHeadlessHost } from "../src/harness";
import { defineBundle } from "../src/define-bundle";
import { contributeEditContext } from "../src/edit-context";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
  contributes: {
    editContexts: [{ type: "wordDocument", entry: "doubleClick" }],
  },
} as PluginManifest;

const wordContext: EditContextContribution = {
  type: "wordDocument",
  entry: "doubleClick",
  matches: () => true,
};

const header: SubContextSpec = {
  kind: "header",
  pageId: "p3",
  storyId: "docx_h0d",
  bounds: [36, 72, 72, 540],
  masterId: "docx_m0d",
  commands: ["media.paged.test.linkToPrevious"],
};

/** A registry as small as the editor's: providers, the one shown. */
function registry(): SubContextRegistry {
  const providers: Array<{
    pluginId: string;
    c: SubContextProviderContribution;
  }> = [];
  let shown: SubContextState | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const enter = (pluginId: string, spec: SubContextSpec) => {
    shown = { ...spec, pluginId };
    emit();
    return true;
  };
  return {
    register(pluginId, c) {
      const e = { pluginId, c };
      providers.push(e);
      return { dispose: () => void providers.splice(providers.indexOf(e), 1) };
    },
    async resolve(hit) {
      for (const p of providers) {
        if (p.c.editContext !== hit.editContext) continue;
        const spec = await p.c.resolve(hit);
        if (spec) {
          enter(p.pluginId, spec);
          return shown;
        }
      }
      return null;
    },
    enter,
    exit(pluginId) {
      if (!shown || (pluginId && shown.pluginId !== pluginId)) return false;
      shown = null;
      emit();
      return true;
    },
    current: () => shown,
    onChange(h) {
      listeners.add(h);
      return { dispose: () => void listeners.delete(h) };
    },
  };
}

function withSubContexts() {
  const fake = makeFakeEditor();
  const reg = registry();
  (fake.editor.registries as unknown as Record<string, unknown>).subContexts =
    reg;
  return { fake, reg };
}

describe("host.shell sub-contexts (C6)", () => {
  it("enter, read, notify and leave a header in place", () => {
    const { fake, reg } = withSubContexts();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("shell.subContext@1")).toBe(true);
    expect(host.supports("contribute.subContextProvider@1")).toBe(true);
    const seen: Array<SubContextState | null> = [];
    host.shell.onDidChangeSubContext((s) => seen.push(s));
    expect(host.shell.enterSubContext(header)).toBe(true);
    expect(host.shell.subContext()).toEqual({
      ...header,
      pluginId: "media.paged.test",
    });
    expect(reg.current()?.storyId).toBe("docx_h0d");
    expect(host.shell.exitSubContext()).toBe(true);
    expect(host.shell.subContext()).toBeNull();
    expect(seen.map((s) => s?.kind ?? null)).toEqual(["header", null]);
  });

  it("a bundle leaves only its own sub-context", () => {
    const { fake, reg } = withSubContexts();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    reg.enter("media.paged.other", header);
    expect(host.shell.exitSubContext()).toBe(false);
    expect(reg.current()?.pluginId).toBe("media.paged.other");
  });

  it("disposing the bundle leaves its sub-context", () => {
    const { fake, reg } = withSubContexts();
    const { host, dispose } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    host.shell.enterSubContext(header);
    dispose();
    expect(reg.current()).toBeNull();
  });

  it("without the host's registry the doors answer honestly", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("shell.subContext@1")).toBe(false);
    expect(host.shell.enterSubContext(header)).toBe(false);
    expect(host.shell.subContext()).toBeNull();
    contributeEditContext(host, wordContext);
    expect(() =>
      host.contribute.subContextProvider({
        editContext: "wordDocument",
        resolve: () => null,
      }),
    ).not.toThrow();
  });
});

describe("contribute.subContextProvider (C6)", () => {
  it("borrows a registered edit context", () => {
    const { fake } = withSubContexts();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() =>
      host.contribute.subContextProvider({
        editContext: "wordDocument",
        resolve: () => null,
      }),
    ).toThrow(/no such edit context is registered/);
  });

  it("answers a double-click on a page's header band", async () => {
    const { fake, reg } = withSubContexts();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeEditContext(host, wordContext);
    host.contribute.subContextProvider({
      editContext: "wordDocument",
      resolve: (hit) =>
        hit.pagePoint[1] < 72 ? { ...header, pageId: hit.pageId } : null,
    });
    expect(
      await reg.resolve({
        editContext: "wordDocument",
        pageId: "p1",
        pagePoint: [100, 300],
      }),
    ).toBeNull();
    const entered = await reg.resolve({
      editContext: "wordDocument",
      pageId: "p1",
      pagePoint: [100, 50],
    });
    expect(entered?.pageId).toBe("p1");
    expect(entered?.pluginId).toBe("media.paged.test");
    expect(host.shell.subContext()?.kind).toBe("header");
  });
});

describe("the headless harness plays the double-click", () => {
  it("doubleClickPage asks the providers of the document context", async () => {
    const h = await createHeadlessHost({ console: silent });
    let host: BundleHost | null = null;
    h.loadBundle(
      defineBundle({
        manifest: MANIFEST,
        activate: (given) => {
          host = given;
          contributeEditContext(given, wordContext);
          given.contribute.subContextProvider({
            editContext: "wordDocument",
            resolve: (hit) => ({ ...header, pageId: hit.pageId }),
          });
          return { dispose() {} };
        },
      }),
    );
    const bundleHost = host as unknown as BundleHost;
    expect(bundleHost.supports("shell.subContext@1")).toBe(true);
    // No document context held: nothing is asked.
    expect(await h.doubleClickPage("p1", [10, 10])).toBeNull();
    bundleHost.shell.setDocumentContext("wordDocument");
    const s = await h.doubleClickPage("p1", [10, 10]);
    expect(s?.storyId).toBe("docx_h0d");
    expect(h.subContext()?.pageId).toBe("p1");
    expect(h.exitSubContext()).toBe(true);
    expect(bundleHost.shell.subContext()).toBeNull();
    h.dispose();
  });
});
