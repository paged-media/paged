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

// Modifier hints (the interaction specification's §7.5 and §11.4; editor
// ADR 1201's consequences: the habits it changed ship with hints on the
// canvas; plan task IC10). A strip over the canvas's bottom-left names what
// the modifiers do with the tool in hand — the handler's own
// `modifierHints` (the contract, extensions ADR 1109), else the host's for
// its built-in tools — and lights the
// ones held. It shows for a tool's first uses and then recedes; a
// preference keeps it showing.

import { useEffect, useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import type { ModifierHint } from "@paged-media/plugin-api";

import { MODIFIER_HINTS } from "../chrome/messages";
import {
  useModifierState,
  type ModifierState,
} from "../hooks/useModifierState";
import {
  createValueStore,
  scoped,
  useEditorScope,
  useScoped,
  type EditorScope,
  type ValueStore,
} from "../state/editor-scope";
import { editorStorage } from "../state/storage";

/** The storage keys (scripts/settings-inventory.json). */
export const MODIFIER_HINTS_ALWAYS_KEY = "paged.modifierHints.always";
export const MODIFIER_HINTS_USES_KEY = "paged.modifierHints.uses";

/** The command that flips "keep modifier hints visible". */
export const MODIFIER_HINTS_COMMAND = "paged.preferences.modifierHints";

/** How many times a tool is taken up before its hints recede. */
export const MODIFIER_HINT_USES = 5;

function storedAlways(scope: EditorScope): boolean {
  try {
    return editorStorage(scope).getItem(MODIFIER_HINTS_ALWAYS_KEY) === "true";
  } catch {
    return false;
  }
}

/** The uses per tool, read field by field (ADR 247): a record of counts. */
function storedUses(scope: EditorScope): Record<string, number> {
  try {
    const raw = editorStorage(scope).getItem(MODIFIER_HINTS_USES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

const ALWAYS = scoped("modifierHintsAlways", (scope): ValueStore<boolean> =>
  createValueStore(storedAlways(scope)),
);
const USES = scoped(
  "modifierHintsUses",
  (scope): ValueStore<Record<string, number>> =>
    createValueStore(storedUses(scope)),
);

/** Are the hints kept visible past a tool's first uses? */
export function modifierHintsAlways(scope: EditorScope): boolean {
  return scope.get(ALWAYS).get();
}

/** Keep the hints visible (or let them recede again), remembered. */
export function setModifierHintsAlways(scope: EditorScope, on: boolean): void {
  scope.get(ALWAYS).set(on);
  try {
    const storage = editorStorage(scope);
    if (on) storage.setItem(MODIFIER_HINTS_ALWAYS_KEY, "true");
    else storage.removeItem(MODIFIER_HINTS_ALWAYS_KEY);
  } catch {
    // A host that refuses storage keeps the choice for this session.
  }
}

/** Count one more use of `toolId` (it was taken up). */
function noteUse(scope: EditorScope, toolId: string): void {
  const store = scope.get(USES);
  const next = { ...store.get(), [toolId]: (store.get()[toolId] ?? 0) + 1 };
  store.set(next);
  try {
    editorStorage(scope).setItem(MODIFIER_HINTS_USES_KEY, JSON.stringify(next));
  } catch {
    // Counted for this session.
  }
}

type Messages = typeof MODIFIER_HINTS;

/** The host's hints for its built-in tools whose handler names none (the
 *  Selection tools have no handler). */
export function builtInHints(
  toolId: string,
  t: (m: Messages[keyof Messages]) => string,
): ModifierHint[] {
  switch (toolId) {
    case "paged.tool.select":
      return [
        { keys: ["shift"], label: t(MODIFIER_HINTS.toggle) },
        { keys: ["alt"], label: t(MODIFIER_HINTS.duplicate) },
        { keys: ["primary"], label: t(MODIFIER_HINTS.noSnap) },
        { keys: ["space"], label: t(MODIFIER_HINTS.pan) },
      ];
    case "paged.tool.directSelect":
      return [
        { keys: ["shift"], label: t(MODIFIER_HINTS.toggle) },
        { keys: ["primary"], label: t(MODIFIER_HINTS.noSnap) },
      ];
    case "paged.tool.rectangle":
    case "paged.tool.ellipse":
    case "paged.tool.polygon":
      return [
        { keys: ["shift"], label: t(MODIFIER_HINTS.square) },
        { keys: ["alt"], label: t(MODIFIER_HINTS.fromCentre) },
      ];
    default:
      return [];
  }
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function keyName(key: ModifierHint["keys"][number]): string {
  switch (key) {
    case "shift":
      return "⇧";
    case "alt":
      return IS_MAC ? "⌥" : "Alt";
    case "primary":
      return IS_MAC ? "⌘" : "Ctrl";
    case "ctrl":
      return IS_MAC ? "⌃" : "Ctrl";
    case "space":
      return "Space";
  }
}

function held(key: ModifierHint["keys"][number], m: ModifierState): boolean {
  switch (key) {
    case "shift":
      return m.shift;
    case "alt":
      return m.alt;
    case "primary":
      return IS_MAC ? m.meta : m.ctrl;
    case "ctrl":
      return m.ctrl;
    case "space":
      return false;
  }
}

export interface ModifierHintsProps {
  /** The tool in hand. */
  toolId: string;
  /** Its handler's own hints (the contract's `modifierHints`), if any. */
  hints?: readonly ModifierHint[] | null;
}

/** The strip; renders nothing when the tool names no hints or they have
 *  receded. */
export function ModifierHints({ toolId, hints }: ModifierHintsProps) {
  const strings = useStrings();
  const scope = useEditorScope();
  const alwaysStore = useScoped(ALWAYS);
  const always = useSyncExternalStore(
    alwaysStore.subscribe,
    alwaysStore.get,
    alwaysStore.get,
  );
  const usesStore = useScoped(USES);
  const uses = useSyncExternalStore(
    usesStore.subscribe,
    usesStore.get,
    usesStore.get,
  );
  const mods = useModifierState();
  // Taking a tool up counts one use of it.
  useEffect(() => {
    if (toolId) noteUse(scope, toolId);
  }, [scope, toolId]);
  const list =
    hints && hints.length > 0
      ? hints
      : builtInHints(toolId, (m) => strings.t(m));
  const early = (uses[toolId] ?? 0) <= MODIFIER_HINT_USES;
  if (list.length === 0 || (!always && !early)) return null;
  return (
    <div
      data-modifier-hints={toolId}
      role="note"
      aria-label={strings.t(MODIFIER_HINTS.label)}
      style={stripStyle}
    >
      {list.map((h) => {
        const on = h.keys.every((k) => held(k, mods));
        return (
          <span
            key={`${h.keys.join("+")}:${h.label}`}
            data-modifier-hint={h.keys.join("+")}
            data-held={on ? "" : undefined}
            style={on ? heldStyle : hintStyle}
          >
            <kbd style={kbdStyle}>{h.keys.map(keyName).join(" ")}</kbd>{" "}
            {h.label}
          </span>
        );
      })}
    </div>
  );
}

const stripStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  maxWidth: "calc(100% - 24px)",
  padding: "4px 8px",
  borderRadius: 6,
  background: "var(--elevated)",
  color: "var(--fg-muted, var(--fg))",
  border: "1px solid var(--border)",
  fontSize: 11,
  pointerEvents: "none",
  opacity: 0.92,
  zIndex: 2,
};

const hintStyle: React.CSSProperties = { whiteSpace: "nowrap" };

const heldStyle: React.CSSProperties = {
  whiteSpace: "nowrap",
  color: "var(--fg)",
  fontWeight: 600,
};

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "0 4px",
  borderRadius: 3,
  border: "1px solid var(--border)",
};
