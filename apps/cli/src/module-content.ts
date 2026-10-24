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

// Module content a headless session cannot draw as the editor does (editor
// plan G4, "headless rendering of module content"). Two cases:
//
//   · a web frame's rendering is session state (a scene layer), never part
//     of the document, so a PDF written here would show the empty frame.
//     Before a PDF is written, every web frame is baked to native items
//     through paged.web's typed `bakeWebFrame` (a flow's primary frame
//     bakes its chain), and the bake's own undo steps are taken back once
//     the PDF is written, so the session (a later save, a batch that undoes
//     back to its template) is as it was;
//   · an object a module marks `pending` (paged.image's edited picture
//     whose composite needs a GPU realm) still shows an older picture. It
//     is reported, loudly: in the export's diagnostics, by
//     `template check`, and `template fill -o x.pdf` refuses to write it.

import type { CliSession } from "./session";

/** paged.web's typed bake of one web frame (or its flow's chain). */
export const WEB_BAKE = "media.paged.web.command.bakeWebFrame";

/** The module objects whose `pending` row reads true: what a headless PDF
 *  draws as an older picture. Addresses, in kind order. */
export async function pendingContent(
  s: Pick<CliSession, "h">,
): Promise<string[]> {
  const out: string[] = [];
  const kinds = (await s.h.objects.kinds()).filter((k) => k.owner !== "core");
  for (const k of kinds) {
    let addresses: readonly string[] = [];
    try {
      addresses = await s.h.objects.query(k.kind);
    } catch {
      continue;
    }
    if (addresses.length === 0) continue;
    const rows = await s.h.objects.schema(addresses[0]!);
    if (!rows.some((r) => r.path === "pending")) continue;
    for (const a of addresses) {
      const v = await s.h.objects.get(a, "pending");
      if (v.kind === "value" && v.value === true) out.push(a);
    }
  }
  return out;
}

/** One diagnostic line per pending object. */
export const pendingLine = (address: string): string =>
  `pending ${address}: drawn as its last composite; this content needs a GPU host to render (open the document in the editor and save, then export)`;

/**
 * Run `write` (which writes a PDF) with every web frame baked to native
 * items first, then take the bake's steps back. Answers what `write`
 * answered and the notes to report: the frames baked, a bake's own
 * diagnostics, and the pending objects. Without paged.web loaded nothing is
 * baked.
 */
export async function withModuleContentDrawn<T>(
  s: Pick<CliSession, "h" | "driver">,
  write: () => Promise<T>,
): Promise<{ value: T; notes: string[] }> {
  const notes = (await pendingContent(s)).map(pendingLine);
  const commands = await s.h.objects.commands();
  if (!commands.some((c) => c.id === WEB_BAKE))
    return { value: await write(), notes };
  const kind = (await s.h.objects.kinds()).find(
    (k) => k.owner === "media.paged.web" && k.kind.endsWith("/webFrame"),
  );
  const frames = kind ? await s.h.objects.query(kind.kind) : [];
  if (frames.length === 0) return { value: await write(), notes };
  // The steps the bake commits, counted as they land (an amended step
  // counts once), so exactly those are undone.
  const steps = new Set<number | string>();
  let unnumbered = 0;
  const sub = s.driver.document.onDidChange((e) => {
    if (e.kind !== "mutationApplied") return;
    if (e.appliedSeq === undefined) unnumbered += 1;
    else steps.add(e.appliedSeq);
  });
  let baked = 0;
  try {
    for (const frame of frames) {
      const r = (await s.h.objects.invoke(WEB_BAKE, { frame })) as {
        baked?: boolean;
        diagnostics?: string[];
      } | null;
      if (r?.baked) baked += 1;
      for (const d of r?.diagnostics ?? []) notes.push(`${frame}: ${d}`);
    }
  } catch (err) {
    notes.push(`web frames not baked: ${(err as Error).message}`);
  } finally {
    sub.dispose();
  }
  // The document's change events may trail the command's reply by a tick.
  await new Promise((r) => setTimeout(r, 0));
  try {
    if (baked > 0)
      notes.unshift(`baked ${baked} web frame(s) to native items for the PDF`);
    return { value: await write(), notes };
  } finally {
    const undo = steps.size + unnumbered;
    for (let u = 0; u < undo; u++) await s.driver.document.undo();
  }
}
