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

// Place as vectors (publish ADR 658) — the TypeScript twin of the Rust
// crate's `vectors::ir::PdfInfo` and `snippet::{PlaceRequest,
// PlaceResult}`: the JSON the mapper wasm's `pdf_inspect_wasm` and
// `pdf_place_wasm` answer and take. The two sides move together.

import type { TextFrameIr } from "../ir";

/** One page's size in points (its crop box). */
export interface PageInfo {
  width_pt: number;
  height_pt: number;
}

/** What an Illustrator file is, as far as the reader can tell. */
export interface AiInfo {
  pdf_compatible: boolean;
  /** Illustrator's own data is present; it is never parsed. */
  has_private_data: boolean;
  creator?: string;
}

/** What a file is: its pages, and for an `.ai` how it reads. */
export interface PdfInfo {
  format: "pdf" | "ai";
  pages: PageInfo[];
  ai?: AiInfo;
}

/** The request `pdf_place_wasm` takes. */
export interface PlaceRequest {
  /** 0-based page. */
  page: number;
  page_box?: "crop" | "media" | "trim" | "bleed" | "art";
  /** Page-box points (top-left, y down) → target page coordinates. */
  placement: [number, number, number, number, number, number];
  text_frames?: TextFrameIr[];
  missing_fonts?: string[];
  text?: "frames" | "outlines";
  group?: boolean;
  name?: string;
  /** Clip what lands to this outline (target page coordinates). */
  clip?: [number, number][];
  sample_ppi?: number;
}

/** How many of each kind a placement made. */
export interface PlaceCounts {
  paths: number;
  images: number;
  groups: number;
  clip_groups: number;
  text_frames: number;
  opacity_masks: number;
  gradients: number;
  colors: number;
}

/** One kind of loss on the page, with how often it happened. */
export interface LossIr {
  code: string;
  count: number;
}

/** What `pdf_place_wasm` answers. */
export interface PlaceResult {
  /** The engine snippet (`pasteElements`' `snippet`). */
  snippet: string;
  width_pt: number;
  height_pt: number;
  /** `[top, left, bottom, right]`, target page coordinates. */
  bounds: [number, number, number, number];
  counts: PlaceCounts;
  losses: LossIr[];
}

/** A refusal the mapper throws: `"<code>: <message>"`. */
export interface ReadRefusal {
  code:
    | "notPdf"
    | "aiWithoutPdf"
    | "unreadable"
    | "noSuchPage"
    | "empty"
    | "invalidRequest"
    | string;
  message: string;
}

/** Split a mapper error (`"<code>: <message>"`) into its parts. */
export function refusalOf(err: unknown): ReadRefusal {
  const text = err instanceof Error ? err.message : String(err);
  const m = /^([A-Za-z]+): (.*)$/s.exec(text);
  return m
    ? { code: m[1]!, message: m[2]! }
    : { code: "unreadable", message: text };
}
