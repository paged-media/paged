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

import type { EscapeHandler } from "../interaction/escape-arbiter";
import type { FeatureStore } from "../state/features";
import type * as Api from "@paged-media/plugin-api";

import {
  MENU_KEYS,
  PAGE_KEYS,
  WIDGET_KEYS,
  canvasSurfaceOf,
  compositeOwnsKey,
  insideFrameSurface,
  insideKeyOwningContainer,
  isActivatable,
  isCanvasSurface,
  isComposingKey,
} from "../focus/key-ownership";
import type { CommandRegistry } from "./command";
import { activeScopeContext } from "./context-bar";
import { isEnabled } from "./types";
import type { Disposable, Registrable } from "./types";

/**
 * Declarative keybinding manifest. `key` uses the modifier-prefixed
 * dotted form: `"cmd+k"`, `"shift+escape"`, `"cmd+shift+p"`.
 * Recognised modifiers: `cmd` / `meta`, `ctrl` / `control`, `alt` /
 * `option`, `shift`. `cmd` aliases `meta` so the same contribution
 * works on macOS + Linux/Windows (with `cmd` resolving to the Cmd
 * key on macOS and the Ctrl key elsewhere — but we keep them as
 * separate flags here and let consumers register both forms if
 * they want OS-specific behaviour).
 *
 * Step 4 wires this up as a real listener; the existing
 * `useKeyboardShortcuts` hook stays as the canvas-app navigation
 * provider until that migration is done in its own slice.
 *
 * The contract's `KeybindingContribution` (key, command, when — one
 * definition, `@paged-media/plugin-api`) plus the shell's `precedence`.
 */
export interface KeybindingContribution extends Api.KeybindingContribution {
  /**
   * Rank among the ENABLED bindings on the same key, read with the same
   * state `when` is. Absent: 1 for a guarded binding, 0 for an
   * unguarded one (the rule `resolveBinding` documents). A tool's
   * shortcut uses it to outrank a host binding on its key inside the
   * edit context that claims the tool, and to yield everywhere else.
   */
  precedence?: (state: unknown) => number;
}

/** A contract-authored keybinding registers here unchanged. */
export type _KeybindingRegistrable = Registrable<
  KeybindingContribution,
  Api.KeybindingContribution
>;

export interface KeybindingRegistry extends Api.KeybindingRegistry {
  register(contribution: KeybindingContribution): Disposable;
  /** Listing for diagnostics + the future "Show keybindings" panel. */
  list(): KeybindingContribution[];
  /** (Re-)install the global keydown listener. Idempotent — the
   * provider calls this from a mount effect so StrictMode's
   * mount→unmount→mount cycle re-attaches what `detach` removed
   * (the registry instance itself survives in a ref). */
  attach(): void;
  /** Remove the global keydown listener, keeping the bindings. */
  detach(): void;
  /** The binding a key press would fire — with the live state, or with
   *  `state` when given (diagnostics, the registry invariants). */
  resolve(event: KeyEventLike, state?: unknown): KeybindingContribution | null;
  /** Called after a binding is registered or removed (ADR 229: render-time
   *  readers go through `useRegistryView`). */
  onChange(handler: () => void): Disposable;
  /** Editor ADR 299 — does a SCOPED binding of the active edit context
   *  take this key press? The text input (`useTextEditing`) and the other
   *  canvas key handlers ask before they act, and leave the key to the
   *  registry when it does. */
  claims(event: KeyEventLike & Partial<Pick<KeyboardEvent, "target">>): boolean;
}

/**
 * Editor ADR 299 — the rank of a scoped binding while its context is
 * active: above every host binding (guarded 1, unguarded 0, a tool's
 * `precedence`), so inside a Word document Cmd+E is centre, not the host's
 * chord on the key.
 */
export const SCOPED_BINDING_RANK = 100;

/** Editor ADR 299 — the host keys no scoped binding may take (the
 *  contract's reserved set, extensions ADR 348): save, print, the chrome
 *  toggle, the command palette. */
