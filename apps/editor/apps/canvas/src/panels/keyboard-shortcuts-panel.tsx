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

// E1 — Help ▸ Keyboard shortcuts.
//
// `Help` was the app's only offer to explain itself and BOTH its items
// were disabled `soon(...)` seams. Nothing anywhere listed a shortcut:
// the menus carried no accelerator column, the palette showed raw
// command ids, and `KeybindingRegistry.list()` — documented as existing
// "for diagnostics + the future 'Show keybindings' panel" — had zero
// call sites. A user who could not work something out had nowhere to
// look, in the app or out of it.
//
// Rendered from the LIVE registry rather than a hand-kept table, so it
// cannot drift: a binding that exists appears here, a binding that is
// removed disappears, and plugin bindings are listed the moment their
// bundle loads. The palette and the menu accelerators read the same
// source.
//
// THE HONEST LIMIT, stated in the panel itself rather than only here:
// a dozen bindings never reach the registry. Undo/redo, caret motion,
// path-edit keys and the spring-loaded tool holds are bound with ad-hoc
// `window`/`document` listeners in `useTextEditing`, `usePathEditMode`
// and `use-spring-loaded-tools` (the zoom fits and the page keys are
// registry bindings since ADR 246 and ADR 257).
//
// GROUPED BY CONTEXT (UX audit F-16): one section per command category,
// so a chord two contexts share (Cmd+D places an image, and fills down
// inside a sheet) reads as two contexts, not as a duplicate. A panel that silently omitted them would
// be a worse lie than the seam it replaces — it would look complete.
// They are listed from a maintained table below, and marked as such.

import { useMemo } from "react";

import {
  CockpitPanelHeader,
  CockpitSection,
  nativeKey,
  prettyKey,
  useRegistries,
  useRegistryView,
  type PanelProps,
} from "@paged-media/shell";
import {
  createStrings,
  defineMessages,
  useStrings,
} from "@paged-media/strings";

export const KEYBOARD_SHORTCUTS_PANEL_ID = "paged.keyboard-shortcuts";

const M = defineMessages("app.keyboardShortcutsPanel", {
  title: "Keyboard shortcuts",
  general: "General",
  notInRegistry: "Not in the registry",
  adHocNote:
    "These are bound with their own listeners rather than through the " +
    "keybinding registry, so they are listed from a maintained table. Undo " +
    "and the caret keys live here.",
  hold: "{key} (hold)",
  space: "Space",
  undo: "Undo",
  redo: "Redo",
  pan: "Pan — spring-loaded Hand",
  zoom: "Zoom — spring-loaded",
  directSelection: "Direct Selection — spring-loaded",
  enterPathEdit: "Enter path-edit mode",
  nudgeAnchors: "Nudge the selected anchors, in path-edit mode (⇧ ×10)",
  removeAnchors: "Remove the selected anchors, in path-edit mode",
  leaveContext: "Leave an edit context, or cancel a gesture",
  moveCaret: "Move the caret (with ⇧ to extend)",
});

/** The English words, for the rows' data attributes (stable across
 *  locales). */
const ENGLISH = createStrings();

/** The bindings that bypass the KeybindingRegistry entirely.
 *
 *  Hand-maintained, and that is a liability worth naming: nothing fails
 *  when one of these is renamed. It is still far better than omitting
 *  them, because a user reading a shortcuts panel reasonably concludes
 *  that what is absent is unbound — and Cmd+Z is not unbound. `what` is
 *  a message key; `hold` marks a key held down. */
