// Data issues (data ADR 564; editor ADR 291, amended 2026-10-24): what may be
// wrong with the content the data placed — text that does not fit its frame,
// a picture missing or too coarse for its frame, a value empty or failed,
// records a flow could not place. The data door serves them (`issues`) and
// the session publishes them to the Problems panel (`host.diagnostics`).
//
// Thin, like the rest of the bundle: every fact here is either the engine's
// own output (a binding's sync state, a resolved value, the paginator's
// overflow) or a geometry read of the host (a story's frame chain, a frame's
// size). Nothing is decided about the data in TypeScript.

import type {
  BundleHost,
  DataIssue,
  Diagnostic,
  ElementId,
} from "@paged-media/plugin-api";
import { t as tr } from "@paged-media/strings";

import type { IdmlFit } from "../../data-host-model/src";
import { ISSUES } from "./messages";

/** The effective resolution (pixels per inch at the picture's size in its
 *  frame) below which a placed picture is reported. 150 ppi is the usual
 *  floor for print at reading distance: offset printing asks for 300, and
 *  under 150 the pixels start to show. A warning, not an error: a picture
 *  meant to be coarse is a choice. */
export const LOW_RESOLUTION_PPI = 150;

/** The key the session publishes its issues under (`host.diagnostics`). */
export const ISSUES_DIAGNOSTICS_KEY = "issues";

/** Text paged.data placed: a story it wrote into, or a frame whose story is
 *  read when needed. */
export interface TextTarget {
  binding: string;
  storyId?: string | null;
  frame?: string;
  record?: number;
}

/** The pixel size of a PNG, GIF or JPEG from its header, or null for any
 *  other kind (or a header that does not read). Reads no more than the
 *  header: a JPEG's markers up to its first frame. */
export function pixelSize(b: Uint8Array): [number, number] | null {
  // PNG: the IHDR chunk follows the 8-byte signature.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return [v.getUint32(16), v.getUint32(20)];
  }
  // GIF: the logical screen, little-endian.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return [b[6]! | (b[7]! << 8), b[8]! | (b[9]! << 8)];
  // JPEG: walk the markers to the first start-of-frame (SOF0–SOF15 but the
  // DHT, JPG and DAC markers C4, C8, CC).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return [(b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!];
      i += 2 + len;
    }
  }
  return null;
}

/** A picture's effective resolution in its frame (ppi), at the fit it was
 *  placed with: fitted proportionally the whole picture shows, so the
 *  longer side sets the scale; filled or stretched, the frame's side the
 *  picture is thinnest across does. Null when the frame has no size. */
export function effectivePpi(
  pixels: readonly [number, number],
  frameSizePt: readonly [number, number],
  fit: IdmlFit | undefined,
): number | null {
  const [wIn, hIn] = [frameSizePt[0] / 72, frameSizePt[1] / 72];
  if (!(wIn > 0 && hIn > 0) || !(pixels[0] > 0 && pixels[1] > 0)) return null;
  const across = pixels[0] / wIn;
  const down = pixels[1] / hIn;
  return fit === "Proportionally" || fit === "" || fit === undefined
    ? Math.max(across, down)
    : Math.min(across, down);
}

/** Overset text: every story `targets` names whose frame chain reports
 *  overflow, once per story, at the frame the text runs out of. `storyOf`
 *  finds a frame's story. A host that lays text out without fonts reports
 *  no overflow, so a one-frame story the host calls fitting is also
 *  `measure`d (the engine wraps its words at the host's advances, the rule
 *  Data Merge's overset uses). A read that fails reports nothing. */
export async function oversetIssues(
  host: BundleHost,
  targets: readonly TextTarget[],
  storyOf: (frame: string) => Promise<string | null>,
  measure?: (story: string, frame: string) => Promise<boolean>,
): Promise<DataIssue[]> {
  const byStory = new Map<string, TextTarget>();
  for (const t of targets) {
    let story = t.storyId ?? null;
    if (!story && t.frame) {
      try {
        story = await storyOf(t.frame);
      } catch {
        story = null;
      }
    }
    if (story && !byStory.has(story)) byStory.set(story, t);
  }
  const out: DataIssue[] = [];
  for (const [story, t] of byStory) {
    let links: readonly { frameId: string; overflow: boolean }[];
    try {
      links = await host.document.frameChain(story);
    } catch {
      continue;
    }
    let over = links.find((l) => l.overflow);
    if (!over && links.length === 1 && measure) {
      try {
        if (await measure(story, links[0]!.frameId)) over = links[0];
      } catch {
        // Not measurable now: the host's answer stands.
      }
    }
    if (!over) continue;
    out.push({
      kind: "overset",
      severity: "warning",
      message:
        t.record === undefined
          ? tr(ISSUES.overset, { binding: t.binding })
          : tr(ISSUES.oversetRecord, {
              binding: t.binding,
              record: t.record + 1,
            }),
      binding: t.binding,
      address: `textFrame:${over.frameId}`,
      ...(t.record === undefined ? {} : { record: t.record }),
    });
  }
  return out;
}

/** What the session knows of an image binding since its last placement. */
export interface ImageNote {
  /** The reason nothing was placed. */
  missing?: string;
  /** The placed picture's pixel size, when its bytes passed through. */
  pixels?: [number, number];
}

/** The picture issues: a missing one, or one coarser than
 *  {@link LOW_RESOLUTION_PPI} at its frame's size (`sizeOf` reads it). */
export async function imageIssues(
  notes: ReadonlyMap<string, ImageNote>,
  targetOf: (
    binding: string,
  ) => { element: ElementId; fit?: IdmlFit } | undefined,
  sizeOf: (elements: ElementId[]) => Promise<Map<string, [number, number]>>,
): Promise<DataIssue[]> {
  const out: DataIssue[] = [];
  const coarse: { binding: string; element: ElementId; fit?: IdmlFit }[] = [];
  for (const [binding, note] of notes) {
    const target = targetOf(binding);
    const address = target
      ? `${target.element.kind}:${String(target.element.id)}`
      : undefined;
    if (note.missing !== undefined) {
      out.push({
        kind: "missingAsset",
        severity: "error",
        message: tr(ISSUES.missingAsset, { binding, reason: note.missing }),
        binding,
        ...(address ? { address } : {}),
      });
    } else if (note.pixels && target) coarse.push({ binding, ...target });
  }
  if (coarse.length === 0) return out;
  let sizes: Map<string, [number, number]>;
  try {
    sizes = await sizeOf(coarse.map((c) => c.element));
  } catch {
    return out;
  }
  for (const c of coarse) {
    const size = sizes.get(String(c.element.id));
    const pixels = notes.get(c.binding)!.pixels!;
    const ppi = size ? effectivePpi(pixels, size, c.fit) : null;
    if (ppi === null || ppi >= LOW_RESOLUTION_PPI) continue;
    out.push({
      kind: "lowResolution",
      severity: "warning",
      message: tr(ISSUES.lowResolution, {
        binding: c.binding,
        ppi: Math.round(ppi),
        min: LOW_RESOLUTION_PPI,
      }),
      binding: c.binding,
      address: `${c.element.kind}:${String(c.element.id)}`,
    });
  }
  return out;
}

/** The issues as the Problems panel lists them: the page item they are in
 *  as the source (the `Diagnostic` carries no document location to jump
 *  to; the Data panel's issues line selects the items). */
export function issueDiagnostics(issues: readonly DataIssue[]): Diagnostic[] {
  return issues.map((i) => ({
    severity: i.severity,
    message: i.message,
    ...(i.address
      ? { source: i.address }
      : i.binding
        ? { source: i.binding }
        : {}),
  }));
}