const RESERVED_COMBOS: readonly string[] = [
  "cmd+s",
  "cmd+p",
  "cmd+\\",
  "cmd+shift+p",
];

function sameCombo(a: KeyCombo, b: KeyCombo): boolean {
  return (
    a.key === b.key &&
    (a.cmd || a.ctrl) === (b.cmd || b.ctrl) &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

/** Is `key` one of the reserved host combos? */
export function isReservedCombo(key: string): boolean {
  const combo = parseCombo(key);
  return RESERVED_COMBOS.some((r) => sameCombo(parseCombo(r), combo));
}

/** Internal: parsed key combo + the command to invoke. */
interface ParsedBinding {
  contribution: KeybindingContribution;
  combo: KeyCombo;
}

interface KeyCombo {
  /** Lowercased single key (e.g. "k", "escape", "arrowleft"). */
  key: string;
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Parse `"cmd+shift+k"` into a normalised `KeyCombo`. Throws on
 * malformed input — bundles are expected to use static strings so
 * a typo surfaces loudly rather than as a silently-broken
 * shortcut.
 */
function parseCombo(key: string): KeyCombo {
  const raw = key.trim().toLowerCase();
  // The plus key: `plus` (the form to register, since the menus split a
  // combo at its `+`), or a literal `+` in the key's place (`cmd++`, `+`).
  const literalPlus = raw === "+" || raw.endsWith("++");
  const parts = literalPlus
    ? [...(raw === "+" ? [] : raw.slice(0, -2).split("+")), "plus"]
    : raw.split("+");
  if (parts.length === 0 || parts.some((p) => !p)) {
    throw new Error(`KeybindingRegistry: malformed key "${key}"`);
  }
  // `space` names the space bar (a `" "` key cannot be written in a combo:
  // the string is trimmed). Editor ADR 299: Word's Cmd+Space.
  const named = parts[parts.length - 1];
  const last = named === "space" ? " " : named === "plus" ? "+" : named;
  const mods = parts.slice(0, -1);
  const combo: KeyCombo = {
    key: last,
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false,
  };
  for (const m of mods) {
    switch (m) {
      case "cmd":
      case "meta":
        combo.cmd = true;
        break;
      case "ctrl":
      case "control":
        combo.ctrl = true;
        break;
      case "alt":
      case "option":
        combo.alt = true;
        break;
      case "shift":
        combo.shift = true;
        break;
      default:
        throw new Error(
          `KeybindingRegistry: unknown modifier "${m}" in "${key}"`,
        );
    }
  }
  return combo;
}

export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> &
  Partial<Pick<KeyboardEvent, "code">>;

// ── Which key a press names ────────────────────────────────────────
//
// A binding names a key by its character: `cmd+z`, `cmd+=`, `cmd+[`. A
// press reports the character it types (`key`) and the physical key
// (`code`, named after the US layout). The two disagree off a US keyboard:
// a German one types "z" on the key the US layout calls KeyY and has no
// unshifted "=", "[" or "]"; a French one types "&" on Digit1 and "a" on
// KeyQ; and Option on a Mac, or Shift on a digit, changes the character on
// every layout. The rule, in the order it is tried (the first step in
// which the press names a registered binding decides; later steps are not
// consulted, so a press never falls through to another binding once the
// typed character names one):
//
//   1. TYPED. The character the press types, with the modifiers exact.
//      Letters always resolve here when the press types a letter, so Z
//      and Y, A and Q, W and Z follow the layout.
//   2. THE LAYOUT'S KEY. The character the physical key types unmodified
//      on the user's layout, when known (`KeyboardLayout`): Option+Shift+V
//      types "◊" on the V key, Shift+1 types "!" on the 1 key.
//   3. THE US POSITION. The character the physical key has on a US
//      keyboard: digits and punctuation always (Cmd+1 on the "&" key of a
//      French keyboard, Cmd+[ on the "ü" key of a German one); a LETTER
//      only when the press types none and the layout's own letter is not
//      known or not Latin (a Cyrillic layout, or Option before the layout
//      is known). A key whose layout character is known is never read as
//      another Latin letter.
//   4. TYPED, SHIFT ASIDE. A symbol the layout needs Shift for ("+" on a
//      US or French keyboard) names a binding without Shift on that
//      symbol (`cmd+plus`), after everything above.

/** The character of the punctuation keys on a US keyboard, by `code`. */
const US_PUNCTUATION: Readonly<Record<string, string>> = {
  equal: "=",
  minus: "-",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  comma: ",",
  period: ".",
  slash: "/",
  backquote: "`",
};

/** The unshifted character of a physical key on a US keyboard. */
function usPosition(code: string): string | null {
  const c = code.toLowerCase();
  if (/^key[a-z]$/.test(c)) return c.slice(3);
  if (/^digit[0-9]$/.test(c)) return c.slice(5);
  return US_PUNCTUATION[c] ?? null;
}

const isAsciiLetter = (s: string) => /^[a-z]$/.test(s);
/** One printable ASCII character: something a Latin layout types. */
const isAsciiChar = (s: string) => s.length === 1 && s >= "!" && s <= "~";
const isSymbol = (s: string) => isAsciiChar(s) && !/^[a-z0-9]$/.test(s);

/** What is known of the user's keyboard layout: the character each
 *  physical key types unmodified. */
export interface KeyboardLayout {
  /** The lowercased character of `code`, or null when not known. */
  base(code: string): string | null;
}

/** A layout that is learned: from the browser's layout map where it has
 *  one, and from the presses seen (a press without Alt types the key's own
 *  character). */
export interface KeyboardLayoutMemory extends KeyboardLayout {
  learn(event: KeyEventLike): void;
  /** Take a `code → character` map (the Keyboard API's layout map). */
  adopt(map: Iterable<readonly [string, string]>): void;
}

export function createKeyboardLayout(
  initial: Iterable<readonly [string, string]> = [],
): KeyboardLayoutMemory {
  const keys = new Map<string, string>();
  const layout: KeyboardLayoutMemory = {
    base: (code) => keys.get(code.toLowerCase()) ?? null,
    learn(event) {
      if (!event.code || event.altKey || event.key.length !== 1) return;
      const lower = event.key.toLowerCase();
      // With Shift only a letter says what the key is ("!" does not say 1).
      if (event.shiftKey && lower === event.key.toUpperCase()) return;
      keys.set(event.code.toLowerCase(), lower);
    },
    adopt(map) {
      for (const [code, key] of map)
        if (key.length === 1) keys.set(code.toLowerCase(), key.toLowerCase());
    },
  };
  layout.adopt(initial);
  return layout;
}

/** How a press names a combo's key: 0 not at all, else the step of the
 *  rule above (1 typed … 4 typed with Shift aside). Modifiers are exact. */
function matchStep(
  combo: KeyCombo,
  event: KeyEventLike,
  layout?: KeyboardLayout,
): 0 | 1 | 2 | 3 | 4 {
  if (combo.cmd !== event.metaKey) return 0;
  if (combo.ctrl !== event.ctrlKey) return 0;
  if (combo.alt !== event.altKey) return 0;
  const typed = event.key.toLowerCase();
  const us = event.code ? usPosition(event.code) : null;
  if (combo.shift !== event.shiftKey) {
    // Step 4: Shift was what it took to type the symbol.
    return !combo.shift &&
      typed === combo.key &&
      isSymbol(typed) &&
      us !== null &&
      us !== typed
      ? 4
      : 0;
  }
  if (typed === combo.key) return 1;
  if (!event.code) return 0;
  const base = layout?.base(event.code) ?? null;
  if (base !== null && base !== typed && base === combo.key) return 2;
  if (us === null || us !== combo.key || us === base) return 0;
  if (!isAsciiLetter(us)) return 3;
  // A letter by position: only when neither the press nor the layout says
  // which Latin character the key is.
  const unknownLetter =
    base !== null ? !isAsciiChar(base) : event.altKey || !isAsciiChar(typed);
  return unknownLetter ? 3 : 0;
}

/**
 * The keys a focused WIDGET consumes itself, whatever modifiers ride
 * along: Backspace/Delete edit a field, the arrows move its caret (or
 * a menu's highlight, a slider's thumb, a tab strip's focus), Home/End
 * jump within it (`WIDGET_KEYS`, focus/key-ownership.ts).
 *
 * WHY THIS SET EXISTS. The guard below used to know one fact — "a pure
 * letter typed into a field is text, not a shortcut" — and that was
 * the whole of it, because every binding was either a letter or a
 * Cmd/Ctrl chord. The first bindings on Backspace and the arrow keys
 * (`paged.object.delete` / `.nudge*`) would have walked straight
 * through it: Backspace in the Transform panel's X field deleting the
 * selected frame, and the arrow keys walking the Object menu nudging
 * the selection one point per row. A `when` predicate cannot fix that
 * — it is handed application STATE, not the event — so the fact
 * belongs here, once, for every binding on these keys that ever
 * registers.
 *
 * Tab is the focused control's too (F-49, ADR 234): it moves focus
 * everywhere but on a canvas surface, so the chrome toggle bound to it
 * fires only from the canvas. Enter, Escape and the function keys still
 * reach bindings from a field.
 */

/**
 * ARIA composites that own the arrow keys (and, for a tree or a
 * listbox, Delete) while focus is inside them. `toolbar` is absent on
 * purpose: a toolbar is a roving-tabindex group (focus/roving-focus.ts)
 * that prevents the default of every arrow it moves with, which the
 * `defaultPrevented` rule below already honours; a click on a rail tool
 * hands focus back to the canvas, so the next arrow nudges.
 */
const WIDGET_KEY_OWNERS = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="tablist"]',
  '[role="radiogroup"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="dialog"]',
].join(",");

/**
 * Does the element the key was pressed in consume this key itself?
 * True ⇒ no binding may fire; the event is the widget's.
 *
 * Reads only `key`, the modifier flags, the composition flags and
 * `target`, so the rule is testable in Node with a plain object (it is
 * exported for exactly that). The canvas's own key handlers ask the
 * sibling question, `canvasKeyYields` (focus/key-ownership.ts).
 */
export function targetOwnsKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "defaultPrevented"
  > &
    Partial<Pick<KeyboardEvent, "isComposing" | "keyCode">>,
): boolean {
  // A key that belongs to an input method composition (F-36): the IME's,
  // never a shortcut — the "v" of a romaji composition is not the
  // Selection tool.
  if (isComposingKey(event)) return true;
  const key = event.key.toLowerCase();
  const isWidgetKey = WIDGET_KEYS.has(key);
  // Something upstream already took this key. React's handlers run at
  // the root container, before this window listener, so a widget with
  // no telltale role still gets to say "mine" the ordinary way: a
  // focused menu TRIGGER opens on ArrowDown and prevents the default,
  // and must not nudge the selection as it does. Scoped to the widget
  // keys — applying it to every binding would change what happens to
  // chords other hooks already `preventDefault` today.
  if (isWidgetKey && event.defaultPrevented) return true;
  // The same for the menu keys: a focused rail tool opens its flyout on
  // Shift+F10 and prevents the default, so the canvas context menu bound
  // to that key does not open over the flyout and take its focus.
  if (MENU_KEYS.has(key) && event.defaultPrevented) return true;
  const target = event.target as HTMLElement | null;
  if (!target || !target.tagName) return false;
  const chord = event.metaKey || event.ctrlKey;
  // A plugin's frame surface (extensions ADR 334) says "mine" by preventing
  // the default of the keys it handles — Cmd+C/V included, which would
  // otherwise run the plugin's own keybinding a second time. A key it lets
  // through (Cmd+S, Cmd+K) still reaches the bindings.
  if (event.defaultPrevented && insideFrameSurface(target)) return true;
  // Tab moves focus (F-49): from a field, a button, a dialog, the page.
  // Only the canvas's own surfaces hand it to a binding.
  if (key === "tab") return !isCanvasSurface(target);
  // A dialog or an open menu owns every key but a Cmd/Ctrl chord: its
  // typeahead letters, Enter, Space, Escape (R9).
  if (!chord && insideKeyOwningContainer(target)) return true;
  // Enter and Space activate the focused button, link or checkbox.
  if (!chord && (key === "enter" || key === " ") && isActivatable(target)) {
    return true;
  }
  const tag = target.tagName;
  const isEditable =
    tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  // The page keys scroll a field, a list, a tree, a select: never the
  // document's pages while focus is there (UXI-T76).
  const isPageKey = PAGE_KEYS.has(key) && !chord;
  if (isEditable) {
    // The canvas's own text input leaves the Alt arrows to the text verbs
    // (leading and tracking, UX audit F-34): it is the story, not a field.
    if (
      event.altKey &&
      !chord &&
      key.startsWith("arrow") &&
      canvasSurfaceOf(target) === "text"
    )
      return false;
    // Cmd-K + similar modifier combos still apply inside inputs so the
    // palette opens regardless; pure-letter keys are suppressed. The
    // widget keys are suppressed WITH their modifiers — Cmd+Left is
    // "line start" in a field, Alt+Backspace is "delete word".
    const isPureLetter =
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.length === 1;
    return isPureLetter || isWidgetKey || isPageKey;
  }
  // A <select> walks its options with the arrows and the page keys, opens
  // on Enter and Space, and jumps to an option by its first letters
  // (UXI-T76: a long select in a panel types ahead; the letter is not also
  // the Selection tool).
  if (tag === "SELECT") {
    const typeahead = event.key.length === 1 && !chord && !event.altKey;
    const opens = !chord && key === "enter";
    if (isWidgetKey || isPageKey || typeahead || opens) return true;
  }
  // An ARIA composite (a list, a tree, a grid, a slider…) owns its moving
  // keys with their modifiers, and with none its page keys, Enter and
  // Space, and — a listbox, a combobox — its typeahead letters
  // (UXI-KEY-003): a plugin panel's long list keeps its keys, and no tool
  // shortcut or page turn fires behind it.
  return compositeOwnsKey(event, target, WIDGET_KEY_OWNERS);
}

