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

// The replace question (ADR 230): Save, Don't save, Cancel, asked before
// anything replaces a document with unsaved edits. Renders the queue the
// one guard (`state/replace-guard.ts`) fills; while this is mounted the
// guard asks here instead of through the platform's `confirm`.
//
// Escape, the backdrop and Cancel keep the document. Keys pressed inside
// the prompt stay inside it, so a window shortcut (Tab's chrome toggle, a
// tool letter) cannot act on the canvas behind a modal question.

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { useOptionalDocument } from "../state/document-context";
import {
  attachReplacePromptSurface,
  replacePrompts,
  type PendingReplace,
} from "../state/replace-guard";

export function ReplaceDocumentPrompt() {
  useEffect(() => attachReplacePromptSurface(), []);
  const pending = useSyncExternalStore(
    replacePrompts.subscribe,
    replacePrompts.current,
    replacePrompts.current,
  );
  const sourceName = useOptionalDocument()?.sourceName ?? null;
  return pending ? (
    <ReplaceQuestion key={pending.id} pending={pending} openName={sourceName} />
  ) : null;
}

function ReplaceQuestion({
  pending,
  openName,
}: {
  pending: PendingReplace;
  openName: string | null;
}) {
  const title = openName
    ? `Save changes to “${openName}” first?`
    : "Save changes to this document first?";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) pending.answer("cancel");
      }}
    >
      <DialogContent
        role="alertdialog"
        data-testid="replace-document-dialog"
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          // The default answer is Save when there is one, else Cancel —
          // never Don't save, which Radix would pick as the first button.
          const root = e.currentTarget as HTMLElement;
          const target =
            root.querySelector<HTMLElement>(
              '[data-testid="replace-document-save"]',
            ) ??
            root.querySelector<HTMLElement>(
              '[data-testid="replace-document-keep"]',
            );
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        onKeyDown={(e) => {
          // Radix runs its own Escape and Tab handling on this element;
          // stopping here keeps the window's shortcut listeners out.
          e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription data-testid="replace-document-body">
            {pending.requester ? (
              <>
                <strong data-testid="replace-document-requester">
                  {pending.requester}
                </strong>{" "}
                wants to open{" "}
                <strong data-testid="replace-document-name">
                  {pending.documentName ?? "a document"}
                </strong>{" "}
                in place of this document.
              </>
            ) : (
              <>
                {pending.action} replaces this document
                {pending.documentName ? (
                  <>
                    {" "}
                    with{" "}
                    <strong data-testid="replace-document-name">
                      {pending.documentName}
                    </strong>
                  </>
                ) : null}
                .
              </>
            )}{" "}
            It has unsaved edits; if you don’t save, they are lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            data-testid="replace-document-discard"
            onClick={() => pending.answer("discard")}
          >
            Don’t save
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="replace-document-keep"
              onClick={() => pending.answer("cancel")}
            >
              Cancel
            </Button>
            {pending.canSave && (
              <Button
                type="button"
                data-testid="replace-document-save"
                onClick={() => pending.answer("save")}
              >
                Save
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
