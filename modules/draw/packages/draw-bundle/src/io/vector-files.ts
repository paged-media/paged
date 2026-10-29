/*
 * This file is part of paged (https://paged.media).
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

// Illustrator and EPS files into the drawing (draw ADR 364) — through the
// doors the host already has, never a reader of the bundle's own:
//
//   · `.ai` — an Illustrator file saved with PDF compatibility IS a PDF.
//     paged.pdf (modules/publish) reads it with the engine's PDF
//     interpreter and places the page as native vectors (publish ADR 658:
//     paths, clip groups, gradients, images, text frames, one undo step).
//     The importer runs that bundle's typed command
//     `media.paged.pdf.placeVectors` through the shared object registry;
//     without paged.pdf it says so.
//   · `.eps` — the engine draws an EPS from its PostScript (`paged-ps`,
//     engine ADR 1033). The importer places the file in a frame of its
//     bounding box (one batch), asks the engine's SVG export for what that
//     frame draws, takes the placement back and lands the SVG through the
//     engine's SVG import: editable paths, gradients and pictures, and —
//     the placement undone before the import applies — ONE undo step.
//     Where the export draws nothing (a program the interpreter refuses),
//     the EPS stays placed and the log says why.

import type {
  BundleHost,
  Disposable,
  ElementId,
  ImportRequest,
  Mutation,
} from "@paged-media/plugin-api";

import { bytesToBase64 } from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
  HANDLE_PREFIX,
} from "../commands/batch-handles";
import { mutateMinting, mintedIds } from "../commands/minted";
import { resolveTargetPage } from "../target-page";
import { EXPORT_SVG_FEATURE, IMPORT_SVG_FEATURE, importSvgFile } from "./svg";

const M = defineMessages("draw.vectorFiles", {
  aiTitle: "Illustrator (PDF-compatible .ai)",
  epsTitle: "EPS (Encapsulated PostScript)",
});

export const AI_IMPORTER_ID = "media.paged.draw.importer.ai";
export const EPS_IMPORTER_ID = "media.paged.draw.importer.eps";
/** paged.pdf's typed command (publish ADR 658). */
export const PDF_PLACE_VECTORS = "media.paged.pdf.placeVectors";

// ------------------------------------------------------------------ AI

/** What `media.paged.pdf.placeVectors` answers, as far as this reads. */
interface PlaceVectorsAnswer {
  placed: boolean;
  root?: ElementId;
  losses?: readonly { code: string; count: number; message: string }[];
}

/** Place an `.ai` file's first page as vectors through paged.pdf. Answers
 *  the placed root (a group), or null with the reason logged. */
export async function importAi(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId | null> {
  if (!host.supports("objects.shared@1")) {
    host.log.warn(
      `${AI_IMPORTER_ID}: the host shares no object registry — ${file.name} not imported (paged.pdf reads Illustrator files)`,
    );
    return null;
  }
  const pageId = await resolveTargetPage(host);
  let answer: PlaceVectorsAnswer;
  try {
    answer = (await host.objects.invoke(PDF_PLACE_VECTORS, {
      bytes: file.bytes,
      name: file.name,
      page: 1,
      ...(pageId ? { pageId } : {}),
    })) as PlaceVectorsAnswer;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    host.log.warn(
      `${AI_IMPORTER_ID}: ${file.name} not imported — ${
        why.startsWith("unknownCommand")
          ? "the PDF import (paged.pdf) is not loaded"
          : why
      }`,
    );
    return null;
  }
  for (const loss of answer.losses ?? []) {
    host.log.warn(
      `${AI_IMPORTER_ID}: ${file.name}: ${loss.message} (${loss.count}×)`,
    );
  }
  if (!answer.placed) {
    host.log.warn(`${AI_IMPORTER_ID}: ${file.name} placed nothing`);
    return null;
  }
  return answer.root ?? null;
}

// ----------------------------------------------------------------- EPS

/** An EPS's art box from its DSC comments — `%%HiResBoundingBox` over
 *  `%%BoundingBox`, the trailer's when the header defers it with
 *  `(atend)` — as `[llx, lly, urx, ury]` in points; null when it has
 *  none. (Only the comment: the program itself is the engine's.) */
export function epsBoundingBox(
  bytes: Uint8Array,
): [number, number, number, number] | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const find = (key: string): [number, number, number, number] | null => {
    const re = new RegExp(`^%%${key}:[ \\t]*([^\\r\\n]*)`, "gm");
    let found: [number, number, number, number] | null = null;
    for (const m of text.matchAll(re)) {
      const v = m[1]!.trim().split(/\s+/).map(Number);
      if (v.length === 4 && v.every(Number.isFinite)) {
        found = [v[0]!, v[1]!, v[2]!, v[3]!];
        // The header's box wins; `(atend)` reads on to the trailer's.
        break;
      }
    }
    return found;
  };
  const box = find("HiResBoundingBox") ?? find("BoundingBox");
  if (!box || box[2] <= box[0] || box[3] <= box[1]) return null;
  return box;
}

/** The handle of the placement frame inside the batch. */
const EPS_HANDLE = "eps";

