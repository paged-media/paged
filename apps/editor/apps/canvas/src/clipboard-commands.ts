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

// The page-item clipboard (ADR 231, finding F-28 / SH-201): Cut, Copy,
// Paste, Paste in Place and Duplicate for page items, as InDesign has them.
//
// WHAT IS ON THE CLIPBOARD. Copy asks the engine for a SNIPPET of the
// selection (`exportElements`, engine ADR 193): the items whole — a group
// with its members, a frame with a copy of its story — plus the swatches
// and styles they name. That JSON is the internal format, held here, so a
// paste works after a Cut deleted the items and after another document was
// opened in their place. The system clipboard gets two standard forms where
// the browser allows a write: `text/plain` (the copied frames' text, for
// any other application) and `text/html` carrying a marker of this copy (and
// the snippet itself when it is small), so a paste can tell "still my copy"
// from "the user copied something else since".
//
// PASTE. With a snippet that is still the clipboard's, Paste centres the
// copies on the view (InDesign's Paste) and Paste in Place keeps their
// position on the page; both land on the page in view, on top of its
// stacking order, as one undo step, and select what they made. Text from
// elsewhere becomes a new text frame at the centre of the view. With a text
// caret the keys are the story's (`useTextEditing`): copy and cut a range,
// paste text into the story.
//
// VECTORS (ADR 289). Copy also asks the engine for the selection as an
// SVG document (`exportSvg`, `paged-svg`, text as outlines) and writes it
// as `image/svg+xml` where the browser takes that type; with no frame text
// to carry, the SVG is the `text/plain` form too, as Illustrator writes
// it. Paste of an SVG — the `image/svg+xml` flavour, or plain text that IS
// an SVG document (preferred: the browser sanitises the first and drops
// its `<style>`) — imports through `paged-svg` as native page items, one
// undo step, centred on the view (Paste) or at the page origin (Paste in
// place: SVG user space is page space), the import's losses reported. No
// browser lets a page write PDF to the clipboard (`ClipboardItem.supports
// ("application/pdf")` is false), and none exposes Illustrator's PDF
// flavour to a read; what it does expose is recorded in ADR 289.
//
// DUPLICATE (InDesign: Alt+Shift+Cmd+D) copies the selection in place,
// offset by InDesign's default step of 1p0 (12 pt) right and down, directly
// above each source, one undo step (`duplicateElements`).

import type {
  CommandContribution,
  KeybindingContribution,
  MenuItemContribution,
  PagedEditor,
} from "@paged-media/shell";
import type { ElementId, Mutation, WorkerToMain } from "@paged-media/client";
import { viewportToDoc } from "@paged-media/client";

import { objectVerbApplies, refusalOf } from "./object-commands";
import { currentPageTarget, TEXT_FRAME_SIZE_PT } from "./insert-commands";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.clipboardCommands", {
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteInPlace: "Paste in place",
  duplicate: "Duplicate",
  refused: "{verb} refused: {reason}",
  needsItem: "{verb} needs a selected page item.",
  noAnswer: "the engine did not answer",
  nothingToCopy: "nothing to copy",
  needsDocument: "{verb} needs an open document.",
  clipboardEmpty: "{verb}: the clipboard holds nothing to paste.",
  svgUnreadable: "{verb}: the clipboard's SVG could not be read: {error}",
  svgNothing: "{verb}: the clipboard's SVG draws nothing.",
  svgApproximated: "{verb} (SVG): {message} ({count}×)",
});

// The words of this file's menu rows; the shell's menu bar shows each
// path segment through them (`menu.<segment>`).
defineMessages("menu", {
  Cut: "Cut",
  Copy: "Copy",
  Paste: "Paste",
  "Paste in place": "Paste in place",
  Duplicate: "Duplicate",
});

// The palette categories of this file's commands (`commandCategory.<name>`).
defineMessages("commandCategory", {
  Edit: "Edit",
});

export const PAGED_EDIT_CUT = "paged.edit.cut";
export const PAGED_EDIT_COPY = "paged.edit.copy";
export const PAGED_EDIT_PASTE = "paged.edit.paste";
export const PAGED_EDIT_PASTE_IN_PLACE = "paged.edit.pasteInPlace";
export const PAGED_EDIT_DUPLICATE = "paged.edit.duplicate";

export const CLIPBOARD_DIAGNOSTIC_SOURCE = "paged.clipboard";

