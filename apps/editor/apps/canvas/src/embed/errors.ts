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

// The embedding API's typed errors (docs/composable-editor.md §12, decision
// 1 of 2026-10-24). An error the editor refuses with carries a `code` a host
// can branch on, so it never parses a message. The check is structural
// (`isEditorError`), not `instanceof`: the package's entry and the editor it
// loads, and an editor in a frame, each make their own.

/** Why `createEditor` (or `connectEditor`) refused. */
export type EditorErrorCode =
  | "notCrossOriginIsolated"
  /** `config.seed` names no seed document (editor ADR 212, amendment 1). */
  | "unknownSeed"
  /** `config.sample` names no sample in the catalog, or the catalog could
   *  not be read (editor ADR 212, amendment 2). */
  | "unknownSample";

/** An error the embedding API refuses with. */
export interface EditorError extends Error {
  readonly name: "EditorError";
  readonly code: EditorErrorCode;
}

const CODES: ReadonlySet<string> = new Set<EditorErrorCode>([
  "notCrossOriginIsolated",
  "unknownSeed",
  "unknownSample",
]);

/** An `EditorError` with this code and message. */
export function editorError(
  code: EditorErrorCode,
  message: string,
): EditorError {
  const error = new Error(message) as Error & {
    name: string;
    code: EditorErrorCode;
  };
  error.name = "EditorError";
  error.code = code;
  return error as EditorError;
}

/** Whether `value` is an error the embedding API refused with. */
export function isEditorError(value: unknown): value is EditorError {
  return (
    value instanceof Error &&
    value.name === "EditorError" &&
    CODES.has((value as { code?: unknown }).code as string)
  );
}

/**
 * The refusal of an editor on a page that is not cross-origin isolated. There
 * is no degraded mode: the engine shares memory with its worker. The message
 * names both ways out: the page's own headers, and the iframe path, whose
 * host page needs fewer of them.
 */
export function notCrossOriginIsolated(where: "page" | "frame"): EditorError {
  const frame = [
    "connectEditor(iframe, config) from @paged-media/editor/iframe drives an editor served",
    "from its own deployment (embed.html, which sends its own headers); its host page sends",
    "Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless,",
    "which asks nothing of the page's other resources, and the iframe allows",
    "cross-origin-isolated (connectEditor sets it).",
  ].join(" ");
  return editorError(
    "notCrossOriginIsolated",
    where === "frame"
      ? `The editor's frame is not cross-origin isolated: a frame is isolated only when its host page is. ${frame}`
      : [
          "The page is not cross-origin isolated, and the editor's engine shares memory with its worker.",
          "Serve the page with Cross-Origin-Opener-Policy: same-origin and",
          "Cross-Origin-Embedder-Policy: credentialless (or require-corp), or embed the editor",
          `through the iframe: ${frame}`,
        ].join(" "),
  );
}

/** Refuse when this page cannot run the editor. `isolated` is the page's
 *  `crossOriginIsolated` (tests pass their own). */
export function assertEmbeddable(
  isolated: unknown = (globalThis as { crossOriginIsolated?: unknown })
    .crossOriginIsolated,
): void {
  if (isolated === true) return;
  let framed = false;
  try {
    framed = globalThis.top !== undefined && globalThis.top !== globalThis.self;
  } catch {
    framed = true;
  }
  throw notCrossOriginIsolated(framed ? "frame" : "page");
}

/** The refusal of a seed name the editor does not know; the message lists
 *  the names it does. */
export function unknownSeed(
  name: string,
  known: readonly string[],
): EditorError {
  return editorError(
    "unknownSeed",
    `No seed document is named "${name}". The seeds: ${known.join(", ")}.`,
  );
}

/** The refusal of a sample id the catalog does not list; the message says
 *  which catalog and the ids it does list, or that it could not be read. */
export function unknownSample(
  id: string,
  catalog: string,
  known: readonly string[],
): EditorError {
  return editorError(
    "unknownSample",
    known.length === 0
      ? `No sample is named "${id}": the catalog at ${catalog} could not be read or lists none.`
      : `No sample is named "${id}" in the catalog at ${catalog}. It lists: ${known.join(", ")}.`,
  );
}
