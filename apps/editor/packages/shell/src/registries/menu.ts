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

import type * as Api from "@paged-media/plugin-api";

import type { Disposable, Registrable, VisibilityPredicate } from "./types";

/**
 * The item the SDK adapter hands this registry for a plugin's
 * `contribute.menu`: the contract's menu-registry item (path, command,
 * order, group, and the `when` the adapter derives from the entry's
 * `scope`). The plugin-facing `MenuContribution` never reaches the
 * shell; the adapter translates it, so `scope` arrives as `when` and
 * `mode` does not arrive at all.
 */
type ContractMenuItem = Parameters<
  NonNullable<Api.ShellRegistries["menus"]>["register"]
>[0];

/**
 * Declarative menu item. Items contribute themselves to a path-based
 * tree — `"File/Open…"` → File menu, "Open…" leaf. The
 * shell renders top-level path segments as drop-down menus; nested
 * paths nest as sub-menus.
 *
 * Menu items are commands underneath: selecting one invokes
 * `commands.invoke(command)`. Reuse beats parallel surfaces, so
 * keybindings, palette entries, and menu items all dispatch to the
 * same command id.
 *
 * The contract's menu-registry item ({@link ContractMenuItem}: `path`
 * — slash-separated, `"File/Open…"`; `command`; `order` — lower floats
 * up within the group, default 100; `group` — items sharing one cluster,
 * a separator between groups) plus the fields only the editor's own
 * items set. `when` is WIDENED to the full `VisibilityPredicate`: the
 * shell's items may use the (inert) string form; the adapter only ever
 * passes a function.
 */
export interface MenuItemContribution extends Omit<ContractMenuItem, "when"> {
  /** E4 — a human heading for this item's group.
   *
   *  The Window menu already computes these (`WINDOW_MENU_CATEGORIES`:
   *  Workspace / Structure / Styles / Text / Properties / Object /
   *  Output / Developer) and then threw them away, because `MenuBar`
   *  only ever emitted a separator on a group change. So ~90 panel
   *  entries rendered as one flat list divided by unlabelled hairlines —
   *  the grouping was done and the user could not see it.
   *
   *  Optional: a menu whose groups need no names (File's open/save
   *  clusters) keeps the bare separator. */
  groupLabel?: string;

  /** Visible-but-disabled seam — a kit menu item whose backing
   * doesn't exist yet. Renders greyed with a "soon" marker and
   * never invokes (the honest-stub convention). */
  disabled?: boolean;

  /** Optional visibility predicate. Same shape + Step-3 semantics
   * (function evaluated against application state; DSL string is
   * inert until the evaluator lands in a later step). */
  when?: VisibilityPredicate;

  /** v66 — a label computed from application state at render ("Undo
   *  Brush stroke"). `null` / absent ⇒ the path's own label. Evaluated
   *  like `when`; a throw falls back to the static label. */
  labelFor?: (state: unknown) => string | null;

  /** Icon name for the item's leading column (the shared icon
   *  registries). Optional: panel-show and tool-activate items take the
   *  panel's / tool's own icon without declaring one. */
  icon?: string;

  /** A key combo to SHOW when the command's real binding lives outside
   *  the KeybindingRegistry (Undo/Redo are handled by the text-editing
   *  hook). Display only — it binds nothing. A registered binding for
   *  the command wins over it. */
  accelerator?: string;

  /** `"label"` renders a muted, non-interactive line (Help's version
   *  line). Its `command` is still the dedupe identity, never invoked. */
  kind?: "item" | "label";
}

/** A plugin's menu entry, as the adapter hands it over, registers here
 *  unchanged. */
export type _MenuItemRegistrable = Registrable<
  MenuItemContribution,
  ContractMenuItem
>;

export type MenuRegistryEvent =
  | { kind: "registered"; contribution: MenuItemContribution }
  | { kind: "unregistered"; path: string };

export interface MenuRegistry extends NonNullable<
  Api.ShellRegistries["menus"]
> {
  register(contribution: MenuItemContribution): Disposable;
  unregister(path: string): void;
  get(path: string): MenuItemContribution | undefined;
  list(): MenuItemContribution[];
  onChange(handler: (event: MenuRegistryEvent) => void): Disposable;
}

/**
 * Default in-memory `MenuRegistry`. Path is the dedupe key; two
 * items at the same path conflict the way two panels at the same id
 * conflict. Insertion order is preserved within a sort-by-order tie.
 */
export function createMenuRegistry(): MenuRegistry {
  const byPath = new Map<string, MenuItemContribution>();
  const listeners = new Set<(event: MenuRegistryEvent) => void>();

  function emit(event: MenuRegistryEvent) {
    for (const fn of listeners) fn(event);
  }

  return {
    register(contribution) {
      const existing = byPath.get(contribution.path);
      if (existing) {
        throw new Error(
          `MenuRegistry: path "${contribution.path}" already registered`,
        );
      }
      byPath.set(contribution.path, contribution);
      emit({ kind: "registered", contribution });
      return {
        dispose() {
          if (byPath.delete(contribution.path)) {
            emit({ kind: "unregistered", path: contribution.path });
          }
        },
      };
    },
    unregister(path) {
      if (byPath.delete(path)) {
        emit({ kind: "unregistered", path });
      }
    },
    get(path) {
      return byPath.get(path);
    },
    list() {
      return Array.from(byPath.values());
    },
    onChange(handler) {
      listeners.add(handler);
      return {
        dispose() {
          listeners.delete(handler);
        },
      };
    },
  };
}
