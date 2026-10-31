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

// Place as vectors (publish ADR 658): one page of a PDF or an Illustrator
// file into the OPEN document as native page items — paths, clip groups,
// gradients, images, text frames — in one batch and one undo step, with
// a loss report. The page is read by the mapper wasm (its hayro reader:
// paths, paints, clips, groups, masks, images, glyph outlines) and its
// text by PDFium (the editable frames, as File ▸ Open reads them); the
// mapper lowers both into an engine snippet, which `pasteElements` grafts
// on top of the target page. Converting a placed PDF frame is the same
// placement under the frame's own transform, clipped to the frame, with
// the frame deleted in the same batch.

import { defineMessages, t } from "@paged-media/strings";

import type {
  BundleHost,
  ElementId,
  MutationInput,
  MutationOutcome,
} from "@paged-media/plugin-api";

import { loadPdfMapper, type PdfMapper } from "../engine-loader";
import { extractPdfPageText } from "../pdfium";
import type { TextFrameIr } from "../ir";
import { lossLines, type LossLine } from "./losses";
import {
  refusalOf,
  type PdfInfo,
  type PlaceRequest,
  type PlaceResult,
} from "./ir";

const M = defineMessages("publish.pdfVectors", {
  noMapper: "the PDF reader is not available",
  noDocument: "no document is open",
  noPage: "the document has no page to place onto",
  pageRange: "page {page} does not exist (the file has {count})",
  refused: "the document refused the placement: {why}",
  notPlaced: "the selection is not a placed PDF or Illustrator file",
  selectOne: "select one placed PDF or Illustrator frame",
  noBytes: "the placed file's bytes are not available yet",
  scaleRange: "the scale is 1–10000 %",
});

/** How text lands. */
export type TextChoice = "frames" | "outlines";

/** `media.paged.pdf.placeVectors`' arguments (schema/place-vectors.args.json). */
export interface PlaceVectorsArgs {
  bytes: Uint8Array;
  name: string;
  /** 1-based page of the file. */
  page: number;
  /** Percent; absent = 100, shrunk to fit a page it would overhang. */
  scale?: number;
  /** Top-left on the target page, pt; absent = centred. */
  x?: number;
  y?: number;
  text?: TextChoice;
  /** The page to place on; absent = the active page. */
  pageId?: string;
}

/** What a placement did. */
export interface PlaceVectorsResult {
  placed: boolean;
  /** The pasted root (one group, or the one item the page held). */
  root: ElementId | null;
  format: "pdf" | "ai";
  pageCount: number;
  counts: PlaceResult["counts"];
  /** What could not be carried exactly, worded. */
  losses: LossLine[];
  /** Font families the document does not have that were drawn as
   *  outlines instead. */
  outlinedFonts: string[];
}

/** The mapper, or a `failed:` throw. */
async function mapper(host: BundleHost): Promise<PdfMapper> {
  const m = await loadPdfMapper(host);
  if (!m) throw new Error(`failed: ${t(M.noMapper)}`);
  return m;
}

/** What a file is, or a throw that names why it cannot be read
 *  (`aiWithoutPdf: …` for an Illustrator file without PDF content). */
export async function inspectPdf(
  host: BundleHost,
  bytes: Uint8Array,
): Promise<PdfInfo> {
  const m = await mapper(host);
  try {
    return m.inspect(bytes);
  } catch (err) {
    const r = refusalOf(err);
    throw new Error(`${r.code}: ${r.message}`);
  }
}

interface PageRow {
  selfId?: string;
  sizePt?: [number, number];
  pageOrigin?: [number, number];
}

/** Where a placement lands: the page and its size. */
async function targetPage(
  host: BundleHost,
  pageId?: string,
): Promise<{ id: string; size: [number, number] }> {
  const meta = await host.document.meta().catch(() => null);
  if (!meta) throw new Error(`failed: ${t(M.noDocument)}`);
  const rows = await host.document
    .collection<PageRow>("pages")
    .catch(() => [] as readonly PageRow[]);
  const id =
    pageId ?? meta.activePage ?? rows.find((r) => r.selfId)?.selfId ?? null;
  if (!id) throw new Error(`failed: ${t(M.noPage)}`);
  const row = rows.find((r) => r.selfId === id);
  return { id, size: row?.sizePt ?? [612, 792] };
}

