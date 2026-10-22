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

// The canvas context menu (ADR 232, UX audit F-27): the frequent commands
// at the pointer, fed by the command registry. Each row is a COMMAND: its
// title, its `when` (the same predicate the Edit and Object menus grey on,
// evaluated against the live editor) and its chord from the keybinding
// registry. A row whose command is not registered is left out, so a solo
// profile or a missing bundle never shows a dead entry.
//
// Opened with `openCanvasContextMenu(x, y)` (the app's right-click and
// Shift+F10 / the context-menu key); Radix's menu gives it the roles,
// focus and keys (arrows, Enter, Escape, typeahead).

import { Fragment, useSyncExternalStore } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useOptionalPaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import { nativeKey, prettyKey } from "./MenuBar";

/** One row: a command, in a group (a separator between groups). */
export interface ContextMenuEntry {
  command: string;
  group: string;
  /** The row's label; the command's title when absent. */
  label?: string;
}

let at: { x: number; y: number } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};
const store = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  current: () => at,
};

/** Open the context menu at a client-space point. */
export function openCanvasContextMenu(x: number, y: number): void {
  at = { x, y };
  notify();
}

/** Close it (no-op when closed). */
export function closeCanvasContextMenu(): void {
  if (!at) return;
  at = null;
  notify();
}

/** Whether a command's `when` holds against `state`. */
function holds(when: unknown, state: unknown): boolean {
  if (typeof when !== "function") return when === undefined;
  try {
    return Boolean((when as (s: unknown) => unknown)(state));
  } catch {
    return false;
  }
}

export function CanvasContextMenu({
  entries,
}: {
  entries: readonly ContextMenuEntry[];
}) {
  const point = useSyncExternalStore(
    store.subscribe,
    store.current,
    store.current,
  );
  const registries = useRegistries();
  const commands = useRegistryView(registries.commands);
  const keybindings = useRegistryView(registries.keybindings);
  const paged = useOptionalPaged();
  const features = useRegistryView(registries.features);
  if (!point || !features.allows("chrome", "context-menu")) return null;
  const keys = new Map<string, string[]>();
  for (const b of keybindings.list()) {
    const list = keys.get(b.command);
    if (list) list.push(b.key);
    else keys.set(b.command, [b.key]);
  }
  const rows = entries.flatMap((e) => {
    const cmd = commands.get(e.command);
    // Not offered (a feature): not in the menu at all.
    if (!cmd || commands.offered?.(e.command) === false) return [];
    const chord = keys.get(e.command);
    return [
      {
        ...e,
        title: e.label ?? cmd.title,
        enabled: holds(cmd.when, paged),
        chord: chord ? prettyKey(nativeKey(chord)) : null,
      },
    ];
  });
  return (
    <DropdownMenu
      open
      modal
      onOpenChange={(open) => {
        if (!open) closeCanvasContextMenu();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: point.x,
            top: point.y,
            width: 0,
            height: 0,
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={0}
        aria-label="Canvas"
        data-testid="canvas-context-menu"
        className="min-w-[13rem]"
      >
        {rows.map((r, i) => (
          <Fragment key={r.command}>
            {i > 0 && rows[i - 1].group !== r.group && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              disabled={!r.enabled}
              data-command={r.command}
              onSelect={() => {
                closeCanvasContextMenu();
                void registries.commands.invoke(r.command);
              }}
            >
              {r.title}
              {r.chord && (
                <DropdownMenuShortcut>{r.chord}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