/** InDesign's Duplicate step (its Step and Repeat default, 1p0 each way). */
export const DUPLICATE_OFFSET_PT: readonly [number, number] = [12, 12];

/** The HTML attribute that marks a copy this editor wrote. */
const MARKER_ATTR = "data-paged-clip";
/** The HTML attribute that carries the snippet (small copies only). */
const SNIPPET_ATTR = "data-paged-snippet";
/** The largest snippet the HTML form carries (base64 grows it by a third;
 *  a copy with photos stays internal). */
const SNIPPET_IN_HTML_MAX = 512 * 1024;

/** What Copy put on the clipboard. */
export interface PageItemClip {
  /** The engine's snippet JSON (the internal format). */
  snippet: string;
  /** The copied frames' text: the plain-text form. */
  text: string;
  /** The copy as an SVG document (`image/svg+xml`), when the engine
   *  wrote one (ADR 289). */
  svg?: string;
  /** How many items were copied (roots). */
  count: number;
  /** This copy's marker on the system clipboard. */
  token: string;
}

/** Where the commands report: the Problems channel (`report` in main). */
export type ClipboardReport = (
  severity: "info" | "warning" | "error",
  message: string,
) => void;

/** The forms a copy puts on, and a paste reads off, the system
 *  clipboard. `svg` is the `image/svg+xml` flavour (ADR 289). */
export interface ClipboardForms {
  text: string;
  html: string;
  svg?: string;
}

/** The system clipboard, as far as the browser lets us reach it. Injected
 *  so tests (and a host without one) can stand in. */
export interface SystemClipboard {
  /** Write the forms (an `svg` the platform will not take is left out);
   *  resolves false when refused. */
  write(forms: ClipboardForms): Promise<boolean>;
  /** Read the forms; null when refused. */
  read(): Promise<ClipboardForms | null>;
}

const SESSION = Math.random().toString(36).slice(2, 10);
let seq = 0;
let clip: PageItemClip | null = null;
const listeners = new Set<() => void>();