/**
 * Which binding a key press fires. A disabled binding yields to any
 * other binding on the same combo. Among the enabled ones, a GUARDED
 * binding (a `when` that holds right now) beats an unguarded one, and
 * registration order breaks ties within each class. A binding that
 * declares `precedence` ranks by it instead (guarded = 1, unguarded =
 * 0 on the same scale).
 *
 * Why precedence exists: registration order is HISTORY, not intent. The
 * fill/stroke cluster's `j` (registered at shell mount, re-registered
 * whenever the rail remounts) and paged.image's healing brush `j` are
 * both guarded, so inside a raster frame the toggle won for as long as
 * the cluster happened to register first.
 *
 * Why guarded first: an unguarded binding is global by declaration,
 * while a guard narrows its binding to a situation — and when that
 * situation holds, the narrower claim is the one the user is in. The
 * case that forced it: Place (Cmd+D, unguarded, a built-in registered
 * first) shadowed a sheet's Fill down (Cmd+D, guarded to "a sheet frame
 * is entered") for as long as both existed, so a context's keybinding
 * could never win inside its own context.
 *
 * `resolveBinding` is the testable form (no window needed).
 */
function resolveParsed(
  bindings: readonly ParsedBinding[],
  event: KeyEventLike,
  getState?: () => unknown,
  offered?: (binding: KeybindingContribution) => boolean,
  layout?: KeyboardLayout,
): KeybindingContribution | null {
  // The bindings the press names, each with the step it names it by. A
  // binding the editor does not offer is not a candidate, so the key stays
  // the page's (docs/composable-editor.md §6); a scoped binding exists
  // only while its context is the active one (editor ADR 299).
  const named: { binding: ParsedBinding; step: number }[] = [];
  let first = Infinity;
  for (const b of bindings) {
    const step = matchStep(b.combo, event, layout);
    if (step === 0) continue;
    if (offered && !offered(b.contribution)) continue;
    const { scope } = b.contribution;
    if (scope && activeScopeContext(getState?.()) !== scope.editContext)
      continue;
    named.push({ binding: b, step });
    if (step < first) first = step;
  }
  let best: KeybindingContribution | null = null;
  let bestRank = -Infinity;
  for (const { binding: b, step } of named) {
    // Only the first step that names a binding: a disabled binding on the
    // typed character does not hand the press to another key's binding.
    if (step !== first) continue;
    const { when, precedence, scope } = b.contribution;
    if (!isEnabled(when, getState)) continue;
    let rank = when !== undefined ? 1 : 0;
    // Inside its context a scoped binding outranks every host binding.
    if (scope) {
      rank = SCOPED_BINDING_RANK;
    } else if (precedence) {
      try {
        rank = precedence(getState?.());
      } catch {
        // A throwing rank keeps its class's default.
      }
    }
    // Strictly greater: the first registration wins a tie.
    if (rank > bestRank) {
      best = b.contribution;
      bestRank = rank;
    }
  }
  return best;
}

