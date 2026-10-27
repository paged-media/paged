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

// Editor ADR 303 — Find & Replace, the views: the Find & Replace dialog
// (modeless, like Word's and InDesign's Find/Change: the document stays
// editable behind it), the Go To dialog, and the Find results panel (the
// Navigation pane's Results tab: every hit with its context; a click takes
// the user to it and selects it). All three read and write the editor's
// one find store (find-state.ts), so a search typed in the panel is the
// dialog's search too.

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

import { changesTheDocument } from "@paged-media/client";
import {
  displayName,
  FocusScope,
  useCanvasClient,
  useCollection,
  useEditorScope,
  useDocument,
  useOptionalPaged,
  type EditorScope,
  type PagedEditor,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import { pageDoorsOf } from "../plugin-pages";
import {
  contextParts,
  pageIndexOf,
  SPECIALS,
  type CaretRange,
  type FindOptions,
} from "./find-model";
import {
  findNext,
  findStoreOf,
  goToHit,
  patchFind,
  replaceAll,
  replaceCurrent,
  runSearch,
  setFindOptions,
  type FindDeps,
  type FindState,
  type FindStatus,
} from "./find-state";

export const M = defineMessages("app.find", {
  dialogTitle: "Find and replace",
  find: "Find",
  replaceWith: "Replace with",
  matchCase: "Match case",
  wholeWord: "Whole words only",
  mode: "Search",
  literal: "Text",
  wildcards: "Use wildcards",
  regex: "Regular expression",
  storyOnly: "Current story only",
  findStyle: "Find style",
  replaceStyle: "Replace with style",
  paragraphStyle: "Paragraph style",
  characterStyle: "Character style",
  anyStyle: "Any",
  noStyle: "Keep",
  special: "Special",
  findNext: "Find next",
  findPrevious: "Find previous",
  replace: "Replace",
  replaceAll: "Replace all",
  close: "Close",
  found: "{index} of {count}",
  notFound: "Not found",
  replaced: "{count, plural, one {# replacement} other {# replacements}}",
  error: "Cannot search: {message}",
  paragraph: "Paragraph mark (^p)",
  tab: "Tab (^t)",
  lineBreak: "Line break (^l)",
  pageBreak: "Page break (^m)",
  anyCharacter: "Any character (^?)",
  anyDigit: "Any digit (^#)",
  anyLetter: "Any letter (^$)",
  foundText: "Found text (^&)",
  searchDocument: "Search document",
  results: "{count, plural, one {# result} other {# results}}",
  noResults: "No results",
  typeToSearch: "Type to search the document's text.",
  openReplace: "Replace…",
  goToTitle: "Go to page",
  pageNumber: "Page number",
  pageRange: "1–{count}",
  go: "Go to",
});

// ----------------------------------------------------------------- deps

/** The find actions' editor half, over a mounted editor. */
export function findDepsOf(paged: PagedEditor, scope: EditorScope): FindDeps {
  return {
    client: paged.client,
    selection: () => {
      const sel = paged.contentSelection.contentSelectionRef.current;
      return sel && !sel.cell ? sel : null;
    },
    async reveal(range: CaretRange) {
      const ok = await pageDoorsOf(scope).text.revealText(range, true);
      // No canvas (a panel test) or not laid out: select it anyway, so the
      // selection is where the find went.
      if (!ok) paged.contentSelection.setContentSelection({ ...range });
      return true;
    },
  };
}

function useFind(): {
  state: FindState;
  store: ReturnType<typeof findStoreOf>;
  deps: FindDeps | null;
  paged: PagedEditor | null;
  scope: EditorScope;
} {
  const scope = useEditorScope();
  const paged = useOptionalPaged();
  const store = findStoreOf(scope);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return {
    state,
    store,
    deps: paged ? findDepsOf(paged, scope) : null,
    paged,
    scope,
  };
}

function statusText(
  strings: ReturnType<typeof useStrings>,
  status: FindStatus | null,
): string {
  if (!status) return "";
  switch (status.kind) {
    case "found":
      return strings.t(M.found, {
        index: status.index + 1,
        count: status.count,
      });
    case "notFound":
      return strings.t(M.notFound);
    case "replaced":
      return strings.t(M.replaced, { count: status.count });
    case "error":
      return strings.t(M.error, { message: status.message });
  }
}

/** Stop the editor's keys from acting on a key typed into a field here
 *  (Esc still closes, Enter runs the field's action). */
function fieldKeys(
  e: ReactKeyboardEvent,
  onEnter: (shift: boolean) => void,
  onEscape: () => void,
): void {
  if (e.key === "Enter") {
    e.preventDefault();
    onEnter(e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    onEscape();
  }
  e.stopPropagation();
}

// --------------------------------------------------------------- dialog

/** The Find & Replace dialog, while the store says it is open. */
export function FindReplaceDialog() {
  const { state } = useFind();
  return state.dialog ? <FindReplaceForm /> : null;
}

type StyleRow = { selfId: string; name: string };

function FindReplaceForm() {
  const strings = useStrings();
  const { state, store, deps } = useFind();
  const o = state.options;
  const paragraphStyles = useCollection<StyleRow>("paragraphStyles") ?? [];
  const characterStyles = useCollection<StyleRow>("characterStyles") ?? [];
  const [field, setField] = useState<"find" | "replace">("find");
  const [busy, setBusy] = useState(false);
  const close = () => patchFind(store, { dialog: false });
  const set = (patch: Partial<FindOptions>) => setFindOptions(store, patch);
  const act = (run: (d: FindDeps) => Promise<unknown>) => {
    if (!deps || busy) return;
    setBusy(true);
    void run(deps).finally(() => setBusy(false));
  };
  const empty = o.find.length === 0;

  return (
    <div
      role="dialog"
      aria-labelledby="find-replace-title"
      data-find-dialog=""
      data-panel-host=""
      style={dialog}
    >
      <FocusScope autoFocus restoreFocus>
        <h2 id="find-replace-title" style={heading}>
          {strings.t(M.dialogTitle)}
        </h2>
        <label style={rowLabel}>
          <span style={labelText}>{strings.t(M.find)}</span>
          <input
            type="text"
            data-find-input="find"
            value={o.find}
            onFocus={() => setField("find")}
            onChange={(e) => set({ find: e.target.value })}
            onKeyDown={(e) =>
              fieldKeys(
                e,
                (shift) => act((d) => findNext(d, store, shift)),
                close,
              )
            }
            style={input}
          />
        </label>
        <label style={rowLabel}>
          <span style={labelText}>{strings.t(M.replaceWith)}</span>
          <input
            type="text"
            data-find-input="replace"
            value={o.replace}
            onFocus={() => setField("replace")}
            onChange={(e) => set({ replace: e.target.value })}
            onKeyDown={(e) =>
              fieldKeys(e, () => act((d) => replaceCurrent(d, store)), close)
            }
            style={input}
          />
        </label>
        <div style={optionsRow}>
          <Check
            id="matchCase"
            label={strings.t(M.matchCase)}
            on={o.matchCase}
            set={(v) => set({ matchCase: v })}
          />
          <Check
            id="wholeWord"
            label={strings.t(M.wholeWord)}
            on={o.wholeWord}
            set={(v) => set({ wholeWord: v })}
          />
          <Check
            id="storyOnly"
            label={strings.t(M.storyOnly)}
            on={o.storyOnly}
            set={(v) => set({ storyOnly: v })}
          />
        </div>
        <div style={optionsRow}>
          <label style={inline}>
            <span style={labelText}>{strings.t(M.mode)}</span>
            <select
              data-find-mode=""
              value={o.mode}
              onChange={(e) =>
                set({ mode: e.target.value as FindOptions["mode"] })
              }
              style={select}
            >
              <option value="literal">{strings.t(M.literal)}</option>
              <option value="wildcards">{strings.t(M.wildcards)}</option>
              <option value="regex">{strings.t(M.regex)}</option>
            </select>
          </label>
          <label style={inline}>
            <span style={labelText}>{strings.t(M.special)}</span>
            <select
              data-find-special=""
              value=""
              onChange={(e) => {
                const code = e.target.value;
                if (!code) return;
                if (field === "find") set({ find: o.find + code });
                else set({ replace: o.replace + code });
              }}
              style={select}
            >
              <option value="">…</option>
              {SPECIALS.filter((s) =>
                field === "find" ? !s.replaceOnly : !s.findOnly,
              ).map((s) => (
                <option key={s.code} value={s.code}>
                  {strings.t(M[s.name])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset style={fieldset}>
          <legend style={legend}>{strings.t(M.findStyle)}</legend>
          <StylePick
            id="find-paragraph"
            label={strings.t(M.paragraphStyle)}
            none={strings.t(M.anyStyle)}
            styles={paragraphStyles}
            value={o.paragraphStyle}
            set={(v) => set({ paragraphStyle: v })}
          />
          <StylePick
            id="find-character"
            label={strings.t(M.characterStyle)}
            none={strings.t(M.anyStyle)}
            styles={characterStyles}
            value={o.characterStyle}
            set={(v) => set({ characterStyle: v })}
          />
        </fieldset>
        <fieldset style={fieldset}>
          <legend style={legend}>{strings.t(M.replaceStyle)}</legend>
          <StylePick
            id="replace-paragraph"
            label={strings.t(M.paragraphStyle)}
            none={strings.t(M.noStyle)}
            styles={paragraphStyles}
            value={o.replaceParagraphStyle}
            set={(v) => set({ replaceParagraphStyle: v })}
          />
          <StylePick
            id="replace-character"
            label={strings.t(M.characterStyle)}
            none={strings.t(M.noStyle)}
            styles={characterStyles}
            value={o.replaceCharacterStyle}
            set={(v) => set({ replaceCharacterStyle: v })}
          />
        </fieldset>
        <div data-find-status="" aria-live="polite" style={status}>
          {statusText(strings, state.status)}
        </div>
        <div style={buttons}>
          <Action
            id="previous"
            label={strings.t(M.findPrevious)}
            disabled={empty || busy}
            run={() => act((d) => findNext(d, store, true))}
          />
          <Action
            id="next"
            label={strings.t(M.findNext)}
            disabled={empty || busy}
            primary
            run={() => act((d) => findNext(d, store))}
          />
          <Action
            id="replace"
            label={strings.t(M.replace)}
            disabled={empty || busy}
            run={() => act((d) => replaceCurrent(d, store))}
          />
          <Action
            id="replaceAll"
            label={strings.t(M.replaceAll)}
            disabled={empty || busy}
            run={() => act((d) => replaceAll(d, store))}
          />
          <Action id="close" label={strings.t(M.close)} run={close} />
        </div>
      </FocusScope>
    </div>
  );
}

function Check({
  id,
  label,
  on,
  set,
}: {
  id: string;
  label: string;
  on: boolean;
  set: (v: boolean) => void;
}) {
  return (
    <label style={inline}>
      <input
        type="checkbox"
        data-find-option={id}
        checked={on}
        onChange={(e) => set(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function StylePick({
  id,
  label,
  none,
  styles,
  value,
  set,
}: {
  id: string;
  label: string;
  none: string;
  styles: readonly StyleRow[];
  value: string | null;
  set: (v: string | null) => void;
}) {
  return (
    <label style={rowLabel}>
      <span style={labelText}>{label}</span>
      <select
        data-find-style={id}
        value={value ?? ""}
        onChange={(e) => set(e.target.value || null)}
        style={{ ...select, flex: 1 }}
      >
        <option value="">{none}</option>
        {styles.map((s) => (
          <option key={s.selfId} value={s.selfId}>
            {displayName(s.name)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Action({
  id,
  label,
  disabled = false,
  primary = false,
  run,
}: {
  id: string;
  label: string;
  disabled?: boolean;
  primary?: boolean;
  run: () => void;
}) {
  return (
    <button
      type="button"
      data-find-action={id}
      disabled={disabled}
      onClick={run}
      style={{
        ...button,
        background: primary ? color.primary : "transparent",
        color: primary ? color.primaryFg : color.fg,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- go to

/** The Go To dialog (a page number), while the store says it is open. */
export function GoToDialog() {
  const { state } = useFind();
  return state.goTo ? <GoToForm /> : null;
}

function GoToForm() {
  const strings = useStrings();
  const scope = useEditorScope();
  const store = findStoreOf(scope);
  const doc = useDocument();
  const pageIds = doc.handle?.pageIds ?? [];
  const [value, setValue] = useState("");
  const index = pageIndexOf(value, pageIds.length);
  const close = () => patchFind(store, { goTo: false });
  const go = () => {
    if (index === null) return;
    void pageDoorsOf(scope).pages.goToPage(String(pageIds[index]), "page");
    close();
  };
  return (
    <div
      role="dialog"
      aria-labelledby="go-to-title"
      data-goto-dialog=""
      data-panel-host=""
      style={{ ...dialog, width: "min(260px, 92vw)" }}
    >
      <FocusScope autoFocus restoreFocus>
        <h2 id="go-to-title" style={heading}>
          {strings.t(M.goToTitle)}
        </h2>
        <label style={rowLabel}>
          <span style={labelText}>{strings.t(M.pageNumber)}</span>
          <input
            type="text"
            inputMode="numeric"
            data-goto-input=""
            value={value}
            placeholder={strings.t(M.pageRange, { count: pageIds.length })}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => fieldKeys(e, go, close)}
            style={input}
          />
        </label>
        <div style={buttons}>
          <Action
            id="go"
            label={strings.t(M.go)}
            primary
            disabled={index === null}
            run={go}
          />
          <Action id="close" label={strings.t(M.close)} run={close} />
        </div>
      </FocusScope>
    </div>
  );
}

// -------------------------------------------------------- results panel

export const FIND_RESULTS_PANEL = "paged.find-results";

/** The Navigation pane's Results tab: search the document, every hit with
 *  its context, a click goes to the hit. */
export function FindResultsPanel() {
  const strings = useStrings();
  const { state, store, deps, paged, scope } = useFind();
  const client = useCanvasClient();
  const fieldRef = useRef<HTMLInputElement>(null);
  const o = state.options;

  // Cmd+F focuses the field (the command bumps `focusSearch`).
  useEffect(() => {
    if (state.focusSearch > 0) {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }
  }, [state.focusSearch]);

  // The hits follow the document: a search that ran is run again after an
  // edit, a beat later so a burst of typing searches once.
  const searched = state.searchedFor !== null;
  // The editor handle changes identity with its state; the search reads
  // the newest one when it runs, so the subscription outlives re-renders.
  const searchAgain = useEffectEvent(() => {
    if (paged) void runSearch(findDepsOf(paged, scope), store);
  });
  useEffect(() => {
    if (!searched) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = client.subscribe((msg) => {
      if (!changesTheDocument(msg)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(searchAgain, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [client, searched]);

  const search = () => {
    if (deps) void runSearch(deps, store);
  };
  const hits = state.hits;

  return (
    <div
      data-find-results-panel={state.searchedFor === null ? "idle" : "searched"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 12px",
      }}
    >
      <input
        ref={fieldRef}
        type="search"
        data-find-search=""
        aria-label={strings.t(M.searchDocument)}
        placeholder={strings.t(M.searchDocument)}
        value={o.find}
        onChange={(e) => setFindOptions(store, { find: e.target.value })}
        onKeyDown={(e) =>
          fieldKeys(
            e,
            (shift) => {
              if (!deps) return;
              // Enter searches; again on the same text goes to the next hit.
              if (state.searchedFor === o.find && hits.length > 0)
                void findNext(deps, store, shift);
              else search();
            },
            () => setFindOptions(store, { find: "" }),
          )
        }
        style={input}
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11 }}>
        <Check
          id="matchCase"
          label={strings.t(M.matchCase)}
          on={o.matchCase}
          set={(v) => setFindOptions(store, { matchCase: v })}
        />
        <Check
          id="wholeWord"
          label={strings.t(M.wholeWord)}
          on={o.wholeWord}
          set={(v) => setFindOptions(store, { wholeWord: v })}
        />
        <button
          type="button"
          data-find-open-replace=""
          onClick={() => patchFind(store, { dialog: true })}
          style={{ ...button, padding: "2px 8px", marginLeft: "auto" }}
        >
          {strings.t(M.openReplace)}
        </button>
      </div>
      <div data-find-count={hits.length} style={status}>
        {state.searchedFor === null
          ? strings.t(M.typeToSearch)
          : hits.length === 0
            ? strings.t(M.noResults)
            : strings.t(M.results, { count: hits.length })}
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {hits.map((hit, i) => {
          const parts = contextParts(hit);
          return (
            <li key={`${hit.storyId}:${hit.start}:${i}`}>
              <button
                type="button"
                data-find-hit={i}
                aria-current={i === state.current ? "true" : undefined}
                onClick={() => {
                  if (deps) void goToHit(deps, store, i);
                }}
                style={{
                  ...hitRow,
                  background:
                    i === state.current ? color.primarySoft : "transparent",
                }}
              >
                <span style={{ color: color.mutedFg }}>{parts.before}</span>
                <mark style={mark}>{parts.match}</mark>
                <span style={{ color: color.mutedFg }}>{parts.after}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// --------------------------------------------------------------- styles

const dialog: CSSProperties = {
  position: "fixed",
  top: 72,
  right: 24,
  zIndex: 1000,
  width: "min(380px, 92vw)",
  maxHeight: "calc(100vh - 96px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
  fontSize: 12,
};
const heading: CSSProperties = {
  margin: "0 0 10px",
  fontSize: 14,
  fontWeight: 600,
};
const rowLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};
const labelText: CSSProperties = {
  minWidth: 84,
  color: color.mutedFg,
};
const inline: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
};
const optionsRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  marginBottom: 6,
};
const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
};
const select: CSSProperties = {
  height: 26,
  borderRadius: 6,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
};
const fieldset: CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: 6,
  padding: "6px 8px 2px",
  margin: "0 0 8px",
};
const legend: CSSProperties = { padding: "0 4px", color: color.mutedFg };
const status: CSSProperties = {
  minHeight: 16,
  color: color.mutedFg,
  fontSize: 11,
};
const buttons: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: 6,
  marginTop: 8,
};
const button: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  color: color.fg,
  background: "transparent",
};
const hitRow: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "4px 6px",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.4,
  color: color.fg,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const mark: CSSProperties = {
  background: "var(--pg-highlight, #fde68a)",
  color: "inherit",
  borderRadius: 2,
  padding: "0 1px",
};
