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

// Standalone open (thoughts ADR 029): a Word document becomes the WHOLE
// document, not content in a frame. The engine's skeleton (docx-skeleton, a
// native `.paged` document built with the engine's model crates, ADR 606)
// gives each Word section a page of its size, its margin box as the frame,
// and an empty story. After opening, each story gets a grow rule on the
// wire (`setFlowGrowRule`, protocol 64): the engine then adds
// pages while the story oversets, matching Word's own pagination (measured
// against Word's PDF export of docx_conformance::pagination_docx()). This
// file opens that skeleton, sets the rules, and pours each section's blocks
// into its story with the shared pour.

import type {
  LoweredDoc,
  LoweredSection,
  LoweredSectionMasters,
} from "@paged-media/doc-host-model";
import {
  buildStoryBlocks,
  buildStyleMutations,
  noteTexts,
  sectionBlocks,
} from "@paged-media/doc-host-model";
import type { BundleHost, ElementId, Mutation } from "@paged-media/plugin-api";
import { refusalText } from "@paged-media/panel-kit";
import { t } from "@paged-media/strings";

import type { DocEngine } from "./engine.js";
import { DOC } from "./messages.js";
import { pourPageItems } from "./page-items.js";
import { applyStyleOpsReporting, pourSteps } from "./pour.js";

/** What a standalone open produced: the section stories (save-back reads
 *  them back in this order), the frame carrying the binding, the lowering
 *  that was poured, and whether it uses span/split columns (save-back must
 *  lower the same way, `DocEngine.setMidPageColumns`). */
export interface Opened {
  storyIds: string[];
  frameId: ElementId;
  ir: LoweredDoc;
  midPageColumns: boolean;
}

/** Diagnostics key for what standalone open could not do on this engine. */
export const OPEN_DIAGNOSTICS_KEY = "media.paged.doc/open";

/** Diagnostics key for the mid-page column fallback (ADR 029). */
export const COLUMNS_DIAGNOSTICS_KEY = "media.paged.doc/columns";

/** The span/split column paths (core protocol 64, ADR 028 addendum) a
 *  mid-page column change lowers to. An engine that refuses any of them
 *  cannot lay the lowering out. */
export const SPAN_COLUMN_PATHS: readonly string[] = [
  "paragraphSpanColumnType",
  "paragraphSpanSplitColumnCount",
  "paragraphSplitColumnInsideGutter",
  "paragraphSplitColumnOutsideGutter",
];

/**
 * The protocol-64 grow rule for one section story (thoughts ADR 026/029):
 * generated pages after the story's last frame while it oversets, keeping
 * the section frame's options (`LeadingOffset`, zero insets, columns) —
 * Word's line-box fit on every page. Typed by the plugin-api canary's
 * vendored v64 wire (0.2.37-canary.0), so no cast.
 */
export function growRuleOp(
  storyId: string,
  section?: Pick<LoweredSection, "masters" | "sectionStart">,
): Mutation {
  // Doc ADR 611 — the masters the story's pages take and its odd/even
  // start (engine ADR 1022), when the Word section has them.
  const m: LoweredSectionMasters = section?.masters ?? {};
  return {
    op: "setFlowGrowRule",
    args: {
      storyId,
      grow: true,
      maxPages: null,
      copyFrameOptions: true,
      ...(m.master ? { master: m.master } : {}),
      ...(m.firstMaster ? { firstMaster: m.firstMaster } : {}),
      ...(m.evenMaster ? { evenMaster: m.evenMaster } : {}),
      ...(section?.sectionStart && section.sectionStart !== "newPage"
        ? { sectionStart: section.sectionStart }
        : {}),
    },
  };
}

/** The section that opens each native story, in story order (the one
 *  whose masters and start the story's grow rule takes). */
export function storySections(ir: LoweredDoc): LoweredSection[] {
  const out: LoweredSection[] = [];
  for (const s of ir.sections ?? [ir.section]) {
    const k = s.story ?? 0;
    if (out[k] === undefined) out[k] = s;
  }
  return out;
}

/**
 * Set every section story's grow rule: one batch (one rebuild), op by op if
 * the batch is refused. An engine without the op (before protocol 64)
 * refuses it; the document stays open, it just does not grow, and the
 * refusal is reported (ADR-007). Returns the story ids that refused.
 */
export async function setGrowRules(
  host: BundleHost,
  storyIds: readonly string[],
  sections: readonly (LoweredSection | undefined)[] = [],
): Promise<string[]> {
  if (storyIds.length === 0) return [];
  const ops = storyIds.map((id, k) => growRuleOp(id, sections[k]));
  const refused: string[] = [];
  let error: unknown = null;
  const whole = await host.document.mutate({
    op: "batch",
    args: { ops },
  } as Mutation);
  if (!whole.applied) {
    for (let k = 0; k < ops.length; k++) {
      const one = await host.document.mutate(ops[k]);
      if (!one.applied) {
        refused.push(storyIds[k]);
        error ??= one.error;
      }
    }
  }
  host.diagnostics.set(
    OPEN_DIAGNOSTICS_KEY,
    refused.length === 0
      ? []
      : [
          {
            severity: "warning" as const,
            message: t(DOC.cannotGrow, {
              refused: refused.length,
              total: storyIds.length,
              reason: error == null ? "" : refusalText(error),
            }),
          },
        ],
  );
  return refused;
}

/** True when this host can open a native document (the standalone path). */
export function canOpenStandalone(host: BundleHost): boolean {
  return host.supports("document.openNative@1");
}

/**
 * Open `ir` (lowered from `source` by `engine`) as the active document.
 * Returns `null` when the host has no native-open door; the caller then
 * places the document embedded instead.
 */
