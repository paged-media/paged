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

// The PDF EXPORT door (`host.documents.exportPdf`, `documents.exportPdf@1`):
// the engine's export session driven to its end. One loop for every host
// the SDK builds: a bundle (paged.publish's typed commands) and the headless
// harness's `exportDocument("pdf")` both run it. The session is begin → one
// `exportPdfPage` per page → finish; a failure, an abort or an unexpected
// reply cancels it, so no writer state is left in the engine.

import type {
  ExportPdfWireOptions,
  MainToWorkerKind,
  PdfExportHooks,
  PdfExportResult,
  PreflightFinding,
  WorkerToMain,
} from "@paged-media/plugin-api";

/** The engine round trip the loop runs on (`editor.client.send`). */
export type EngineSend = (message: MainToWorkerKind) => Promise<WorkerToMain>;

function failure(reply: WorkerToMain): Error {
  return new Error(
    reply.kind === "exportPdfFailed"
      ? String(reply.payload.error)
      : `unexpected reply: ${reply.kind}`,
  );
}

/** Export the engine's active document to PDF. Rejects with the engine's
 *  error, or with an `AbortError` when `hooks.signal` aborts. */
export async function exportPdfSession(
  send: EngineSend,
  options: ExportPdfWireOptions,
  hooks?: PdfExportHooks,
): Promise<PdfExportResult> {
  const begun = await send({ kind: "exportPdfBegin", payload: { options } });
  if (begun.kind !== "exportPdfBegun") throw failure(begun);
  const { session, pageCount } = begun.payload;
  try {
    hooks?.onProgress?.(0, pageCount);
    for (let i = 0; i < pageCount; i++) {
      if (hooks?.signal?.aborted)
        throw new DOMException("export cancelled", "AbortError");
      const step = await send({ kind: "exportPdfPage", payload: { session } });
      if (step.kind !== "exportPdfProgress") throw failure(step);
      hooks?.onProgress?.(step.payload.done, step.payload.total);
    }
    const done = await send({ kind: "exportPdfFinish", payload: { session } });
    if (done.kind !== "pdfExported") throw failure(done);
    return {
      bytes: Uint8Array.from(done.payload.pdfBytes),
      pageCount,
      findings: (done.payload.findings ?? []) as PreflightFinding[],
      diagnostics: done.payload.diagnostics,
    };
  } catch (err) {
    await send({ kind: "exportPdfCancel", payload: { session } }).catch(
      () => undefined,
    );
    throw err;
  }
}
