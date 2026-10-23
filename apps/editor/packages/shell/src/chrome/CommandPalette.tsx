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

import { useEffect, useState } from "react";
import { useStrings } from "@paged-media/strings";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/ui/command";
import { AI_ASK_COMMAND } from "../ai/editor-ai";
import { aiUnavailableText, useAiAvailability } from "../ai/availability";
import { acceleratorLookup } from "./MenuBar";
import { PoweredByClaude } from "../ai/powered-by-claude";
import { Icon } from "../icons";
import { paletteScore } from "./palette-score";
import type { CommandContribution, CommandRegistry } from "../registries";
import { useRegistries } from "../state/registries-context";
import {
  createEmitter,
  scoped,
  useScoped,
  type EditorScope,
} from "../state/editor-scope";
import { useRegistryView } from "../state/live";
import { useEditorStorage, type StorageAdapter } from "../state/storage";
import { useOptionalPaged } from "../state/paged-editor";
import type { PagedEditor } from "../state/paged-editor";
import { isEnabled } from "../registries/types";
import { useOptionalWorkflowMode } from "../state/workflow-mode-context";
import { categoryLabel, PALETTE } from "./messages";

/**
 * The palette's open/toggle event, one per editor (plan task E1).
 * The listener is the mounted palette; emitters are registered commands
 * (`paged.palette.toggle`, …) and the keybinding registry that routes
 * Cmd+K through them, which reach it through their editor's scope
 * without crossing the React context boundary.
 */
type PaletteAction = "toggle" | "open" | "close";
const PALETTE_EVENT = scoped("palette", () => createEmitter<PaletteAction>());

/** Emit a palette action in `scope`'s editor. Idempotent. */
export function notifyPalette(scope: EditorScope, action: PaletteAction): void {
  scope.get(PALETTE_EVENT).emit(action);
}

/** Recently-run command ids, most recent first. */
const RECENTS_KEY = "paged.palette.recents.v1";
const RECENTS_MAX = 5;

