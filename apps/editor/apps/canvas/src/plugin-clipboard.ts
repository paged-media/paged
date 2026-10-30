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

// K-6 / S-14 — the editor's `ClipboardBackend` over `navigator.clipboard`,
// backing `host.clipboard`. Persistent system-clipboard read/write with a
// rich `{ text?, tabular? }` payload (the sheets grid's range copy/paste
// interchange).
//
// The SDK door (plugin-sdk `host-impl.ts`) owns the capability gate, the
// "full"/"vector"/"none" tier mapping (a "vector" grant never reaches the
// tabular half), and the no-backend honest path. This module owns only the
// raw IO the SDK cannot: laying bytes onto / reading bytes off the OS
// clipboard, and the TSV↔grid transport.
//
// WRITE puts BOTH `text/plain` (TSV — rows joined by \t within a row and \n
// between rows) AND `text/html` (a real `<table>`) on the clipboard via
// `navigator.clipboard.write([new ClipboardItem({...})])`, so a paste into
// Excel / Google Sheets / Word lands a real grid, not a tab-soup line. When
// `ClipboardItem` is unavailable (older engine / no rich-write support) it
// falls back to `writeText(text)` — the TSV still round-trips into a
// spreadsheet, only the rich HTML table is lost.
//
// READ pulls `text/plain` and parses the TSV back into `{ rows }`. (We do
// not parse pasted HTML tables in v1 — the TSV the browser exposes for a
// copied spreadsheet range is the lossless-enough floor; richer HTML-table
// ingest is a forward refinement.)
//
// SVG (extensions ADR 341, editor ADR 289): the backend carries the `svg`
// half (`clipboard.svg@1`). WRITE adds `image/svg+xml` where the browser
// takes it (`ClipboardItem.supports`), and the plain-text form is the SVG
// code when the payload brings no text. READ goes through
// `navigator.clipboard.read()` where it exists and fills `svg` from plain
// text that IS an SVG document (Illustrator's), else from the
// `image/svg+xml` flavour (sanitised by the browser: no `<style>`).
//
// Both directions are behind a feature/availability check with an honest
// fallback: when there is no `navigator.clipboard` at all, read answers
// `null` and write is a no-op. The browser also REFUSES clipboard access
// without a user gesture / permission — those rejections propagate as a
// throw the SDK door swallows (read → null, write → logged no-op), so this
// module never has to special-case them.

import type { ClipboardBackend } from "@paged-media/plugin-sdk";
import type {
  ClipboardPayload,
  TabularClipboard,
} from "@paged-media/plugin-api";

import { clipboardTakes, svgDocumentOf, SVG_MIME } from "./clipboard-commands";

/** Does the realm expose a system clipboard at all? (Insecure contexts /
 *  older engines have no `navigator.clipboard`.) */
function hasClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined"
  );
}

/** Is the rich-write path (`ClipboardItem` + `clipboard.write`) available?
 *  Some engines expose `writeText` but not the multi-MIME `write`. */
function hasRichWrite(): boolean {
  return (
    hasClipboard() &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

/** Rows → TSV: tabs between cells, newlines between rows. The spreadsheet
 *  paste interchange every host (Excel/Sheets/Word) understands. */
function rowsToTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.join("\t")).join("\n");
}

/** TSV → rows: the inverse. Splits on \n then \t. A trailing newline yields
 *  no spurious empty row (Excel appends one on copy); CRLF is tolerated. */
function tsvToRows(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Drop a single trailing newline so a copied range doesn't gain a blank row.
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (body === "") return [];
  return body.split("\n").map((line) => line.split("\t"));
}

/** Escape a cell's text for safe inclusion in the HTML `<table>` body. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Rows → a minimal `<table>` HTML fragment. Excel/Sheets/Word read this
 *  as a real grid on paste (cells become cells, not tab text). */
function rowsToHtmlTable(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map(
      (r) =>
        "<tr>" + r.map((c) => `<td>${escapeHtml(c)}</td>`).join("") + "</tr>",
    )
    .join("");
  return `<table>${body}</table>`;
}

/** Build the editor's clipboard backend over `navigator.clipboard`. When no
 *  clipboard exists, read → null and write → no-op (the honest fallback);
 *  the SDK door reports `supports("clipboard@1")` true regardless (a backend
 *  IS injected — the platform availability is the backend's own concern, and
 *  a denied platform access degrades honestly per call). */
export function createEditorClipboardBackend(): ClipboardBackend {
  return {
    svg: true,
    async read(): Promise<ClipboardPayload | null> {
      if (!hasClipboard()) return null;
      // Either read may reject (no gesture / permission) — let it
      // propagate; the SDK door turns a thrown read into `null`.
      let text = "";
      let svgFlavour = "";
      if (typeof navigator.clipboard.read === "function") {
        for (const item of await navigator.clipboard.read()) {
          if (!text && item.types.includes("text/plain"))
            text = await (await item.getType("text/plain")).text();
          if (!svgFlavour && item.types.includes(SVG_MIME))
            svgFlavour = await (await item.getType(SVG_MIME)).text();
        }
      } else if (typeof navigator.clipboard.readText === "function") {
        text = await navigator.clipboard.readText();
      } else {
        return null;
      }
      const svgText = svgDocumentOf(text);
      const svg = svgText ?? svgDocumentOf(svgFlavour);
      if (text === "" && !svg) return null;
      // SVG code is not a grid.
      const rows = svgText ? [] : tsvToRows(text);
      const tabular: TabularClipboard | undefined =
        rows.length > 0 ? { rows } : undefined;
      return {
        ...(text !== "" ? { text } : {}),
        ...(tabular ? { tabular } : {}),
        ...(svg ? { svg } : {}),
      };
    },

    async write(payload: ClipboardPayload): Promise<void> {
      if (!hasClipboard()) return; // no clipboard — honest no-op

      // The text half: an explicit `text` wins; otherwise derive TSV from the
      // tabular grid (a grid copy always wants a TSV fallback).
      const text =
        payload.text ??
        (payload.tabular ? rowsToTsv(payload.tabular.rows) : payload.svg) ??
        "";
      const svg = payload.svg && clipboardTakes(SVG_MIME) ? payload.svg : null;

      // Rich path: lay down BOTH text/plain AND a text/html <table> so a
      // paste into a spreadsheet lands a real grid. Only when there is a
      // tabular half to make a table from (a plain-text copy needs no HTML).
      if (payload.tabular && hasRichWrite()) {
        const html = rowsToHtmlTable(payload.tabular.rows);
        const item = new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
          ...(svg ? { [SVG_MIME]: new Blob([svg], { type: SVG_MIME }) } : {}),
        });
        // May reject (no gesture / permission) — propagate; the SDK door
        // swallows it (logged no-op).
        await navigator.clipboard.write([item]);
        return;
      }

      // The vector path (ADR 341): text/plain beside image/svg+xml.
      if (svg && hasRichWrite()) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            [SVG_MIME]: new Blob([svg], { type: SVG_MIME }),
          }),
        ]);
        return;
      }

      // Fallback: plain text only (no rich-write support, or a text-only
      // payload). The TSV still round-trips into a spreadsheet.
      if (typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
      }
    },
  };
}
