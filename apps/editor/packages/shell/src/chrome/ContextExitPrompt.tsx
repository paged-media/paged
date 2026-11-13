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

// The resolve prompt of the one exit resolver (editor ADR 1212, D-04):
// leaving an edit context that holds unfinished work, when its module
// asks to be asked, puts this small question up — Keep changes (commit),
// Discard changes (cancel), Cancel (stay in the context). Escape, the
// backdrop and Cancel keep the context: the safe answer is the one an
// unacknowledged prompt gets. Renders the queue `state/context-exit.ts`
// fills; while it is mounted the question is asked here.

import { useEffect, useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  attachContextExitPromptSurface,
  contextExitPrompts,
  type PendingContextExit,
} from "../state/context-exit";
import { useEditorScope } from "../state/editor-scope";
import { CONTEXT_EXIT } from "./messages";

export function ContextExitPrompt() {
  const scope = useEditorScope();
  useEffect(() => attachContextExitPromptSurface(scope), [scope]);
  const prompts = contextExitPrompts(scope);
  const pending = useSyncExternalStore(
    prompts.subscribe,
    prompts.current,
    prompts.current,
  );
  return pending ? (
    <ContextExitQuestion key={pending.id} pending={pending} />
  ) : null;
}

function ContextExitQuestion({ pending }: { pending: PendingContextExit }) {
  const strings = useStrings();
  const params = { label: pending.label };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) pending.answer("cancel");
      }}
    >
      <DialogContent
        role="alertdialog"
        data-testid="context-exit-dialog"
        data-context-exit-reason={pending.reason}
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          // The default answer keeps the work: Keep changes, never
          // Discard, which Radix would pick as the first button.
          const root = e.currentTarget as HTMLElement;
          const target = root.querySelector<HTMLElement>(
            '[data-testid="context-exit-commit"]',
          );
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        onKeyDown={(e) => {
          // Radix runs its own Escape and Tab handling on this element;
          // stopping here keeps the window's shortcut listeners (and the
          // context's own keys) out of a modal question.
          e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{strings.t(CONTEXT_EXIT.title, params)}</DialogTitle>
          <DialogDescription data-testid="context-exit-body">
            {strings.t(
              pending.reason === "document-switch"
                ? CONTEXT_EXIT.bodyDocument
                : CONTEXT_EXIT.body,
              params,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            data-testid="context-exit-discard"
            onClick={() => pending.answer("discard")}
          >
            {strings.t(CONTEXT_EXIT.discard)}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="context-exit-cancel"
              onClick={() => pending.answer("cancel")}
            >
              {strings.t(CONTEXT_EXIT.cancel)}
            </Button>
            <Button
              type="button"
              data-testid="context-exit-commit"
              onClick={() => pending.answer("commit")}
            >
              {strings.t(CONTEXT_EXIT.commit)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
