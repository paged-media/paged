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

// Contained errors: a panel or a dialog that throws while it renders is
// caught where it stands, so the rest of the editor keeps working (the
// canvas, the other panels, Save). The shell's root boundary
// (`PagedShell`) stays the last net; these are the first.
//
//   · a PANEL shows the failure in its own place, with "Try again" (the
//     panel is rendered anew) and the error's message behind Details;
//   · a DIALOG has no place of its own once it has thrown (its markup is a
//     portal): it closes, and the failure goes to the feedback channel
//     with "Try again" as its remedy.
//
// Both record the crash in the journal the way the root boundary does:
// the boundary's label and the error's kind, never its message.

import React from "react";
import { errorIdent, identOf, journal } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import { useEditorScope } from "../state/editor-scope";
import {
  FEEDBACK_STRINGS,
  operationFeedbackOf,
} from "../state/operation-feedback";

const M = defineMessages("shell.containedError", {
  panelTitle: "{panel} stopped working.",
  panelBody:
    "An error occurred in this panel. The rest of the editor keeps working.",
  retry: "Try again",
  dialogAction: "show {dialog}",
  dialogReason: "an error occurred in it. The rest of the editor keeps working",
  exportDialog: "the export dialog",
  newDocumentDialog: "the new document dialog",
  replacePrompt: "the unsaved changes prompt",
  recoveryPrompt: "the recovery prompt",
  commandPalette: "the command palette",
});

/** The names of the shell's own dialogs, for `DialogErrorBoundary`. */
export const DIALOG_NAMES = {
  exportDialog: M.exportDialog,
  newDocumentDialog: M.newDocumentDialog,
  replacePrompt: M.replacePrompt,
  recoveryPrompt: M.recoveryPrompt,
  commandPalette: M.commandPalette,
} as const;

interface BoundaryProps {
  label: string;
  /** Called once per caught error, after it is recorded. */
  onCaught?: (error: Error, retry: () => void) => void;
  fallback: (error: Error, retry: () => void) => React.ReactNode;
  children?: React.ReactNode;
}

/** The boundary itself: a class, as React requires of one. */
class Boundary extends React.Component<BoundaryProps, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  retry = () => {
    this.setState({ error: null });
  };
  override componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label}] caught:`, error);
    journal.record({
      code: "shell.panel.crash",
      severity: "error",
      data: {
        label: identOf(this.props.label) ?? "unknown",
        error: errorIdent(error),
      },
    });
    this.props.onCaught?.(error, this.retry);
  }
  override render() {
    return this.state.error
      ? this.props.fallback(this.state.error, this.retry)
      : this.props.children;
  }
}

/** A panel's own error net: `id` names it in the journal, `name` in the
 *  message. Give it the panel's id as its `key` where one slot shows
 *  several panels, so another panel does not inherit the failure. */
export function PanelErrorBoundary({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: React.ReactNode;
}) {
  const strings = useStrings();
  return (
    <Boundary
      label={`panel:${id}`}
      fallback={(error, retry) => (
        <div
          role="alert"
          data-panel-error={id}
          className="pg-ui-xs"
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <strong style={{ color: "var(--status-error)" }}>
            {strings.t(M.panelTitle, { panel: name })}
          </strong>
          <span>{strings.t(M.panelBody)}</span>
          <button type="button" data-panel-error-retry="" onClick={retry}>
            {strings.t(M.retry)}
          </button>
          <details>
            <summary>{strings.t(FEEDBACK_STRINGS.details)}</summary>
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontFamily: "var(--font-mono)",
              }}
            >
              {error.message}
            </pre>
          </details>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

/** A dialog's error net: `id` names it in the journal, `name` (a noun
 *  phrase in the editor's language, "the export dialog") in the message.
 *  A dialog that throws closes; the feedback channel says so and offers to
 *  try again (a dialog whose state still says "open" shows again then). */
export function DialogErrorBoundary({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: React.ReactNode;
}) {
  const scope = useEditorScope();
  const strings = useStrings();
  return (
    <Boundary
      label={`dialog:${id}`}
      onCaught={(error, retry) => {
        const feedback = operationFeedbackOf(scope);
        const key = `paged.shell|dialog|${id}`;
        feedback.report({
          action: strings.t(M.dialogAction, { dialog: name }),
          outcome: "recoverable-failure",
          reason: strings.t(M.dialogReason),
          remedy: {
            label: strings.t(M.retry),
            run: () => {
              feedback.resolve(key);
              retry();
            },
          },
          detail: error.message,
          source: "paged.shell",
          key,
          // Kept in Problems: the dialog stays closed until it is tried
          // again, and the toast does not stay that long.
          persistent: true,
        });
      }}
      fallback={() => null}
    >
      {children}
    </Boundary>
  );
}