/** The page's text frames from PDFium, in the page box's points; none
 *  when text lands as outlines (the outlines come from the page itself). */
async function textFrames(
  bytes: Uint8Array,
  pageIndex: number,
  text: TextChoice,
): Promise<TextFrameIr[]> {
  if (text === "outlines") return [];
  try {
    return (await extractPdfPageText(bytes, pageIndex)).frames;
  } catch {
    // No text reader: every run lands as its outlines.
    return [];
  }
}

/** The families `families` names that the document cannot resolve (the
 *  `fonts` collection's `isMissing`, which the engine derives from what
 *  its build resolved). */
async function missingFamilies(
  host: BundleHost,
  families: ReadonlySet<string>,
): Promise<string[]> {
  if (families.size === 0) return [];
  const rows = await host.document
    .collection<{ family: string; isMissing?: boolean }>("fonts")
    .catch(() => [] as readonly { family: string; isMissing?: boolean }[]);
  return rows
    .filter((r) => r.isMissing === true && families.has(r.family))
    .map((r) => r.family);
}

function familiesOf(frames: readonly TextFrameIr[]): Set<string> {
  const out = new Set<string>();
  for (const f of frames)
    for (const p of f.paragraphs)
      for (const r of p.runs) if (r.font_family) out.add(r.font_family);
  return out;
}

/** A page item's own id (an element id may also name a text range). */
function rawId(id: ElementId): string | null {
  return typeof id.id === "string" ? id.id : null;
}

/** The first element a paste minted: its root. */
function rootOf(outcome: MutationOutcome): ElementId | null {
  if (!outcome.applied) return null;
  return outcome.minted?.[0]?.element ?? outcome.createdId ?? null;
}

/** Commit `ops` (one batch = one undo step), joining `amend` when given. */
async function commit(
  host: BundleHost,
  ops: MutationInput[],
  amend?: number,
): Promise<MutationOutcome> {
  const mutation: MutationInput =
    ops.length === 1 ? ops[0]! : { op: "batch", args: { ops } };
  return amend === undefined
    ? host.document.mutate(mutation)
    : host.document.mutate(mutation, { amend });
}

/**
 * Lower the page and paste it; then, when a family the frames name turns
 * out missing in the document, put the same page back with that text as
 * outlines — amending the same undo step, so one undo still takes the
 * whole placement away.
 */
async function pasteLowered(
  host: BundleHost,
  m: PdfMapper,
  bytes: Uint8Array,
  request: PlaceRequest,
  pageId: string,
  extra: MutationInput[],
): Promise<{
  result: PlaceResult;
  root: ElementId | null;
  outlinedFonts: string[];
}> {
  let result: PlaceResult;
  try {
    result = m.place(bytes, request);
  } catch (err) {
    const r = refusalOf(err);
    throw new Error(`${r.code}: ${r.message}`);
  }
  const paste: MutationInput = {
    op: "pasteElements",
    args: { snippet: result.snippet, pageId },
  };
  const outcome = await commit(host, [paste, ...extra]);
  if (!outcome.applied) {
    throw new Error(
      `failed: ${t(M.refused, { why: JSON.stringify(outcome.error) })}`,
    );
  }
  let root = rootOf(outcome);
  const missing = await missingFamilies(
    host,
    familiesOf(request.text_frames ?? []),
  );
  const rootId = root ? rawId(root) : null;
  if (
    missing.length === 0 ||
    !rootId ||
    outcome.appliedSeq === undefined ||
    !host.supports("document.mutate.amend@1")
  ) {
    return { result, root, outlinedFonts: [] };
  }
  let again: PlaceResult;
  try {
    again = m.place(bytes, { ...request, missing_fonts: missing });
  } catch {
    return { result, root, outlinedFonts: [] };
  }
  const swap = await commit(
    host,
    [
      { op: "deleteFrame", args: { frameId: rootId } },
      { op: "pasteElements", args: { snippet: again.snippet, pageId } },
    ],
    outcome.appliedSeq,
  );
  if (!swap.applied) return { result, root, outlinedFonts: [] };
  root = rootOf(swap);
  return { result: again, root, outlinedFonts: missing };
}

