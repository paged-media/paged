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

// The `__*` test handles of one editor (plan task E1). Playwright specs and
// the demo playground reach the editor's doors through them: the shell's
// automation handle (`__canvas`), the consent and secret prompts, the
// documents door, the binding providers, the bundle lane, the plugin host's
// doors. Each reads the instance it was published for, at the moment it is
// read. Only the page entry publishes them (entry.tsx, dev and demo builds);
// `mountEditor` never does, so an embedding host's page gets none.

import moduleManifest from "virtual:paged-modules";

import { debugHandlesOf, replacePrompts } from "@paged-media/shell";

import type { EditorInstance } from "./instance";

type Handles = Record<string, unknown>;

/** Publish `instance`'s handles on `globalThis`; returns the unpublish. */
export function publishDevHandles(instance: EditorInstance): () => void {
  const { services } = instance;
  const {
    bindingProviders,
    boot,
    bundles,
    consent,
    documents,
    objects,
    secrets,
    willSave,
  } = services;
  const handles: Handles = {
    // Drive a synthetic consent prompt and observe/resolve it without a
    // network-declaring bundle.
    __consent: {
      request: consent.backend.request,
      current: () => consent.controller.current(),
    },
    // Drive the documents door without a bundle that declares
    // `capabilities.documents`. The requester is a fixed test identity.
    __documents: {
      exportPaged: () => documents.backend.exportPaged(),
      open: (bytes: Uint8Array, name?: string) =>
        documents.backend.open(bytes, {
          name: name ?? null,
          requester: { id: "media.paged.test", name: "Test plugin" },
        }),
      current: () => replaceQuestion(instance),
    },
    // The ACTIVE provider stack — what the retarget proof is about.
    __bindingProviders: {
      active: () => bindingProviders.activeProviders(),
      readCollection: (collection: string) =>
        bindingProviders.readCollection({ collection: collection as never }),
    },
    // A synthetic set prompt, and the persistence tier by passphrase.
    __secrets: {
      set: secrets.backend.set,
      exists: secrets.backend.exists,
      forget: secrets.backend.forget,
      current: () => secrets.controller.current(),
      tier: () => secrets.controller.tier(),
      setPassphrase: (p: string | null) => secrets.controller.setPassphrase(p),
    },
    // Specs wait for `settled` before probing plugin contributions, and
    // can force an on-demand bundle active.
    __pluginBundles: {
      get settled() {
        return boot.isSettled();
      },
      ready: () => boot.settled(),
      active: () => bundles.activator()?.active() ?? [],
      ensure: async (id: string) =>
        (await bundles.activator()?.ensure(id)) != null,
    },
    // v66 — Save waits for a listener a spec registers as a bundle would.
    __willSave: willSave,
  };
  // Live: they exist once the bundles' host options do.
  const debug = () => debugHandlesOf(instance.scope);
  const live: Record<string, () => unknown> = {
    // The shell's automation handle, refreshed after every commit, and the
    // demo runner over it (PagedShell).
    __canvas: () => debug().canvas,
    __demo: () => debug().demo,
    // The overlay-signal writer (the overlay preview specs).
    __overlaySignals: () => debug().overlaySignals,
    // The last canvas pointer event built (the stylus plumbing spec).
    __canvasPointer: () => debug().pointer,
    // The last crash the shell's boundary caught.
    __pagedCrash: () => debug().crash,
    // The aggregate PagedEditor handle every bundle host's `getEditor()`
    // returns: specs probe the members capability flags gate on.
    __paged: () => objects.editor() ?? undefined,
    // The injected caret reader, without a caret-consuming bundle.
    __textCaret: () => bundles.hostOptions()?.textCaret,
    // The module door's answers.
    __modules: () => {
      const host = bundles.hostOptions();
      return host
        ? { backend: host.modules, manifest: moduleManifest }
        : undefined;
    },
    // The shell doors the host app injects, driven as a bundle would.
    __shellDoors: () => bundles.hostOptions()?.shared.shell,
    // A throwaway bundle through the SAME loader and host options every
    // real bundle gets; returns the disposer.
    __loadTestBundle: () => bundles.loadBundle() ?? undefined,
  };
  const g = globalThis as unknown as Handles;
  for (const [name, value] of Object.entries(handles)) g[name] = value;
  for (const [name, get] of Object.entries(live)) {
    Object.defineProperty(g, name, { get, configurable: true });
  }
  return () => {
    for (const name of [...Object.keys(handles), ...Object.keys(live)]) {
      if (Object.getOwnPropertyDescriptor(g, name)) delete g[name];
    }
  };
}

function replaceQuestion(instance: EditorInstance) {
  return replacePrompts(instance.scope).current();
}
