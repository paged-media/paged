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

// Writing the publication contract (editor ADR 1236): every change is one
// document change (one undo step) through the document label; a new
// contract starts from what the document is; an approval status changes
// only by an explicit action, and an approval keeps the state it approved
// as a checkpoint ("Approved", editor ADR 1234).

import type { PageSummary } from "@paged-media/client";
import {
  operationFeedbackOf,
  printOutputFacts,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { keepCheckpoint } from "../checkpoints/checkpoints";
import {
  contractMutation,
  contractOfMeta,
  type ApprovalStatus,
  type PublicationContract,
} from "./model";

const M = defineMessages("app.contractActions", {
  write: "change the publication contract",
  refused: "the engine refused the change",
  approve: "approve the publication",
  approved: "Approved: kept as the checkpoint “{name}”.",
  approvedNoCheckpoint:
    "Approved. Save the document to keep the approved state as a checkpoint.",
  checkpoint: "Approved",
});

/** Write `contract` (null: remove it). One undo step; false when refused. */
export async function writeContract(
  paged: Pick<PagedEditor, "client" | "scope">,
  contract: PublicationContract | null,
): Promise<boolean> {
  const reply = await paged.client.mutate(contractMutation(contract));
  const ok = reply.kind === "mutationApplied";
  if (!ok)
    operationFeedbackOf(paged.scope).report({
      action: t(M.write),
      outcome: "blocked",
      reason: t(M.refused),
      document: "unchanged",
      source: "paged.contract",
    });
  return ok;
}

/** A contract for the document as it is: its standard, the first page's
 *  size, its bleed, its output intent, every font available, 300 ppi,
 *  complete data, a draft approval. */
export async function contractFromDocument(
  paged: Pick<PagedEditor, "client">,
): Promise<PublicationContract> {
  const meta = await paged.client.documentMeta();
  const pages = await paged.client.collection<PageSummary>("pages");
  const print = printOutputFacts(meta);
  const first = pages[0];
  const bleed = first
    ? Math.min(
        first.bleedTopPt ?? 0,
        first.bleedLeftPt ?? 0,
        first.bleedBottomPt ?? 0,
        first.bleedRightPt ?? 0,
      )
    : 0;
  return {
    standard: print.standard,
    ...(first
      ? { page: { widthPt: first.sizePt[0], heightPt: first.sizePt[1] } }
      : {}),
    ...(bleed > 0 ? { bleedPt: bleed } : {}),
    ...(print.profileActive
      ? {
          outputIntent: {
            required: true,
            ...(print.profileName ? { profile: print.profileName } : {}),
          },
        }
      : {}),
    fonts: { available: true },
    minImagePpi: 300,
    dataComplete: true,
    approval: { status: "draft", reviewers: [] },
  };
}

/** Change the approval status: an explicit action, one undo step. An
 *  approval keeps the approved state as a checkpoint. */
export async function setApprovalStatus(
  paged: PagedEditor,
  status: ApprovalStatus,
  by: string,
): Promise<boolean> {
  const current = contractOfMeta(await paged.client.documentMeta());
  if (!current) return false;
  const next: PublicationContract = {
    ...current,
    approval: {
      ...current.approval,
      status,
      ...(by.trim() ? { by: by.trim() } : {}),
      at: Date.now(),
    },
  };
  if (!by.trim()) delete next.approval.by;
  const ok = await writeContract(paged, next);
  if (!ok || status !== "approved") return ok;
  const name = t(M.checkpoint);
  const kept = await keepCheckpoint(paged, name, "approved").then(
    () => true,
    () => false,
  );
  operationFeedbackOf(paged.scope).report({
    action: t(M.approve),
    outcome: "success",
    title: kept ? t(M.approved, { name }) : t(M.approvedNoCheckpoint),
    key: "paged.contract|approve",
    source: "paged.contract",
  });
  return true;
}