/** Validate a 1-based page against the file. */
function pageIndexOf(info: PdfInfo, page: number): number {
  const count = info.pages.length;
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new Error(`invalidValue: ${t(M.pageRange, { page, count })}`);
  }
  return page - 1;
}

/** Place page `args.page` of a PDF or `.ai` onto the open document. */
export async function placeVectors(
  host: BundleHost,
  args: PlaceVectorsArgs,
): Promise<PlaceVectorsResult> {
  const m = await mapper(host);
  const info = await inspectPdf(host, args.bytes);
  const index = pageIndexOf(info, args.page);
  const page = info.pages[index]!;
  if (
    args.scale !== undefined &&
    !(Number.isFinite(args.scale) && args.scale >= 1 && args.scale <= 10000)
  ) {
    throw new Error(`invalidValue: ${t(M.scaleRange)}`);
  }
  const target = await targetPage(host, args.pageId);
  const [pw, ph] = target.size;
  // 100 %, unless the page would overhang the target page: then it fits.
  const fit = Math.min(1, pw / page.width_pt, ph / page.height_pt);
  const s = args.scale !== undefined ? args.scale / 100 : fit;
  const w = page.width_pt * s;
  const h = page.height_pt * s;
  const x = args.x ?? (pw - w) / 2;
  const y = args.y ?? (ph - h) / 2;
  const text = args.text ?? "frames";
  const request: PlaceRequest = {
    page: index,
    placement: [s, 0, 0, s, x, y],
    text_frames: await textFrames(args.bytes, index, text),
    text,
    group: true,
    name: args.name.replace(/\.(pdf|ai)$/i, ""),
  };
  const { result, root, outlinedFonts } = await pasteLowered(
    host,
    m,
    args.bytes,
    request,
    target.id,
    [],
  );
  const losses = lossLines(result.losses, info, outlinedFonts);
  return {
    placed: true,
    root,
    format: info.format,
    pageCount: info.pages.length,
    counts: result.counts,
    losses,
    outlinedFonts,
  };
}

/** `media.paged.pdf.convertPlacedToVectors`' arguments. */
export interface ConvertPlacedArgs {
  /** The frame; absent = the one selected. */
  elementId?: string;
  text?: TextChoice;
}

type Affine = [number, number, number, number, number, number];