/** The page-item clipboard (one per editor session). */
export const pageItemClipboard = {
  current(): PageItemClip | null {
    return clip;
  },
  set(next: PageItemClip | null): void {
    clip = next;
    for (const l of [...listeners]) l();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(s: string): string | null {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The plain-text form of a copy: its frames' text, else its SVG code
 *  (as Illustrator writes it, so another application's text paste lands
 *  the drawing). */
export function plainTextOf(c: PageItemClip): string {
  return c.text || c.svg || "";
}

/** The HTML form of a copy: its text, marked as this editor's. */
export function clipHtml(c: PageItemClip): string {
  const carry =
    c.snippet.length <= SNIPPET_IN_HTML_MAX
      ? ` ${SNIPPET_ATTR}="${toBase64(c.snippet)}"`
      : "";
  const body = escapeHtml(c.text).replace(/\n/g, "<br>");
  return `<div ${MARKER_ATTR}="${c.token}"${carry}>${body}</div>`;
}

/** What a system clipboard's content is to this editor. */
export type ClipboardContent =
  | { kind: "items"; snippet: string }
  | { kind: "svg"; svg: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

/** `text` when it is an SVG document (an XML declaration, comments and a
 *  doctype may come first), else null. Illustrator's plain-text flavour
 *  is its SVG code. */
export function svgDocumentOf(text: string | undefined): string | null {
  if (!text) return null;
  const body = text.replace(/^\uFEFF/, "").trim();
  return /^(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(
    body,
  ) && /<\/svg>\s*$/i.test(body)
    ? body
    : null;
}

/** Decide what a paste pastes. The system clipboard wins when it holds
 *  something newer than our copy (no marker, or another copy's); our copy
 *  (internal) when the clipboard still carries its marker, or when the
 *  browser will not let us read the clipboard at all. */
export function resolvePaste(
  system: ClipboardForms | null,
  internal: PageItemClip | null,
): ClipboardContent {
  if (system) {
    const marker = new RegExp(`${MARKER_ATTR}="([^"]+)"`).exec(system.html);
    if (marker) {
      if (internal && marker[1] === internal.token)
        return { kind: "items", snippet: internal.snippet };
      const carried = new RegExp(`${SNIPPET_ATTR}="([^"]+)"`).exec(system.html);
      const snippet = carried ? fromBase64(carried[1]) : null;
      if (snippet) return { kind: "items", snippet };
    }
    if (system.text) {
      // Our own plain text with the marker lost on the way (a browser
      // that keeps text/plain only) is still our copy.
      if (
        internal &&
        !marker &&
        system.text === plainTextOf(internal) &&
        !system.html
      )
        return { kind: "items", snippet: internal.snippet };
    }
    // Vectors (ADR 289): plain text that is an SVG document first (the
    // source as written; the browser's `image/svg+xml` is sanitised, its
    // `<style>` dropped), then the SVG flavour itself.
    const svg = svgDocumentOf(system.text) ?? svgDocumentOf(system.svg);
    if (svg) return { kind: "svg", svg };
    if (system.text)
      return { kind: "text", text: system.text.replace(/\r\n?/g, "\n") };
    if (marker && internal) return { kind: "items", snippet: internal.snippet };
  }
  if (internal) return { kind: "items", snippet: internal.snippet };
  return { kind: "empty" };
}

/** The SVG MIME type of the async clipboard (Chromium 124+ writes it as
 *  the platform's SVG flavour, `public.svg-image` on macOS). */
export const SVG_MIME = "image/svg+xml";

/** Does the browser's clipboard take `type`? `ClipboardItem.supports`
 *  where it exists; where it does not, only the two universal types. */
export function clipboardTakes(type: string): boolean {
  const CI = (
    globalThis as { ClipboardItem?: { supports?: (t: string) => boolean } }
  ).ClipboardItem;
  if (typeof CI?.supports === "function") {
    try {
      return CI.supports(type);
    } catch {
      return false;
    }
  }
  return type === "text/plain" || type === "text/html";
}

/** The browser's async clipboard (where it exists and the user allows). */
export function browserClipboard(): SystemClipboard {
  return {
    async write({ text, html, svg }) {
      const nav = globalThis.navigator as Navigator | undefined;
      const cb = nav?.clipboard;
      if (!cb) return false;
      try {
        if (typeof ClipboardItem !== "undefined" && cb.write) {
          const forms: Record<string, Blob> = {
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          };
          if (svg && clipboardTakes(SVG_MIME)) {
            try {
              await cb.write([
                new ClipboardItem({
                  ...forms,
                  [SVG_MIME]: new Blob([svg], { type: SVG_MIME }),
                }),
              ]);
              return true;
            } catch {
              /* a browser that names the type but refuses it: without */
            }
          }
          await cb.write([new ClipboardItem(forms)]);
          return true;
        }
        await cb.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    async read() {
      const cb = (globalThis.navigator as Navigator | undefined)?.clipboard;
      if (!cb) return null;
      try {
        if (cb.read) {
          const items = await cb.read();
          let text = "";
          let html = "";
          let svg = "";
          for (const item of items) {
            if (!text && item.types.includes("text/plain"))
              text = await (await item.getType("text/plain")).text();
            if (!html && item.types.includes("text/html"))
              html = await (await item.getType("text/html")).text();
            if (!svg && item.types.includes(SVG_MIME))
              svg = await (await item.getType(SVG_MIME)).text();
          }
          return svg ? { text, html, svg } : { text, html };
        }
        return { text: await cb.readText(), html: "" };
      } catch {
        return null;
      }
    },
  };
}

/** The deps the clipboard runners need beyond the live editor. */
export interface ClipboardDeps {
  report: ClipboardReport;
  system: SystemClipboard;
  /** Delete the selection as Object ▸ Delete does (Cut's second half). */
  deleteSelection: () => Promise<void>;
}

const isPageItem = (id: ElementId): boolean =>
  id.kind === "textFrame" ||
  id.kind === "rectangle" ||
  id.kind === "oval" ||
  id.kind === "graphicLine" ||
  id.kind === "polygon" ||
  id.kind === "group";

const VERB_KEYS: Readonly<Record<string, string>> = {
  Cut: M.cut,
  Copy: M.copy,
  Paste: M.paste,
  "Paste in place": M.pasteInPlace,
  Duplicate: M.duplicate,
};

/** A verb's words for a report. */
function verbText(verb: string): string {
  const key = VERB_KEYS[verb];
  return key ? t(key) : verb;
}

/** "<verb> refused: <reason>", in the editor's words. */
function refusedText(verb: string, reason: string): string {
  return t(M.refused, { verb: verbText(verb), reason });
}

function selectedItems(paged: PagedEditor): ElementId[] {
  return paged.selection.elementSelection.filter(isPageItem);
}

/** Copy the selection to the clipboard. Resolves the clip, or null when
 *  nothing was copied (reported). */
export async function copySelection(
  paged: PagedEditor,
  deps: ClipboardDeps,
  verb = "Copy",
): Promise<PageItemClip | null> {
  const ids = selectedItems(paged);
  if (ids.length === 0) {
    deps.report("info", t(M.needsItem, { verb: verbText(verb) }));
    return null;
  }
  const reply = await paged.client.send({
    kind: "exportElements",
    payload: { elementIds: ids },
  });
  if (reply.kind !== "elementsExported") {
    deps.report("error", refusedText(verb, refusalOf(reply) ?? t(M.noAnswer)));
    return null;
  }
  const { snippet, refused } = reply.payload;
  const text = reply.payload.text ?? "";
  const count = reply.payload.count ?? 0;
  if (!snippet) {
    deps.report("error", refusedText(verb, refused ?? t(M.nothingToCopy)));
    return null;
  }
  const svg = await selectionSvg(paged, ids);
  const next: PageItemClip = {
    snippet,
    text,
    count,
    token: `${SESSION}:${++seq}`,
    ...(svg ? { svg } : {}),
  };
  pageItemClipboard.set(next);
  // Best effort: the internal copy stands whether or not the browser lets
  // us write the system clipboard.
  await deps.system.write({
    text: plainTextOf(next),
    html: clipHtml(next),
    ...(svg ? { svg } : {}),
  });
  return next;
}

/** The copied items as one SVG document (ADR 289): the engine's
 *  `paged-svg` export of the items on the first selected item's page,
 *  text as outlines. Null when the engine cannot write one; the copy
 *  stands without it. */
async function selectionSvg(
  paged: PagedEditor,
  ids: readonly ElementId[],
): Promise<string | null> {
  try {
    const geometry = await paged.client.elementGeometry([...ids]);
    const pageId = geometry.find((g) => g.pageId)?.pageId;
    if (!pageId) return null;
    const onPage = ids.filter((_, i) => geometry[i]?.pageId === pageId);
    const { svg } = await paged.client.exportSvg(
      pageId,
      onPage.length > 0 ? onPage : ids,
    );
    return svg || null;
  } catch {
    return null;
  }
}

/** Cut: copy, then delete the selection (one undo step: the delete). */
export async function cutSelection(
  paged: PagedEditor,
  deps: ClipboardDeps,
): Promise<void> {
  const copied = await copySelection(paged, deps, "Cut");
  if (!copied) return;
  await deps.deleteSelection();
}

/** The page in view and the view's centre on it, in page space. */
function viewCentre(
  paged: PagedEditor,
): { pageId: string; center: [number, number] } | null {
  const target = currentPageTarget(paged);
  if (!target) return null;
  const cam = paged.camera.camera;
  const [vw, vh] = paged.camera.viewportSize;
  if (!(cam.scale > 0) || vw <= 0 || vh <= 0)
    return {
      pageId: target.pageId,
      center: [target.rect.w / 2, target.rect.h / 2],
    };
  const [x, y] = viewportToDoc(cam, vw / 2, vh / 2);
  // The centre of the view, kept on the page in view (a view centred on
  // the pasteboard pastes onto the nearest page's edge).
  const cx = Math.min(Math.max(x - target.rect.x, 0), target.rect.w);
  const cy = Math.min(Math.max(y - target.rect.y, 0), target.rect.h);
  return { pageId: target.pageId, center: [cx, cy] };
}

async function selectMinted(
  paged: PagedEditor,
  reply: WorkerToMain,
  topOnly = false,
): Promise<void> {
  if (reply.kind !== "mutationApplied") return;
  const minted = (reply.payload.minted ?? []).map((m) => m.element);
  // An SVG import mints its top item (its group) last.
  const all = topOnly ? minted.slice(-1) : minted;
  const ids =
    all.length > 0
      ? all
      : reply.payload.createdId
        ? [reply.payload.createdId]
        : [];
  if (ids.length === 0) return;
  try {
    const selected = await paged.client.setElementSelection(ids, "replace");
    paged.selection.setElementSelection(selected);
    paged.selection.setElementGeometry(
      await paged.client.elementGeometry(selected),
    );
  } catch {
    /* the paste stands; the selection is a courtesy */
  }
}

/** Paste: our copy centred on the view (or in place), or text from
 *  elsewhere as a new text frame at the view's centre. */
export async function pasteClipboard(
  paged: PagedEditor,
  deps: ClipboardDeps,
  inPlace: boolean,
): Promise<void> {
  const verb = inPlace ? "Paste in place" : "Paste";
  const handle = paged.document.handle;
  if (!handle || handle.pageCount === 0) {
    deps.report("info", t(M.needsDocument, { verb: verbText(verb) }));
    return;
  }
  const at = viewCentre(paged);
  if (!at) return;
  const content = resolvePaste(
    await deps.system.read(),
    pageItemClipboard.current(),
  );
  if (content.kind === "empty") {
    deps.report("info", t(M.clipboardEmpty, { verb: verbText(verb) }));
    return;
  }
  if (content.kind === "svg") {
    await pasteSvg(paged, deps, verb, content.svg, at, inPlace);
    return;
  }
  let mutation: Mutation;
  if (content.kind === "items") {
    mutation = {
      op: "pasteElements",
      args: {
        snippet: content.snippet,
        pageId: at.pageId,
        center: inPlace ? null : at.center,
      },
    };
  } else {
    const [w, h] = TEXT_FRAME_SIZE_PT;
    const [cx, cy] = at.center;
    mutation = {
      op: "batch",
      args: {
        ops: [
          {
            op: "insertTextFrame",
            args: {
              pageId: at.pageId,
              bounds: [cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2],
            },
          },
          { op: "bindCreated", args: { handle: "pasted" } },
          {
            op: "insertText",
            args: {
              storyId: "$h:pasted",
              offset: 0,
              text: content.text,
              cell: null,
            },
          },
        ],
      },
    };
  }
  const reply = await paged.client.mutate(mutation);
  const refusal = refusalOf(reply);
  if (refusal) {
    deps.report("error", refusedText(verb, refusal));
    return;
  }
  await selectMinted(paged, reply);
}

/** Paste an SVG document (ADR 289): `paged-svg` plans ONE batch of native
 *  page items, applied as one undo step. Paste centres the drawing on the
 *  view (a first plan measures it); Paste in place puts its user space on
 *  the page's (origin 0,0). What the import approximated or left out is
 *  reported, never dropped. */
export async function pasteSvg(
  paged: PagedEditor,
  deps: ClipboardDeps,
  verb: string,
  svg: string,
  at: { pageId: string; center: [number, number] },
  inPlace: boolean,
): Promise<WorkerToMain | null> {
  const bytes = new TextEncoder().encode(svg);
  let plan;
  try {
    plan = await paged.client.svgImportPlan(at.pageId, bytes, {
      origin: [0, 0],
    });
    if (!inPlace && plan.mutation) {
      const [cx, cy] = at.center;
      plan = await paged.client.svgImportPlan(at.pageId, bytes, {
        origin: [cx - plan.width / 2, cy - plan.height / 2],
      });
    }
  } catch (e) {
    deps.report(
      "error",
      t(M.svgUnreadable, { verb: verbText(verb), error: String(e) }),
    );
    return null;
  }
  if (plan.error) {
    deps.report(
      "error",
      t(M.svgUnreadable, { verb: verbText(verb), error: plan.error }),
    );
    return null;
  }
  if (!plan.mutation) {
    deps.report("info", t(M.svgNothing, { verb: verbText(verb) }));
    return null;
  }
  const reply = await paged.client.mutate(plan.mutation);
  const refusal = refusalOf(reply);
  if (refusal) {
    deps.report("error", refusedText(verb, refusal));
    return reply;
  }
  for (const n of plan.report.notes) {
    deps.report(
      "warning",
      t(M.svgApproximated, {
        verb: verbText(verb),
        message: n.message,
        count: n.count,
      }),
    );
  }
  await selectMinted(paged, reply, true);
  return reply;
}

/** Duplicate: a copy of each selected item, InDesign's step right and
 *  down, directly above its source; one undo step. */
export async function duplicateSelection(
  paged: PagedEditor,
  deps: ClipboardDeps,
): Promise<void> {
  const ids = selectedItems(paged);
  if (ids.length === 0) {
    deps.report("info", t(M.needsItem, { verb: verbText("Duplicate") }));
    return;
  }
  const reply = await paged.client.mutate({
    op: "duplicateElements",
    args: { elementIds: ids, offset: [...DUPLICATE_OFFSET_PT] },
  });
  const refusal = refusalOf(reply);
  if (refusal) {
    deps.report("error", refusedText("Duplicate", refusal));
    return;
  }
  await selectMinted(paged, reply);
}

/** The editor state the predicates read (structurally; total on a partial
 *  handle). */
interface ClipboardState {
  selection?: { elementSelection?: readonly ElementId[] } | null;
  document?: { handle?: { pageCount?: number } | null } | null;
}

const hasSelection = (state: unknown): boolean =>
  ((state as ClipboardState | null)?.selection?.elementSelection ?? []).some(
    isPageItem,
  );

const hasDocument = (state: unknown): boolean =>
  ((state as ClipboardState | null)?.document?.handle?.pageCount ?? 0) > 0;

/** Cut, Copy and Duplicate act on selected page items, outside an edit
 *  context and outside text (where the caret's own keys apply). */
export const clipboardSelectionApplies = (state: unknown): boolean =>
  objectVerbApplies(state) && hasSelection(state);

/** Paste needs a document, at the object level. */
export const pasteApplies = (state: unknown): boolean =>
  objectVerbApplies(state) && hasDocument(state);

export function buildClipboardCommands(
  deps: ClipboardDeps,
): CommandContribution[] {
  return [
    {
      id: PAGED_EDIT_CUT,
      title: t(M.cut),
      category: "Edit",
      when: clipboardSelectionApplies,
      handler: (paged) => cutSelection(paged as PagedEditor, deps),
    },
    {
      id: PAGED_EDIT_COPY,
      title: t(M.copy),
      category: "Edit",
      when: clipboardSelectionApplies,
      handler: async (paged) => {
        await copySelection(paged as PagedEditor, deps);
      },
    },
    {
      id: PAGED_EDIT_PASTE,
      title: t(M.paste),
      category: "Edit",
      when: pasteApplies,
      handler: (paged) => pasteClipboard(paged as PagedEditor, deps, false),
    },
    {
      id: PAGED_EDIT_PASTE_IN_PLACE,
      title: t(M.pasteInPlace),
      category: "Edit",
      when: pasteApplies,
      handler: (paged) => pasteClipboard(paged as PagedEditor, deps, true),
    },
    {
      id: PAGED_EDIT_DUPLICATE,
      title: t(M.duplicate),
      category: "Edit",
      when: clipboardSelectionApplies,
      handler: (paged) => duplicateSelection(paged as PagedEditor, deps),
    },
  ];
}

/** Edit menu rows, after Undo / Redo and before Select all (InDesign's
 *  order: the clipboard group, then Duplicate). */
export const CLIPBOARD_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Edit/Cut",
    command: PAGED_EDIT_CUT,
    order: 0,
    group: "clipboard",
    when: clipboardSelectionApplies,
  },
  {
    path: "Edit/Copy",
    command: PAGED_EDIT_COPY,
    order: 1,
    group: "clipboard",
    when: clipboardSelectionApplies,
  },
  {
    path: "Edit/Paste",
    command: PAGED_EDIT_PASTE,
    order: 2,
    group: "clipboard",
    when: pasteApplies,
  },
  {
    path: "Edit/Paste in place",
    command: PAGED_EDIT_PASTE_IN_PLACE,
    order: 3,
    group: "clipboard",
    when: pasteApplies,
  },
  {
    path: "Edit/Duplicate",
    command: PAGED_EDIT_DUPLICATE,
    order: 5,
    group: "duplicate",
    when: clipboardSelectionApplies,
  },
];

/** The platform keys (InDesign's defaults), cmd and ctrl twins. Guarded:
 *  with a caret the text's own copy, cut and paste take the keys. */
export const CLIPBOARD_KEYBINDINGS: KeybindingContribution[] = (
  [
    ["x", PAGED_EDIT_CUT, clipboardSelectionApplies],
    ["c", PAGED_EDIT_COPY, clipboardSelectionApplies],
    ["v", PAGED_EDIT_PASTE, pasteApplies],
    ["alt+shift+v", PAGED_EDIT_PASTE_IN_PLACE, pasteApplies],
    ["alt+shift+d", PAGED_EDIT_DUPLICATE, clipboardSelectionApplies],
  ] as const
).flatMap(([key, command, when]) =>
  (["cmd", "ctrl"] as const).map((mod) => ({
    key: `${mod}+${key}`,
    command,
    when,
  })),
);