/** The batch that places `bytes` in a frame of its box at `at` (page
 *  pt), the frame unpainted. */
export function epsPlacementFor(
  pageId: string,
  bytes: Uint8Array,
  at: [number, number],
  size: [number, number],
): Mutation {
  const frame = handleElementId(EPS_HANDLE, "rectangle");
  const none = (path: "frameFillColor" | "frameStrokeColor"): Mutation => ({
    op: "setElementProperty",
    args: { elementId: frame, path, value: { type: "colorRef", value: null } },
  });
  return batchMutationFor([
    {
      op: "insertFrame",
      args: {
        pageId,
        bounds: [at[1], at[0], at[1] + size[1], at[0] + size[0]],
      },
    },
    bindCreatedMutationFor(EPS_HANDLE),
    none("frameFillColor"),
    none("frameStrokeColor"),
    {
      op: "placeImage",
      args: {
        elementId: `${HANDLE_PREFIX}${EPS_HANDLE}`,
        uri: `data:application/postscript;base64,${bytesToBase64(bytes)}`,
        fit: "ContentToFrame",
      },
    },
  ]);
}

/** Import an `.eps` as editable vectors (the module header says how).
 *  Answers the minted ids — the vectors, or the placed frame when the
 *  conversion did not happen; empty when nothing landed. */
export async function importEps(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId[]> {
  const box = epsBoundingBox(file.bytes);
  if (!box) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: ${file.name} has no %%BoundingBox — not imported`,
    );
    return [];
  }
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: no target page — ${file.name} not imported`,
    );
    return [];
  }
  const size: [number, number] = [box[2] - box[0], box[3] - box[1]];
  // Centred on the page, as an SVG import lands.
  let at: [number, number] = [0, 0];
  try {
    const rows = await host.document.collection<{
      selfId?: string;
      sizePt?: [number, number];
    }>("pages");
    const page = rows.find((r) => r?.selfId === pageId)?.sizePt;
    if (page) at = [(page[0] - size[0]) / 2, (page[1] - size[1]) / 2];
  } catch {
    /* the corner, then */
  }
  const placed = await mutateMinting(
    host,
    epsPlacementFor(pageId, file.bytes, at, size),
  );
  if (!placed.outcome.applied) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: ${file.name} could not be placed — ${JSON.stringify(placed.outcome.error)}`,
    );
    return [];
  }
  const frame = mintedIds(placed)[0];
  if (
    !frame ||
    !host.supports(EXPORT_SVG_FEATURE) ||
    !host.supports(IMPORT_SVG_FEATURE)
  ) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: ${file.name} placed as PostScript artwork (the host cannot convert it to paths)`,
    );
    return frame ? [frame] : [];
  }
  const svg = await host.document.exportSvg({
    elementIds: [frame],
    region: [at[0], at[1], size[0], size[1]],
  });
  if (svg.svg === null || !/<(path|image)\b/.test(svg.svg)) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: ${file.name} placed as PostScript artwork — the engine drew no paths from it (${svg.error ?? "nothing drawn"})`,
    );
    return [frame];
  }
  for (const note of svg.report.notes) {
    host.log.warn(
      `${EPS_IMPORTER_ID}: ${file.name}: ${note.message} (${note.count}×)`,
    );
  }
  // Take the placement back: undone when it is still the last step (one
  // undo step in all), deleted otherwise.
  const seq = placed.outcome.applied ? placed.outcome.appliedSeq : undefined;
  let undone = false;
  if (seq !== undefined && host.supports("document.undoLog@1")) {
    const log = await host.document.undoLog({ limit: 1 });
    if (log.undo[log.undo.length - 1]?.appliedSeq === seq) {
      await host.document.undo();
      undone = true;
    }
  }
  if (!undone) {
    await host.document.mutate({
      op: "deleteFrame",
      args: { frameId: String(frame.id) },
    });
  }
  const { ids } = await importSvgFile(
    host,
    EPS_IMPORTER_ID,
    file.name,
    new TextEncoder().encode(svg.svg),
    { pageId, origin: at, group: true },
  );
  return ids;
}

// ---------------------------------------------------------- registration

/** Register the `.ai` and `.eps` importers (K-2). */
export function contributeVectorFileImporters(host: BundleHost): Disposable {
  const disposers: Disposable[] = [];
  if (!host.supports("contribute.importer@1")) {
    host.log.warn(
      `${AI_IMPORTER_ID}, ${EPS_IMPORTER_ID}: host predates contribute.importer@1 — not registered`,
    );
    return { dispose() {} };
  }
  disposers.push(
    host.contribute.importer({
      id: AI_IMPORTER_ID,
      title: t(M.aiTitle),
      extensions: [".ai"],
      mimeTypes: ["application/illustrator"],
      import: (file) => void importAi(host, file),
    }),
    host.contribute.importer({
      id: EPS_IMPORTER_ID,
      title: t(M.epsTitle),
      extensions: [".eps", ".epsf"],
      mimeTypes: ["application/postscript", "image/x-eps"],
      import: (file) => void importEps(host, file),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