export async function openStandalone(
  host: BundleHost,
  engine: DocEngine,
  ir: LoweredDoc,
  source: Uint8Array,
  name: string,
): Promise<Opened | null> {
  if (!canOpenStandalone(host)) return null;
  const open = (paged: Uint8Array) => host.nativeDocument.open(paged);
  await open(engine.skeletonPaged(name));
  return finishStandalone(host, engine, ir, source, name, open);
}

/**
 * Everything after the skeleton is open: styles (re-opening the skeleton
 * lowered without span/split columns when the engine refuses them), grow
 * rules, the pour, and the persisted state — the source part plus the label
 * on the section frame. `open` loads a `.paged` package as the document (the
 * host's native open; a headless host's direct load), used only for that
 * column fallback.
 */
export async function finishStandalone(
  host: BundleHost,
  engine: DocEngine,
  ir: LoweredDoc,
  source: Uint8Array,
  name: string,
  open: (paged: Uint8Array) => Promise<unknown>,
): Promise<Opened> {
  let storyIds = engine.skeletonStories();
  let midPageColumns = engine.usesMidPageColumns();
  const refusals = await applyStyleOpsReporting(host, buildStyleMutations(ir));
  if (midPageColumns && SPAN_COLUMN_PATHS.some((p) => refusals.paths.has(p))) {
    engine.setMidPageColumns(false);
    midPageColumns = false;
    ir = engine.lowered();
    storyIds = engine.skeletonStories();
    await open(engine.skeletonPaged(name));
    await applyStyleOpsReporting(host, buildStyleMutations(ir));
    host.diagnostics.set(COLUMNS_DIAGNOSTICS_KEY, [
      {
        severity: "warning" as const,
        message: t(DOC.cannotChangeColumns),
      },
    ]);
  } else {
    host.diagnostics.set(COLUMNS_DIAGNOSTICS_KEY, []);
  }

  await setGrowRules(host, storyIds, storySections(ir));

  // Doc ADR 611 — notes are placed at their references in the body.
  const notes = noteTexts(ir);
  const groups = sectionBlocks(ir);
  for (let k = 0; k < groups.length && k < storyIds.length; k++) {
    await pourSteps(host, buildStoryBlocks(groups[k], storyIds[k], { notes }));
  }
  await pourHeadersFooters(host, ir);
  await pourPageItems(host, ir);
  await setFootnoteOptions(host, ir);

  const frameId: ElementId = { kind: "textFrame", id: "docx_f0" };
  const partPath = `${storyIds[0] ?? "docx"}/source.docx`;
  try {
    await host.parts.write(partPath, source);
    await host.document.setMetadata(frameId, {
      v: 1,
      data: {
        part: partPath,
        blocks: ir.story.blocks.length,
        sections: storyIds,
        fileName: name,
        midPageColumns,
        tableParagraphs: true,
      },
    });
  } catch (err) {
    host.log.warn(`paged.doc: could not persist source part: ${String(err)}`);
  }
  return { storyIds, frameId, ir, midPageColumns };
}

/**
 * Doc ADR 611 — pour every master's header and footer story with the part
 * it shows (the skeleton wrote the masters, their frames and the empty
 * stories). A part on several masters is poured into each.
 */
export async function pourHeadersFooters(
  host: BundleHost,
  ir: LoweredDoc,
): Promise<void> {
  const parts = ir.headerFooterParts ?? [];
  for (const m of ir.masters ?? []) {
    for (const f of [m.header, m.footer]) {
      const part = f ? parts[f.part] : undefined;
      if (!f || !part) continue;
      const blocks = part.paragraphs.map((p) => ({
        kind: "paragraph" as const,
        ...p,
      }));
      await pourSteps(host, buildStoryBlocks(blocks, f.storyId));
    }
  }
}

/** Word's footnote number formats as the engine's numbering styles. */
const NOTE_STYLES: Record<string, string> = {
  lowerRoman: "LowerRoman",
  upperRoman: "UpperRoman",
  lowerLetter: "LowerLetters",
  upperLetter: "UpperLetters",
  chicago: "Asterisks",
};

/** Word's `w:numRestart` as the engine's footnote restart. */
const NOTE_RESTARTS: Record<string, string> = {
  continuous: "DontRestart",
  eachSect: "SectionRestart",
  eachPage: "PageRestart",
};

/**
 * Doc ADR 611 — the document's footnote numbering from the first section's
 * `w:footnotePr` (the engine's options are document-wide; ADR 034 decision
 * 4: other sections' differing options are a diagnostic of the lowering).
 * Refusals change nothing.
 */
export async function setFootnoteOptions(
  host: BundleHost,
  ir: LoweredDoc,
): Promise<void> {
  if (!(ir.notes ?? []).some((n) => !n.endnote)) return;
  const n = (ir.sections ?? [ir.section])[0]?.footnoteNumbering;
  if (!n) return;
  const ops: Mutation[] = [];
  const set = (path: string, value: unknown) =>
    ops.push({ op: "set", args: { address: "doc", path, value } } as Mutation);
  if (n.numFmt && NOTE_STYLES[n.numFmt]) {
    set("documentFootnoteNumberingStyle", {
      type: "text",
      value: NOTE_STYLES[n.numFmt],
    });
  }
  if (n.numStart != null && n.numStart >= 1) {
    set("documentFootnoteStartAt", { type: "length", value: n.numStart });
  }
  if (n.numRestart && NOTE_RESTARTS[n.numRestart]) {
    set("documentFootnoteRestartNumbering", {
      type: "text",
      value: NOTE_RESTARTS[n.numRestart],
    });
  }
  if (ops.length === 0) return;
  const r = await host.document.mutate({
    op: "batch",
    args: { ops },
  } as Mutation);
  if (!r.applied) {
    for (const op of ops) await host.document.mutate(op);
  }
}