const AD_HOC: { key: string; hold?: boolean; what: string; where: string }[] = [
  { key: prettyKey("cmd+z"), what: M.undo, where: "useTextEditing" },
  { key: prettyKey("cmd+shift+z"), what: M.redo, where: "useTextEditing" },
  {
    key: "Space",
    hold: true,
    what: M.pan,
    where: "use-spring-loaded-tools",
  },
  {
    key: prettyKey("cmd+space"),
    hold: true,
    what: M.zoom,
    where: "use-spring-loaded-tools",
  },
  {
    key: prettyKey("cmd+x").startsWith("⌘") ? "⌘" : "Ctrl",
    hold: true,
    what: M.directSelection,
    where: "use-spring-loaded-tools",
  },
  { key: "Enter", what: M.enterPathEdit, where: "usePathEditMode" },
  { key: "← → ↑ ↓", what: M.nudgeAnchors, where: "usePathEditMode" },
  { key: "⌫ / Delete", what: M.removeAnchors, where: "usePathEditMode" },
  { key: "Esc", what: M.leaveContext, where: "edit-context-controller" },
  { key: "← → ↑ ↓", what: M.moveCaret, where: "useTextEditing" },
];

export function KeyboardShortcutsPanel(_props: PanelProps) {
  // Views of the registries (ADR 229): the table follows what bundles
  // register after it first rendered.
  const strings = useStrings();
  const registries = useRegistries();
  const keybindings = useRegistryView(registries.keybindings);
  const commands = useRegistryView(registries.commands);

  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const rows = useMemo(() => {
    const titles = new Map(commands.list().map((c) => [c.id, c.title]));
    const categories = new Map(
      commands.list().map((c) => [c.id, c.category ?? "General"]),
    );
    // One row per COMMAND. cmd+ and ctrl+ are separate contributions for
    // the same thing; show the one for this platform (the menus do the
    // same), and any genuinely different second chord beside it.
    const byCommand = new Map<string, { raw: string[]; title: string }>();
    for (const b of keybindings.list()) {
      const entry = byCommand.get(b.command) ?? {
        raw: [],
        title: titles.get(b.command) ?? b.command,
      };
      entry.raw.push(b.key);
      byCommand.set(b.command, entry);
    }
    const twin = (k: string) =>
      k.toLowerCase().replace(/\b(cmd|meta|ctrl|control)\b/g, "mod");
    return [...byCommand.entries()]
      .map(([id, v]) => {
        const chords = new Map<string, string[]>();
        for (const k of v.raw)
          chords.set(twin(k), [...(chords.get(twin(k)) ?? []), k]);
        const keys = [
          ...new Set(
            [...chords.values()].map((ks) => prettyKey(nativeKey(ks))),
          ),
        ];
        return {
          id,
          title: v.title,
          keys,
          category: categories.get(id) ?? "General",
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [keybindings, commands]);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  }
  const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div data-keyboard-shortcuts-panel="ready">
      <CockpitPanelHeader title={strings.t(M.title)} />
      <div data-shortcut-rows>
        {sections.map(([category, list]) => (
          <CockpitSection
            key={category}
            title={`${category === "General" ? strings.t(M.general) : category} (${list.length})`}
          >
            <div data-shortcut-group={category}>
              {list.map((r) => (
                <div
                  key={r.id}
                  data-shortcut-row={r.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "3px 14px",
                    fontSize: 12,
                  }}
                >
                  <span>{r.title}</span>
                  <span className="pg-mono-meta" style={{ opacity: 0.75 }}>
                    {r.keys.join("  ")}
                  </span>
                </div>
              ))}
            </div>
          </CockpitSection>
        ))}
      </div>
      <CockpitSection
        title={`${strings.t(M.notInRegistry)} (${AD_HOC.length})`}
      >
        <div
          className="pg-ui-xs"
          style={{ padding: "0 14px 6px", opacity: 0.7 }}
          data-shortcut-adhoc-note
        >
          {strings.t(M.adHocNote)}
        </div>
        {AD_HOC.map((r) => (
          <div
            key={r.key + r.what}
            data-shortcut-adhoc={ENGLISH.t(r.what)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "3px 14px",
              fontSize: 12,
            }}
          >
            <span>{strings.t(r.what)}</span>
            <span className="pg-mono-meta" style={{ opacity: 0.75 }}>
              {r.hold
                ? strings.t(M.hold, {
                    key: r.key === "Space" ? strings.t(M.space) : r.key,
                  })
                : r.key}
            </span>
          </div>
        ))}
      </CockpitSection>
    </div>
  );
}
