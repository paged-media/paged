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

// THE RAW WIRE — the ONE place this bundle goes through the marked escape
// hatch `host.editor.client.send` (DESIGN.md §4.9). The hatch is a v0
// member that does not survive the isolate boundary, so every read that
// still needs it is a FACADE GAP, and gaps are easier to close when they
// are counted in one file:
//
//   · `requestNearestPathPoint` — the Measure tool's snap (RFI K-14: no
//     `document.nearestPathPoint` facade);
//   · `requestGradientDetail` — a gradient swatch's STOPS, which the
//     annotator's on-canvas stop markers draw and edit (no
//     `document.gradientDetail` facade; `collection("gradients")` lists
//     a swatch's id, name and kind and nothing about its stops);
//   · `requestTextOutlines` — a text frame's glyphs as outlines, for
//     Create Outlines (protocol 66, RFI C-69; no facade yet).
//
// GUARDED, so a gap never becomes a crash: a host whose handle has no
// `send` (an isolate, a stub), a send that throws or rejects, and a reply
// of the wrong kind all answer NULL, and the caller degrades exactly as
// it would on a host that said "no". Nothing here writes — the hatch is
// used for READS only; every write goes through `host.document.mutate`.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

/** The request kinds this bundle sends raw — the facade gaps, named. */
export type RawRequest =
  | { kind: "requestNearestPathPoint"; payload: { id: ElementId; point: [number, number] } }
  | { kind: "requestGradientDetail"; payload: { gradientId: string } }
  | { kind: "requestTextOutlines"; payload: { id: ElementId } };

/** The reply kind each request expects. */
const REPLY_KIND: Record<RawRequest["kind"], string> = {
  requestNearestPathPoint: "nearestPathPoint",
  requestGradientDetail: "gradientDetailReply",
  requestTextOutlines: "textOutlines",
};

/** Does this host carry the hatch at all? */
export function hasRawWire(host: BundleHost): boolean {
  const client = (host as { editor?: { client?: { send?: unknown } } }).editor?.client;
  return typeof client?.send === "function";
}

/**
 * Send one READ through the hatch and answer the reply's `payload`, or
 * null when the host has no hatch, the send fails, or the reply is not
 * the kind this request expects.
 */
export async function rawRead(host: BundleHost, request: RawRequest): Promise<unknown> {
  if (!hasRawWire(host)) return null;
  try {
    // `requestTextOutlines` is protocol-AHEAD of the installed wire types
    // (protocol 66; the pinned canvas-wasm is 64), so the request is
    // widened to the send's parameter here, in the one place the hatch
    // is called. An older engine answers it with an error reply, which
    // the reply-kind check below turns into null.
    type SendArg = Parameters<BundleHost["editor"]["client"]["send"]>[0];
    const reply = (await host.editor.client.send(request as unknown as SendArg)) as {
      kind?: string;
      payload?: unknown;
    } | null;
    if (!reply || reply.kind !== REPLY_KIND[request.kind]) return null;
    return reply.payload ?? null;
  } catch {
    return null;
  }
}

/** `requestNearestPathPoint`'s answer — typed HERE because plugin-api's
 *  curated wire subset does not carry `NearestPathPointResult`. */
export interface NearestPathPointWire {
  segStart: number;
  segEnd: number;
  t: number;
  point: [number, number];
  distance: number;
}

/** The nearest point on `id`'s path to `point` (both in the element's
 *  OWN space), or null. */
export async function rawNearestPathPoint(
  host: BundleHost,
  id: ElementId,
  point: [number, number],
): Promise<NearestPathPointWire | null> {
  const payload = (await rawRead(host, {
    kind: "requestNearestPathPoint",
    payload: { id, point },
  })) as { result?: NearestPathPointWire | null } | null;
  return payload?.result ?? null;
}

/** One stop of a gradient swatch as the engine resolves it — typed HERE
 *  for the same reason (`GradientDetail` is not in the curated subset). */
export interface GradientStopWire {
  stopColorRef: string;
  resolvedRgbHex: string;
  locationPct: number;
  midpointPct: number | null;
}

/** A gradient swatch's full detail: `kind` is `"linear"` / `"radial"` /
 *  `"unknown"` (lower-case, unlike the `GradientSpec` a write takes). */
export interface GradientDetailWire {
  selfId: string;
  name: string;
  kind: string;
  stops: GradientStopWire[];
}

/** `gradientId`'s stops, or null. */
export async function rawGradientDetail(
  host: BundleHost,
  gradientId: string,
): Promise<GradientDetailWire | null> {
  const payload = (await rawRead(host, {
    kind: "requestGradientDetail",
    payload: { gradientId },
  })) as { result?: GradientDetailWire | null } | null;
  const result = payload?.result ?? null;
  return result && Array.isArray(result.stops) ? result : null;
}

/** `requestTextOutlines`' answer (protocol 66) — typed HERE until the
 *  curated wire subset carries `TextOutlinesResult`. Page space; one run
 *  per fill colour; `rgb` / `cmyk` are 0..1. */
export interface TextOutlinesWire {
  id: ElementId;
  pageId: string;
  runs: {
    rgb: [number, number, number];
    cmyk?: [number, number, number, number] | null;
    anchors: { anchor: [number, number]; left: [number, number]; right: [number, number] }[];
    subpathStarts: number[];
    glyphs: number;
  }[];
  skippedGlyphs: number;
}

/** `id`'s glyph outlines, or null (not a text frame, or an engine older
 *  than protocol 66 — which answers an unknown request kind with an
 *  error reply, not `textOutlines`). */
export async function rawTextOutlines(
  host: BundleHost,
  id: ElementId,
): Promise<TextOutlinesWire | null> {
  const payload = (await rawRead(host, {
    kind: "requestTextOutlines",
    payload: { id },
  })) as { result?: TextOutlinesWire | null } | null;
  return payload?.result ?? null;
}