const compose = (a: Affine, b: Affine): Affine => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const apply = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * Where a placed PDF's page box sits on the page: the frame's
 * `itemTransform` over its `links` row's `imageTransform` (the page box's
 * points → the frame's inner space), or — without one — the box
 * stretched over the frame's bounds, as the renderer draws it. Spread
 * space; `origin` (the page's top-left in its spread) is taken off.
 * Pure — exported for its spec.
 */
export function placedPdfPlacement(
  bounds: readonly [number, number, number, number],
  itemTransform: readonly number[] | null | undefined,
  imageTransform: readonly number[] | null | undefined,
  box: readonly [number, number],
  origin: readonly [number, number],
): Affine | null {
  let inner: Affine;
  if (
    Array.isArray(imageTransform) &&
    imageTransform.length === 6 &&
    imageTransform.every((v) => Number.isFinite(v))
  ) {
    inner = [...imageTransform] as Affine;
  } else {
    const [top, left, bottom, right] = bounds;
    if (!(box[0] > 0 && box[1] > 0)) return null;
    inner = [(right - left) / box[0], 0, 0, (bottom - top) / box[1], left, top];
  }
  const item: Affine =
    Array.isArray(itemTransform) && itemTransform.length === 6
      ? ([...itemTransform] as Affine)
      : [1, 0, 0, 1, 0, 0];
  const toPage: Affine = [1, 0, 0, 1, -origin[0], -origin[1]];
  return compose(toPage, compose(item, inner));
}

/** The frame's outline on the page (its bounds' corners under its
 *  transform, the page origin off): the clip the converted art keeps. */
export function frameOutline(
  bounds: readonly [number, number, number, number],
  itemTransform: readonly number[] | null | undefined,
  origin: readonly [number, number],
): [number, number][] {
  const [top, left, bottom, right] = bounds;
  const item: Affine =
    Array.isArray(itemTransform) && itemTransform.length === 6
      ? ([...itemTransform] as Affine)
      : [1, 0, 0, 1, 0, 0];
  const m = compose([1, 0, 0, 1, -origin[0], -origin[1]], item);
  return [
    apply(m, left, top),
    apply(m, right, top),
    apply(m, right, bottom),
    apply(m, left, bottom),
  ];
}

interface LinkRow {
  hostSelfId: string;
  imageTransform?: readonly number[] | null;
}

/** Convert a placed PDF or `.ai` frame into native items where it is:
 *  the frame goes, its page lands clipped to the frame — one undo step. */
export async function convertPlacedToVectors(
  host: BundleHost,
  args: ConvertPlacedArgs,
): Promise<PlaceVectorsResult> {
  const m = await mapper(host);
  let id: ElementId | null = null;
  if (args.elementId) {
    id = { kind: "rectangle", id: args.elementId } as ElementId;
  } else {
    const sel = host.selection.get();
    if (sel.length !== 1) throw new Error(`failed: ${t(M.selectOne)}`);
    id = sel[0]!;
  }
  const [geo] = await host.document.elementGeometry([id]).catch(() => []);
  if (!geo || geo.hasImage === false || !geo.pageId) {
    throw new Error(`failed: ${t(M.notPlaced)}`);
  }
  id = geo.id;
  const frameId = rawId(id);
  if (!frameId) throw new Error(`failed: ${t(M.notPlaced)}`);
  if (!host.supports("assets.images@1")) {
    throw new Error(`failed: ${t(M.noBytes)}`);
  }
  const asset = await host.assets.getPlacedImage(frameId).catch(() => null);
  if (!asset) throw new Error(`failed: ${t(M.noBytes)}`);
  let info: PdfInfo;
  try {
    info = m.inspect(asset.bytes);
  } catch (err) {
    const r = refusalOf(err);
    if (r.code === "notPdf") throw new Error(`failed: ${t(M.notPlaced)}`);
    throw new Error(`${r.code}: ${r.message}`);
  }
  // The page the frame shows (engine ADR 1003), 1-based.
  const props = await host.document.elementProperties(id).catch(() => null);
  const pdfPage = props?.entries.find((e) => e.path === "framePdfPage");
  const shown =
    pdfPage?.value?.type === "length" && typeof pdfPage.value.value === "number"
      ? pdfPage.value.value
      : 1;
  const index = Math.min(Math.max(1, Math.round(shown)), info.pages.length) - 1;
  const page = info.pages[index]!;
  const links = await host.document
    .collection<LinkRow>("links")
    .catch(() => [] as readonly LinkRow[]);
  const origin = geo.pageOrigin ?? [0, 0];
  const placement = placedPdfPlacement(
    geo.bounds,
    geo.itemTransform,
    links.find((r) => r.hostSelfId === frameId)?.imageTransform,
    [page.width_pt, page.height_pt],
    origin,
  );
  if (!placement) throw new Error(`failed: ${t(M.notPlaced)}`);
  const text = args.text ?? "frames";
  const request: PlaceRequest = {
    page: index,
    placement,
    text_frames: await textFrames(asset.bytes, index, text),
    text,
    group: true,
    clip: frameOutline(geo.bounds, geo.itemTransform, origin),
  };
  const { result, root, outlinedFonts } = await pasteLowered(
    host,
    m,
    asset.bytes,
    request,
    geo.pageId,
    [{ op: "deleteFrame", args: { frameId } }],
  );
  return {
    placed: true,
    root,
    format: info.format,
    pageCount: info.pages.length,
    counts: result.counts,
    losses: lossLines(result.losses, info, outlinedFonts),
    outlinedFonts,
  };
}
