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

import { createFeatureStore, type FeatureStore } from "./features";
import { editorRootOf, ownsEvent } from "./editor-root";
import { useEditorScope } from "./editor-scope";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from "react";

import {
  createCommandRegistry,
  createEditContextRegistry,
  createExporterRegistry,
  createFrameSurfaceRegistry,
  createImporterRegistry,
  createKeybindingRegistry,
  createMenuRegistry,
  createObjectTypeRegistry,
  createOverlayRegistry,
  createModeRegistry,
  createPanelRegistry,
  createSemanticGroupRegistry,
  createToolRegistry,
  type CommandRegistry,
  type EditContextRegistry,
  type ExporterRegistry,
  type FrameSurfaceRegistry,
  type ImporterRegistry,
  type KeybindingRegistry,
  type MenuRegistry,
  type ModeRegistry,
  type ObjectTypeRegistry,
  type OverlayRegistry,
  type PanelRegistry,
  type SemanticGroupRegistry,
  type ToolRegistry,
} from "../registries";

/**
 * The shell registries. Lifetime is the shell's: created at mount,
 * kept across renders so dispose handles registered by panels /
 * overlays stay valid as React re-renders.
 */
export interface ShellRegistries {
  /** What the editor offers (docs/composable-editor.md §6): the feature
   *  gate every surface consults. Not security; see state/features.ts. */
  features: FeatureStore;
  panels: PanelRegistry;
  modes: ModeRegistry;
  commands: CommandRegistry;
  semanticGroups: SemanticGroupRegistry;
  keybindings: KeybindingRegistry;
  menus: MenuRegistry;
  overlays: OverlayRegistry;
  tools: ToolRegistry;
  /** W3.2 — edit contexts (B-02): the registration door for a plugin's
   *  double-click-entered scoped editing modes. */
  editContexts: EditContextRegistry;
  /** W3.2 — object types (W-03): plugin-defined objects (a webFrame)
   *  whose double-click routes to an edit context. */
  objectTypes: ObjectTypeRegistry;
  /** K-2 / S-06 — document importers (file → plugin). The open +
   *  drag-drop flow consults this by extension before the default IDML
   *  load. */
  importers: ImporterRegistry;
  /** K-2 / S-06 — document exporters (plugin → file). The export panel
   *  lists these and pulls bytes on save. */
  exporters: ExporterRegistry;
  /** Frame surfaces (extensions ADR 334): a bundle's live editing surface
   *  for one of its edit contexts, mounted over the active frame. */
  frameSurfaces: FrameSurfaceRegistry;
}

const Context = createContext<ShellRegistries | null>(null);

/**
 * The shell's registry set, outside React: what `RegistriesProvider`
 * mounts, and what a headless editor (the editor's `tests/headless`
 * harness) builds without a DOM. `getEditor` is the command registry's
 * handler argument and the keybinding registry's `when` state.
 */
export function createShellRegistries(
  getEditor: () => unknown,
  options: {
    /** Whether a key event is this editor's (its root's); absent, every
     *  key on the page (a headless editor, a test). */
    ownsKey?: (event: KeyboardEvent) => boolean;
  } = {},
): ShellRegistries {
  const features = createFeatureStore(getEditor);
  const commands = createCommandRegistry(getEditor, features);
  // Pass `getEditor` as the keybinding state thunk too, so `when`
  // predicates (e.g. the tool-shortcut text-suppression guard) read
  // the live editor handle.
  const keybindings = createKeybindingRegistry(
    commands,
    getEditor,
    features,
    options.ownsKey,
  );
  // Tools are supplied by the app via `<PagedShell tools={...}>` and
  // registered in ShellChrome (mirrors panels/overlays), so the rail
  // contains zero hardcoded entries. Bundles add more via
  // `useRegistries().tools.register(...)`.
  const tools = createToolRegistry();
  return {
    features,
    panels: createPanelRegistry(),
    modes: createModeRegistry(),
    commands,
    semanticGroups: createSemanticGroupRegistry(),
    keybindings,
    menus: createMenuRegistry(),
    overlays: createOverlayRegistry(),
    tools,
    editContexts: createEditContextRegistry(),
    objectTypes: createObjectTypeRegistry(),
    importers: createImporterRegistry(),
    exporters: createExporterRegistry(),
    frameSurfaces: createFrameSurfaceRegistry(),
  };
}

/**
 * Mounts the four registry instances at the shell root. The command
 * registry needs a `getEditor` thunk so its `invoke` can pass the
 * current `PagedEditor` into handlers; the caller (typically the
 * PagedEditor provider) supplies it.
 */
export function RegistriesProvider({
  getEditor,
  children,
}: PropsWithChildren<{ getEditor: () => unknown }>) {
  // Stable instances across renders. useRef beats useMemo here
  // because we want guaranteed identity even if React invokes the
  // memo factory twice (Strict Mode does this in dev).
  const ref = useRef<ShellRegistries | null>(null);
  const scope = useEditorScope();
  if (!ref.current) {
    // The keybindings answer the keys of this editor's root only.
    ref.current = createShellRegistries(getEditor, {
      ownsKey: (event) => ownsEvent(editorRootOf(scope), event),
    });
  }

  // Keydown listener lifecycle — symmetric attach/detach so
  // StrictMode's mount→unmount→mount cycle re-installs the listener
  // (the registry instance survives in the ref; only the listener
  // is torn down at unmount).
  useEffect(() => {
    const keybindings = ref.current?.keybindings;
    keybindings?.attach();
    return () => {
      keybindings?.detach();
    };
  }, []);

  // Wrap in useMemo so consumers see a stable object reference.
  // eslint-disable-next-line no-restricted-syntax -- the component is not compiled yet (compiler-coverage.json) (ADR 229)
  const value = useMemo(() => ref.current!, []);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRegistries(): ShellRegistries {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useRegistries called outside RegistriesProvider");
  }
  return ctx;
}