/** The binding a key press would fire among `contributions` (in
 *  registration order) — the dispatch rule above, without a window. */
export function resolveBinding(
  contributions: readonly KeybindingContribution[],
  event: KeyEventLike,
  getState?: () => unknown,
  layout?: KeyboardLayout,
): KeybindingContribution | null {
  return resolveParsed(
    contributions.map((contribution) => ({
      contribution,
      combo: parseCombo(contribution.key),
    })),
    event,
    getState,
    undefined,
    layout,
  );
}

/** Evaluate a keybinding's `when` predicate. Undefined → enabled. The
 *  function form is called with the state snapshot; the string DSL
 *  form is inert (treated as disabled) until an evaluator lands —
 *  matching `VisibilityPredicate`'s documented contract. */
/**
 * Backing for `register` / dispatch. Takes the command registry so
 * matched keybindings can invoke their target command; the optional
 * `getState` thunk supplies an application-state snapshot for `when`
 * predicate evaluation (Concept 1's tool shortcuts use this for the
 * class-wide `contentSelection == null` text-suppression guard).
 */
export function createKeybindingRegistry(
  commands: CommandRegistry,
  getState?: () => unknown,
  features?: Pick<FeatureStore, "allows">,
  /** Whether a key event is this editor's (plan task E1: the editor's
   *  root, `state/editor-root.tsx`). Absent: every key on the page. */
  owns?: (event: KeyboardEvent) => boolean,
): KeybindingRegistry & Disposable {
  const offered = (b: KeybindingContribution) =>
    commands.offered?.(b.command) !== false &&
    (features?.allows("keybinding", `${b.key}→${b.command}`) ?? true);
  const bindings: ParsedBinding[] = [];
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const fn of [...changeListeners]) fn();
  };

  // The user's layout: the browser's map where it has one (Chromium's
  // Keyboard API), and what the presses say everywhere.
  const layout = createKeyboardLayout();
  const readLayoutMap = () => {
    const keyboard = (
      globalThis.navigator as unknown as
        | {
            keyboard?: {
              getLayoutMap?(): Promise<Iterable<readonly [string, string]>>;
            };
          }
        | undefined
    )?.keyboard;
    if (typeof keyboard?.getLayoutMap !== "function") return;
    try {
      void keyboard.getLayoutMap().then(
        (map) => layout.adopt(map),
        () => undefined,
      );
    } catch {
      /* not allowed here (a frame without the permission) */
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    layout.learn(event);
    if (owns && !owns(event)) return;
    // Skip when the focused widget consumes this key itself, so typing
    // (and editing, and menu navigation) doesn't trigger commands. The
    // canvas's content-selection model lives on its own layer and isn't
    // an editable element — bindings guard that through `when`. The one
    // exception is the canvas's own text input (editor ADR 299): a scoped
    // binding of the active context takes its keys first, Tab and the
    // arrows included, because inside a Word document they are Word's.
    if (targetOwnsKey(event) && !scopedClaim(event)) return;
    const winner = resolveParsed(bindings, event, getState, offered, layout);
    if (!winner) return;
    event.preventDefault();
    void commands.invoke(winner.command);
  };

  /** A scoped binding wins this key press, and the key arrived on a
   *  surface that yields to one (the canvas text input, the canvas, the
   *  page) — never mid-composition, never in a panel's field. */
  const scopedClaim = (
    event: KeyEventLike & Partial<Pick<KeyboardEvent, "target">>,
  ): boolean => {
    const e = event as Partial<KeyboardEvent> & KeyEventLike;
    if (e.isComposing === true || e.keyCode === 229 || e.key === "Process")
      return false;
    const target = e.target as HTMLElement | null | undefined;
    if (
      target &&
      target.tagName &&
      canvasSurfaceOf(target) === null &&
      target.tagName !== "BODY" &&
      target.tagName !== "HTML"
    ) {
      return false;
    }
    const winner = resolveParsed(bindings, event, getState, offered, layout);
    return winner?.scope !== undefined;
  };

  let listening = false;
  const attach = () => {
    if (listening) return;
    window.addEventListener("keydown", onKeyDown);
    listening = true;
    readLayoutMap();
  };
  const detach = () => {
    if (!listening) return;
    window.removeEventListener("keydown", onKeyDown);
    listening = false;
  };
  attach();

  return {
    register(contribution) {
      const combo = parseCombo(contribution.key);
      if (contribution.scope && isReservedCombo(contribution.key)) {
        throw new Error(
          `KeybindingRegistry: "${contribution.key}" is reserved by the host; ` +
            `a scoped binding may not take it`,
        );
      }
      const entry: ParsedBinding = { contribution, combo };
      bindings.push(entry);
      changed();
      return {
        dispose() {
          const idx = bindings.indexOf(entry);
          if (idx >= 0) {
            bindings.splice(idx, 1);
            changed();
          }
        },
      };
    },
    list() {
      return bindings.map((b) => b.contribution);
    },
    attach,
    detach,
    resolve(event, state) {
      return resolveParsed(
        bindings,
        event,
        state === undefined ? getState : () => state,
        offered,
        layout,
      );
    },
    claims(event) {
      return scopedClaim(event);
    },
    onChange(handler) {
      changeListeners.add(handler);
      return {
        dispose() {
          changeListeners.delete(handler);
        },
      };
    },
    dispose() {
      detach();
      const had = bindings.length > 0;
      bindings.length = 0;
      if (had) changed();
    },
  };
}