function loadRecents(storage: StorageAdapter): string[] {
  try {
    const raw = storage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function pushRecent(storage: StorageAdapter, id: string): string[] {
  const next = [id, ...loadRecents(storage).filter((x) => x !== id)].slice(
    0,
    RECENTS_MAX,
  );
  try {
    storage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* convenience only */
  }
  return next;
}

/**
 * The kit's "looks like an AI prompt" heuristic: imperative
 * generate/fix verbs or a long natural-language query. The AI group
 * it surfaces is a STYLED SEAM — the entry is disabled until an
 * assistant backend exists; the affordance (wand, primary tint)
 * ships so the command bar's final shape is already real.
 */
function looksLikePrompt(query: string): boolean {
  if (query.trim().split(/\s+/).length > 3) return true;
  return /\b(make|generate|turn|prepare|create|shorten|fix|rewrite)\b/i.test(
    query,
  );
}

/**
 * Cmd+K-driven command bar. Reads from the active `CommandRegistry`
 * and invokes through the registry.
 *
 * CORRECTED 2026-08-07: this comment used to say that invoking through
 * the registry meant "visibility predicates apply uniformly". They did
 * not — `invoke` never read `when`, and this list was unfiltered, so
 * the palette offered every registered command in every context and ran
 * whatever was picked. The claim was plausible enough that nobody
 * checked, which is the more useful half of the lesson: a comment
 * asserting a guarantee is worth exactly as much as the test pinning
 * it. The gate now exists in `CommandRegistry.invoke`; the filtering
 * below is noise reduction on top of it, not the safety.
 *
 * Cockpit additions: a Recent group (localStorage), a "Suggested in
 * <Mode>" group from the active ModeContribution, and the AI-prompt
 * affordance.
 */
/** The commands the palette offers: those whose `when` applies where the
 *  user is. Evaluated while the palette is open, so each opening reads the
 *  editor state of that moment; a closed palette offers nothing. */
function applicableCommands(
  commands: CommandRegistry,
  paged: PagedEditor | null,
  open: boolean,
): CommandContribution[] {
  if (!open) return [];
  // A command the editor does not offer (a feature, docs/composable-editor.md
  // §6) is not in the palette at all.
  return commands
    .list()
    .filter(
      (c) =>
        commands.offered?.(c.id) !== false && isEnabled(c.when, () => paged),
    );
}

export function CommandPalette() {
  const strings = useStrings();
  const paged = useOptionalPaged();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const registries = useRegistries();
  // Read during render through views (state/live.ts, ADR 229): the
  // registries keep their identity while bundles register into them, so a
  // value computed from the registry itself would be kept for good.
  const commands = useRegistryView(registries.commands);
  const keybindings = useRegistryView(registries.keybindings);
  const modes = useRegistryView(registries.modes);

  // E3 — command id -> the key that runs it. `KeybindingRegistry.list()`
  // is the same source `Help > Keyboard shortcuts` renders, so the two
  // cannot drift into disagreeing about what a key does. First binding
  // wins: cmd+ and ctrl+ are registered as SEPARATE contributions for
  // one command, and showing both would double the width of every row.
  // Built from the keybinding VIEW. A value keyed on the registry object
  // is built once at first render, before any plugin has registered a
  // binding, and never recomputes: that is exactly what happened once,
  // 82 bindings live and 0 accelerators drawn. The view is a new object
  // after every registration.
  //
  // The chord for THIS platform, spelled as the menus spell it (one
  // formatter, MenuBar's `acceleratorLookup`).
  const keyFor = acceleratorLookup(keybindings.list());
  const workflowMode = useOptionalWorkflowMode();
  const storage = useEditorStorage();
  const [recents, setRecents] = useState<string[]>(() => loadRecents(storage));

  const palette = useScoped(PALETTE_EVENT);
  useEffect(
    () =>
      palette.subscribe((action) => {
        if (action === "toggle") {
          setOpen((v) => !v);
        } else if (action === "open") {
          setOpen(true);
        } else {
          setOpen(false);
        }
      }),
    [palette],
  );

  // Fresh query each open so the zero-state groups show.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // ADR 024 — HIDDEN, not greyed, and that differs from the menu on
  // purpose. A menu has stable positions a user learns, so an
  // inapplicable item greys in place; a palette is a SEARCH surface
  // with no positions to preserve, and a dead hit is just a wrong
  // answer to a query. `paged` supplies both the predicate's state and
  // the re-render, since the handle is memoized on the active context.
  const all = applicableCommands(commands, paged, open);
  const byId = new Map(all.map((c) => [c.id, c] as const));
  const grouped = groupByCategory(all);

  const run = (cmd: CommandContribution) => {
    setOpen(false);
    setRecents(pushRecent(storage, cmd.id));
    void registries.commands.invoke(cmd.id);
  };

  const recentItems = recents
    .map((id) => byId.get(id))
    .filter((c): c is CommandContribution => Boolean(c));

  const mode = workflowMode?.mode;
  const suggested =
    (mode ? modes.get(mode)?.paletteSuggestions : undefined)
      ?.map((id) => byId.get(id))
      .filter((c): c is CommandContribution => Boolean(c)) ?? [];
  const modeTitle = mode ? modes.get(mode)?.title : undefined;

  const showAiSeam = query.length > 0 && looksLikePrompt(query);
  // F-25 (ADR 252): with no AI service the ask row says so before it is
  // chosen, instead of failing after.
  const aiAvailability = useAiAvailability();
  const aiUnavailable = aiAvailability === "unavailable";

  // Zero state stays curated (kit): the per-panel Show/Hide pairs
  // (~100 ids) only surface once the user types.
  const visibleGroups =
    query.length > 0
      ? grouped
      : grouped
          .map(
            ([category, items]) =>
              [
                category,
                items.filter(
                  (c) =>
                    !c.id.startsWith("paged.panel.show.") &&
                    !c.id.startsWith("paged.panel.hide."),
                ),
              ] as [string, CommandContribution[]],
          )
          .filter(([, items]) => items.length > 0);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      // Kit command-bar.jsx: 660px, parked high (11vh) like a
      // launcher, not centred like a modal form.
      contentClassName="max-w-[660px] top-[11vh] translate-y-0"
      filter={paletteScore}
    >
      <CommandInput
        placeholder={strings.t(PALETTE.placeholder)}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {/* The ask row answers any prompt, so a prompt is never "no results". */}
        {!showAiSeam && (
          <CommandEmpty>{strings.t(PALETTE.noResults)}</CommandEmpty>
        )}

        {showAiSeam && (
          <>
            {/* forceMount on the group too: cmdk does not register a
                force-mounted item for filtering, so a group of only that
                item never counts as matched and is hidden. */}
            <CommandGroup heading={strings.t(PALETTE.assistant)} forceMount>
              <CommandItem
                value={`assistant ${query}`}
                // The assistant answers any query; ranking must not hide it.
                forceMount
                disabled={aiUnavailable}
                onSelect={() => {
                  if (aiUnavailable) return;
                  setOpen(false);
                  void registries.commands.invoke(AI_ASK_COMMAND, query);
                }}
                data-palette-ai
                data-ai-availability={aiAvailability}
              >
                <Icon
                  name="ui-wand"
                  size={15}
                  style={{ color: "var(--pg-primary)", marginRight: 8 }}
                />
                <span>{strings.t(PALETTE.askClaude, { query })}</span>
                <span className="ml-auto">
                  {aiUnavailable ? (
                    <span
                      className="text-xs opacity-60"
                      data-palette-ai-unavailable
                    >
                      {aiUnavailableText()}
                    </span>
                  ) : (
                    <PoweredByClaude size={9} />
                  )}
                </span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {query.length === 0 && recentItems.length > 0 && (
          <>
            <CommandGroup heading={strings.t(PALETTE.recent)}>
              {recentItems.map((cmd) => (
                <CommandItem
                  key={`recent-${cmd.id}`}
                  value={`recent ${cmd.title} ${cmd.id}`}
                  data-palette-recent={cmd.id}
                  onSelect={() => run(cmd)}
                >
                  <Icon
                    name="ui-history"
                    size={14}
                    style={{ color: "var(--pg-muted-fg)", marginRight: 8 }}
                  />
                  <span>{cmd.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {query.length === 0 && suggested.length > 0 && (
          <>
            <CommandGroup
              heading={
                modeTitle
                  ? strings.t(PALETTE.suggestedIn, { mode: modeTitle })
                  : strings.t(PALETTE.suggestedHere)
              }
            >
              {suggested.map((cmd) => (
                <CommandItem
                  key={`suggested-${cmd.id}`}
                  value={`suggested ${cmd.title} ${cmd.id}`}
                  data-palette-suggested={cmd.id}
                  onSelect={() => run(cmd)}
                >
                  <span>{cmd.title}</span>
                  {/* E3 — the SHORTCUT, not the command id. A designer
                      searching the palette was shown
                      `media.paged.data.command.lowerBinding` where every
                      other application puts the key, so the palette
                      taught nobody a single accelerator. A command with
                      no binding shows nothing there (F-16). */}
                  <PaletteChord chord={keyFor(cmd.id)} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {visibleGroups.map(([category, items], idx) => (
          <div key={category}>
            {idx > 0 && <CommandSeparator />}
            <CommandGroup heading={categoryLabel(strings, category)}>
              {items.map((cmd) => (
                <CommandItem
                  key={cmd.id}
                  // Ranked by `paletteScore`: the id is the value (unique),
                  // the title and category the words a person searches
                  // (the category in English and in the editor's language).
                  value={cmd.id}
                  keywords={[
                    cmd.title,
                    category,
                    categoryLabel(strings, category),
                  ]}
                  onSelect={() => run(cmd)}
                >
                  <span>{cmd.title}</span>
                  {/* The chord, not the id (UX audit F-16). */}
                  <PaletteChord chord={keyFor(cmd.id)} />
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
      {/* Kit footer: run / navigate / the AI affordance. */}
      <div
        data-palette-footer
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          height: 34,
          padding: "0 14px",
          borderTop: "1px solid var(--pg-border)",
          background: "var(--chrome-panel-bg)",
          color: "var(--pg-muted-fg)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
        }}
      >
        <span>
          <kbd style={kbdStyle}>↵</kbd> {strings.t(PALETTE.run)}
        </span>
        <span>
          <kbd style={kbdStyle}>↑↓</kbd> {strings.t(PALETTE.navigate)}
        </span>
        {/* E8 — the footer once claimed "AI-assisted" beside a
              disabled assistant row. The row is live now (ADR 221), so
              the attribution is true and sits where the claim was. */}
        {!aiUnavailable && (
          <span style={{ marginLeft: "auto" }}>
            <PoweredByClaude size={9} />
          </span>
        )}
      </div>
    </CommandDialog>
  );
}

/** The right-hand column of a palette row: the command's chord, or
 *  nothing. */
function PaletteChord({ chord }: { chord: string | null }) {
  if (!chord) return null;
  return (
    <span className="ml-auto text-xs opacity-50" data-palette-chord>
      {chord}
    </span>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  border: "1px solid var(--pg-border)",
  borderRadius: "var(--radius-sm)",
  padding: "1px 5px",
  marginRight: 4,
  background: "var(--pg-bg)",
};

function groupByCategory(
  items: CommandContribution[],
): Array<[string, CommandContribution[]]> {
  const groups = new Map<string, CommandContribution[]>();
  for (const cmd of items) {
    const category = cmd.category ?? "Other";
    const bucket = groups.get(category);
    if (bucket) {
      bucket.push(cmd);
    } else {
      groups.set(category, [cmd]);
    }
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}
