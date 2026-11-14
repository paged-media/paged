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

// The living publication contract (editor ADR 1236; the UX strategy's
// Concept I): what a publication promises to be — its output and PDF
// standard, its page size and bleed, its colour, fonts and image
// resolution, that its data is complete, and who approved it — stored with
// the document as its own label `x-paged:contract` (PM-0018's carrier:
// undoable, kept by `.paged` and by an IDML export). PURE: the record, its
// shape check, its encoding.

import { decodeEnvelope, encodeEnvelope } from "@paged-media/helpers";

export const CONTRACT_LABEL = "x-paged:contract";
export const CONTRACT_VERSION = 1;

export type ApprovalStatus =
  "draft" | "in-review" | "approved" | "changes-requested";

export interface ContractApproval {
  status: ApprovalStatus;
  /** Who reviews it, as the team names them. */
  reviewers: string[];
  /** Who last changed the status, and when (ms since the epoch). */
  by?: string;
  at?: number;
  note?: string;
}

export interface PublicationContract {
  /** The PDF standard the output meets. */
  standard: "pdfx4" | "pdf17";
  /** The trim size every page has, pt; absent: not required. */
  page?: { widthPt: number; heightPt: number };
  /** The least bleed on every side, pt; absent: not required. */
  bleedPt?: number;
  /** The output intent must be loaded; when `profile` is given, it is
   *  that one (its name contains it). */
  outputIntent?: { required: boolean; profile?: string };
  /** No RGB picture in the publication. */
  noRgbImages?: boolean;
  /** Every font is available; `allowed`, when given, the only families. */
  fonts?: { available: boolean; allowed?: string[] };
  /** The least effective resolution of a placed picture, ppi. */
  minImagePpi?: number;
  /** Required template fields are filled and the data has no issue. */
  dataComplete?: boolean;
  approval: ContractApproval;
}

const STATUSES: readonly ApprovalStatus[] = [
  "draft",
  "in-review",
  "approved",
  "changes-requested",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const strings = (v: unknown, max = 32): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim().slice(0, 120))
        .slice(0, max)
    : [];

/** The contract of a label value, field by field (ADR 247): a field that
 *  cannot be read is left out, never guessed. Null when there is none. */
export function readContract(
  text: string | null | undefined,
): PublicationContract | null {
  const env = decodeEnvelope<unknown>(text);
  const d = env && isRecord(env.data) ? env.data : null;
  if (!d) return null;
  const out: PublicationContract = {
    standard: d.standard === "pdfx4" ? "pdfx4" : "pdf17",
    approval: { status: "draft", reviewers: [] },
  };
  if (isRecord(d.page) && positive(d.page.widthPt) && positive(d.page.heightPt))
    out.page = { widthPt: d.page.widthPt, heightPt: d.page.heightPt };
  if (
    typeof d.bleedPt === "number" &&
    Number.isFinite(d.bleedPt) &&
    d.bleedPt >= 0
  )
    out.bleedPt = d.bleedPt;
  if (
    isRecord(d.outputIntent) &&
    typeof d.outputIntent.required === "boolean"
  ) {
    out.outputIntent = { required: d.outputIntent.required };
    if (
      typeof d.outputIntent.profile === "string" &&
      d.outputIntent.profile.trim()
    )
      out.outputIntent.profile = d.outputIntent.profile.trim().slice(0, 200);
  }
  if (typeof d.noRgbImages === "boolean") out.noRgbImages = d.noRgbImages;
  if (isRecord(d.fonts) && typeof d.fonts.available === "boolean") {
    out.fonts = { available: d.fonts.available };
    const allowed = strings(d.fonts.allowed, 64);
    if (allowed.length) out.fonts.allowed = allowed;
  }
  if (positive(d.minImagePpi)) out.minImagePpi = Math.round(d.minImagePpi);
  if (typeof d.dataComplete === "boolean") out.dataComplete = d.dataComplete;
  if (isRecord(d.approval)) {
    const a = d.approval;
    out.approval = {
      status: STATUSES.includes(a.status as ApprovalStatus)
        ? (a.status as ApprovalStatus)
        : "draft",
      reviewers: strings(a.reviewers),
    };
    if (typeof a.by === "string" && a.by.trim())
      out.approval.by = a.by.trim().slice(0, 120);
    if (typeof a.at === "number" && Number.isFinite(a.at))
      out.approval.at = a.at;
    if (typeof a.note === "string" && a.note.trim())
      out.approval.note = a.note.trim().slice(0, 500);
  }
  return out;
}

/** The document's contract, from its meta's plugin metadata. */
export function contractOfMeta(
  meta: {
    pluginMetadata?: ReadonlyArray<{ key: string; value: string }>;
  } | null,
): PublicationContract | null {
  return readContract(
    meta?.pluginMetadata?.find((e) => e.key === CONTRACT_LABEL)?.value ?? null,
  );
}

/** The mutation that writes `contract` (null: removes it). One undo step. */
export function contractMutation(contract: PublicationContract | null): {
  op: "setDocumentMetadata";
  args: { key: string; value: string | null };
} {
  return {
    op: "setDocumentMetadata",
    args: {
      key: CONTRACT_LABEL,
      value: contract ? encodeEnvelope(contract, CONTRACT_VERSION) : null,
    },
  };
}
