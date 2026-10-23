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

// One mounted editor (docs/composable-editor.md §8; plan task E1): the
// profile it was mounted with, the surfaces that profile registers, the
// actions its host supplies, and everything the editor keeps while it runs
// (its services and its scope's stores). `mountEditor` builds one per mount
// and hands it down through context, so nothing about one editor lives in
// module state and two editors on one page stay apart.

import { createContext, useContext, type ReactNode } from "react";

import type { CanvasClient, Role } from "@paged-media/client";
import type {
  CommandContribution,
  PagedEditor,
  PanelContribution,
  ShellRegistries,
  PanelRailItem,
  ProfileProblem,
  ResolvedProfile,
  ToolContribution,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import {
  createBindingProviderRegistry,
  type BindingProviderBackend,
  type loadBundle,
} from "@paged-media/plugin-sdk";
import {
  createEditorScope,
  setDocumentSourceSink,
  type EditorScope,
} from "@paged-media/shell";

import {
  createDocumentIdentity,
  indexedDbHandleStore,
  type DocumentIdentity,
} from "../document-identity";
import { editorObjectsOf, type EditorObjects } from "../object-model";
import {
  createBootGate,
  type BootGate,
  type BundleActivator,
  type BundleEntry,
} from "../plugin-bundle-loader";
import {
  createEditorConsentBackend,
  type EditorConsent,
} from "../plugin-consent";
import {
  createEditorDocuments,
  type EditorDocuments,
} from "../plugin-documents";
import type { EditorHostOptions } from "../plugin-host-options";
import { pageDoorsOf, type PageDoors } from "../plugin-pages";
import {
  createEditorSecretStore,
  type EditorSecretStore,
} from "../plugin-secret-store";
import {
  createWillSaveRegistry,
  type WillSaveRegistry,
} from "../plugin-will-save";
import type { PluginBundle } from "../plugin-bundle-table";
import type { AppSurfaces } from "../profiles/apply";

/** The surfaces a profile registers in this app. */
export type EditorSurfaces = AppSurfaces<
  PanelContribution,
  ToolContribution,
  PanelRailItem,
  BundleEntry<PluginBundle>
>;

/**
 * What the embedding host decides (concept §8.3). Each is optional; an
 * action the host supplies replaces the editor's own behaviour or adds a
 * command (`paged.host.<name>`) a profile can place in a region.
 */
export interface HostActions {
  /** Save: the `.paged` bytes, instead of a file write or a download. */
  save?(file: { bytes: Uint8Array; name: string }): Promise<void> | void;
  /** The actions bar's primary button (`paged.host.submit`). */
  submit?(): Promise<void> | void;
  /** Leave the editor (`paged.host.close`). */
  close?(): void;
  /** Go back in the host (`paged.host.back`). */
  back?(): void;
}

/**
 * The host's actions as commands (concept §8.3): one per action the host
 * supplied, so a profile can place it in a region (the actions bar, the
 * header) and a feature can switch it off. `save` is not one: it replaces
 * the editor's own save.
 */
const HOST = defineMessages("hostAction", {
  submit: "Submit",
  close: "Close",
  back: "Back",
});

export function hostCommands(actions: HostActions): CommandContribution[] {
  const out: CommandContribution[] = [];
  const { submit, close, back } = actions;
  if (submit)
    out.push({
      id: "paged.host.submit",
      title: t(HOST.submit),
      handler: () => submit(),
    });
  if (close)
    out.push({
      id: "paged.host.close",
      title: t(HOST.close),
      handler: () => close(),
    });
  if (back)
    out.push({
      id: "paged.host.back",
      title: t(HOST.back),
      handler: () => back(),
    });
  return out;
}

/** What a host reaches once the shell is up: its editor and registries. */
export interface ShellAccess {
  readonly paged: PagedEditor;
  readonly registries: ShellRegistries;
  readonly client: CanvasClient;
  /** Switches the editor between its dark and light theme. */
  readonly setThemeMode: (mode: "dark" | "light") => void;
}

/** The session's role, changeable while the editor runs (`setRole`). */
export interface RoleStore {
  get(): Role;
  set(role: Role): void;
  subscribe(listener: () => void): () => void;
}

export function createRoleStore(initial: Role): RoleStore {
  let role = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => role,
    set(next) {
      if (next === role) return;
      role = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A loaded bundle, as the activator keeps it. */
export interface LiveBundle {
  id: string;
  active: boolean;
  dispose(): void;
}

/**
 * What one editor keeps while it runs: the doors its bundle hosts are built
 * with and its dialogs and panels share. Each was a module singleton of
 * main.tsx; now each editor has its own (plan task E1).
 */
export interface EditorServices {
  /** Editor ADR 264 — the open document's identity, as this host knows it:
   *  the key a remembered grant is kept under. The shell's loader declares
   *  each load's source to it (through the scope); `PluginBundles` attaches
   *  the live engine client so it follows the open document. */
  readonly documentIdentity: DocumentIdentity;
  /** D-03 — the network-consent backend: `PluginBundles` injects `backend`
   *  into every bundle host, `<ConsentDialog>` renders the prompts from
   *  `controller`. */
  readonly consent: EditorConsent;
  /** D-26 (ADR 219) — the plugin documents door (host.documents). */
  readonly documents: EditorDocuments;
  /** D-11 — the reference credential store (host.secrets) and its prompt. */
  readonly secrets: EditorSecretStore;
  /** ADR 023 phase C — THE binding-provider registry of this editor: handed
   *  to every bundle host AND to `<PagedShell bindingProviders>`; they must
   *  be the same object. */
  readonly bindingProviders: BindingProviderBackend;
  /** v66 — `host.document.onWillSave`: Save (.paged) runs it first. */
  readonly willSave: WillSaveRegistry;
  /** ADR 323 — the object registry (in the scope, so panels reach it). */
  readonly objects: EditorObjects;
  /** v70 — the page and text-reveal doors (in the scope). */
  readonly pages: PageDoors;
  /** ADR 222 — no document opens before the boot bundles are active. */
  readonly boot: BootGate;
  /** The bundles while they run: the activator of the mounted
   *  `PluginBundles` (StrictMode mounts it twice; only the live one may
   *  settle the boot lane or serve `ensure`) and the host options every
   *  bundle got. Null before the shell mounts. */
  readonly bundles: BundleLane;
}

/** Load one more bundle through the same loader and host options. */
export type LoadOneBundle = (
  bundle: Parameters<typeof loadBundle>[1],
) => ReturnType<typeof loadBundle>;

/** The live bundle lane of the mounted `PluginBundles`. */
export interface BundleLane {
  activator(): BundleActivator<LiveBundle> | null;
  hostOptions(): EditorHostOptions | null;
  loadBundle(): LoadOneBundle | null;
  /** What the mounted `PluginBundles` built; returns the release (a no-op
   *  once a later mount attached its own). */
  attach(live: {
    activator: BundleActivator<LiveBundle>;
    hostOptions: EditorHostOptions;
    loadBundle: LoadOneBundle;
  }): () => void;
}

function createBundleLane(): BundleLane {
  let live: Parameters<BundleLane["attach"]>[0] | null = null;
  return {
    activator: () => live?.activator ?? null,
    hostOptions: () => live?.hostOptions ?? null,
    loadBundle: () => live?.loadBundle ?? null,
    attach(next) {
      live = next;
      return () => {
        if (live === next) live = null;
      };
    },
  };
}

/** One editor's services, over its scope. */
export function createEditorServices(scope: EditorScope): EditorServices {
  const documentIdentity = createDocumentIdentity({
    store: indexedDbHandleStore(),
  });
  setDocumentSourceSink(scope, documentIdentity);
  return {
    documentIdentity,
    consent: createEditorConsentBackend({ identity: documentIdentity }),
    documents: createEditorDocuments(scope),
    secrets: createEditorSecretStore(),
    bindingProviders: createBindingProviderRegistry(),
    willSave: createWillSaveRegistry(),
    objects: editorObjectsOf(scope),
    pages: pageDoorsOf(scope),
    boot: createBootGate(),
    bundles: createBundleLane(),
  };
}

export { createEditorScope };

export interface EditorInstance {
  readonly profile: ResolvedProfile;
  readonly surfaces: EditorSurfaces;
  readonly actions: HostActions;
  readonly problems: readonly ProfileProblem[];
  /** Called once the editor's client exists. */
  readonly onClient?: (client: CanvasClient) => void;
  /** Called once the shell is mounted, with what a host drives it by. */
  readonly onShell?: (shell: ShellAccess) => void;
  /** The session's role; the profile's at mount. */
  readonly role: RoleStore;
  /** Renders the page's dev and demo tools (`MountOptions.devTools`). */
  readonly devTools: boolean;
  /** The editor's own stores (the shell's and the app's), handed to
   *  `<PagedShell scope>`. */
  readonly scope: EditorScope;
  /** What the editor keeps while it runs. */
  readonly services: EditorServices;
  /** Where the engine's wasm is served, when the host names it; else the
   *  build's own asset. */
  readonly engineWasm?: string;
}

const InstanceContext = createContext<EditorInstance | null>(null);

export function EditorInstanceProvider({
  instance,
  children,
}: {
  instance: EditorInstance;
  children: ReactNode;
}) {
  return (
    <InstanceContext.Provider value={instance}>
      {children}
    </InstanceContext.Provider>
  );
}

/** The editor this component is mounted in. */
export function useEditorInstance(): EditorInstance {
  const instance = useContext(InstanceContext);
  if (!instance) throw new Error("useEditorInstance outside an editor mount");
  return instance;
}
