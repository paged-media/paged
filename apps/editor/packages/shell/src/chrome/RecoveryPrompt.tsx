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

// The recovery prompt (editor ADR 1204; the UX strategy's §6.2; UX audit
// F-06): after the editor closed with unsaved work — a crash, a reload, a
// closed tab — it offers the journal's copy back. Restore recovered work,
// Compare with the saved version, Discard the recovered copy, or Not now
// (Escape: the copy stays and is offered at the next start). Restoring
// opens the copy as a new document and never writes over the saved version
// (UXI-MUT-010).

import type { RecoveryCheckpoint } from "@paged-media/repository";
import { useState, useSyncExternalStore } from "react";
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
import { useEditorScope, type EditorScope } from "../state/editor-scope";
import { getLibrary } from "../state/library-document";
import { RECOVERY } from "../state/messages";
import { useOptionalPaged } from "../state/paged-editor";
import {
  discardCheckpoint,
  postponeCheckpoint,
  recoveryOffers,
  restoreCheckpoint,
  savedVersionOf,
  type SavedVersion,
} from "../state/recovery";
import { RECOVERY_PROMPT } from "./messages";

export interface RecoveryPromptProps {
  /** Where a restore reports its progress and failures (the shell's
   *  status and warnings). */
  sinks: { setStatus: (s: string) => void; pushWarning: (w: string) => void };
}

export function RecoveryPrompt({ sinks }: RecoveryPromptProps) {
  const scope = useEditorScope();
  const offers = recoveryOffers(scope);
  const current = useSyncExternalStore(
    offers.subscribe,
    offers.current,
    offers.current,
  );
  return current ? (
    <RecoveryQuestion
      key={`${current.session}:${current.seq}`}
      scope={scope}
      checkpoint={current}
      sinks={sinks}
    />
  ) : null;
}

function RecoveryQuestion({
  scope,
  checkpoint,
  sinks,
}: {
  scope: EditorScope;
  checkpoint: RecoveryCheckpoint;
  sinks: RecoveryPromptProps["sinks"];
}) {
  const strings = useStrings();
  const paged = useOptionalPaged();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedVersion | null>(null);
  const [comparing, setComparing] = useState(false);
  const time = (at: number) =>
    new Date(at).toLocaleString(strings.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const name = checkpoint.document.name;
  const compare = () => {
    if (comparing) {
      setComparing(false);
      return;
    }
    setComparing(true);
    const library = getLibrary(scope);
    void savedVersionOf(checkpoint, library ? () => library.list() : null).then(
      setSaved,
    );
  };
  const restore = () => {
    if (!paged) return;
    setBusy(true);
    void restoreCheckpoint(paged, checkpoint, sinks).finally(() =>
      setBusy(false),
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) postponeCheckpoint(scope, checkpoint);
      }}
    >
      <DialogContent
        role="alertdialog"
        data-testid="recovery-dialog"
        data-recovery-session={checkpoint.session}
        className="max-w-lg"
        onKeyDown={(e) => {
          // Keys pressed in the question stay in it (as the replace
          // question's do): no window shortcut acts on the canvas behind.
          e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{strings.t(RECOVERY_PROMPT.title)}</DialogTitle>
          <DialogDescription data-testid="recovery-body">
            {strings.t(RECOVERY_PROMPT.body, {
              name,
              time: time(checkpoint.at),
            })}
          </DialogDescription>
        </DialogHeader>
        {comparing && (
          <dl data-testid="recovery-compare" style={compareStyle}>
            <dt style={termStyle}>
              {strings.t(RECOVERY_PROMPT.recoveredCopy)}
            </dt>
            <dd data-recovery-copy style={defStyle}>
              {strings.t(RECOVERY_PROMPT.recoveredFacts, {
                time: time(checkpoint.at),
                edits: String(checkpoint.edits),
                pages:
                  checkpoint.pages === null
                    ? strings.t(RECOVERY_PROMPT.unknownPages)
                    : String(checkpoint.pages),
              })}
            </dd>
            <dt style={termStyle}>{strings.t(RECOVERY_PROMPT.savedVersion)}</dt>
            <dd data-recovery-saved={saved?.kind ?? ""} style={defStyle}>
              {saved === null
                ? "…"
                : saved.kind === "library"
                  ? saved.savedAt === null
                    ? strings.t(RECOVERY_PROMPT.inLibraryUndated, {
                        name: saved.name ?? name,
                      })
                    : strings.t(RECOVERY_PROMPT.inLibrary, {
                        name: saved.name ?? name,
                        time: time(saved.savedAt),
                      })
                  : saved.kind === "file"
                    ? strings.t(RECOVERY_PROMPT.inFile, {
                        name: saved.name ?? name,
                      })
                    : strings.t(RECOVERY_PROMPT.neverSaved)}
            </dd>
            <p style={{ ...defStyle, gridColumn: "1 / -1" }}>
              {strings.t(RECOVERY_PROMPT.restoreNote, {
                name: strings.t(RECOVERY.recoveredName, { name }),
              })}
            </p>
          </dl>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            data-testid="recovery-discard"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void discardCheckpoint(scope, checkpoint).finally(() =>
                setBusy(false),
              );
            }}
          >
            {strings.t(RECOVERY_PROMPT.discard)}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="recovery-later"
              disabled={busy}
              onClick={() => postponeCheckpoint(scope, checkpoint)}
            >
              {strings.t(RECOVERY_PROMPT.later)}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="recovery-compare-toggle"
              aria-expanded={comparing}
              disabled={busy}
              onClick={compare}
            >
              {strings.t(
                comparing
                  ? RECOVERY_PROMPT.hideCompare
                  : RECOVERY_PROMPT.compare,
              )}
            </Button>
            <Button
              type="button"
              data-testid="recovery-restore"
              disabled={busy || !paged}
              onClick={restore}
            >
              {strings.t(RECOVERY_PROMPT.restore)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const compareStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "4px 12px",
  margin: "4px 0 0",
  fontSize: 12,
};

const termStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "var(--pg-fg)",
};

const defStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--pg-muted-fg)",
};