/**
 * The keybindings' Escape (editor ADR 1207, amendment 2026-11-15). The
 * arbiter is the one listener that answers Escape, in the capture phase:
 * when one of its handlers resolves a press, the registry's window listener
 * never hears it. A module's binding on Escape ran only while no tier had
 * anything to do, so with a shape selected Escape cleared the selection and
 * left the Format Painter's brush loaded.
 *
 * A GUARDED binding on Escape (a `when` that holds now, or a binding scoped
 * to the active context) is a module's transient mode, §12.1 case 4: it
 * answers in the `transient` tier, after the open layers, a gesture and the
 * focused control, before a held pointer, a context, the text, a group and
 * the selection. Its command runs once, from here, and the press is handled.
 * An unguarded binding on Escape stays behind the arbiter, as before.
 */
export function keybindingEscapeHandler(
  keybindings: Pick<KeybindingRegistry, "resolve" | "claims">,
  commands: Pick<CommandRegistry, "invoke">,
): EscapeHandler {
  const guarded = (event: KeyboardEvent): KeybindingContribution | null => {
    // The registry's own rule: the focused widget's key is the widget's.
    if (targetOwnsKey(event) && !keybindings.claims(event)) return null;
    const winner = keybindings.resolve(event);
    if (!winner) return null;
    return winner.when !== undefined || winner.scope !== undefined
      ? winner
      : null;
  };
  return {
    id: "paged.keybinding",
    tier: "transient",
    isActive: (event) => guarded(event) !== null,
    resolve: (event) => {
      const winner = guarded(event);
      if (winner) void commands.invoke(winner.command);
    },
  };
}
