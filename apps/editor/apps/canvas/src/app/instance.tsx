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
// profile it was mounted with, the surfaces that profile registers, and the
// actions its host supplies. `mountEditor` builds one per mount and hands it
// down through context, so nothing about the profile lives in module state
// and two editors on one page can carry different profiles.

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

import type { BundleEntry } from "../plugin-bundle-loader";
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
export function hostCommands(actions: HostActions): CommandContribution[] {
  const out: CommandContribution[] = [];
  const { submit, close, back } = actions;
  if (submit)
    out.push({
      id: "paged.host.submit",
      title: "Submit",
      handler: () => submit(),
    });
  if (close)
    out.push({
      id: "paged.host.close",
      title: "Close",
      handler: () => close(),
    });
  if (back)
    out.push({ id: "paged.host.back", title: "Back", handler: () => back() });
  return out;
}

/** What a host reaches once the shell is up: its editor and registries. */
export interface ShellAccess {
  readonly paged: PagedEditor;
  readonly registries: ShellRegistries;
  readonly client: CanvasClient;
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
