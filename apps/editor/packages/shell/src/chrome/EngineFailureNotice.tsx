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

// The worker that runs the engine stopped answering (the interaction
// specification's `UXI-ASY-005`, `UXI-T61`): every gesture has ended (the
// interaction coordinator), nothing claims a change it could not make, and
// this says so — what happened, that nothing more can change, and how to
// get the work back (the recovery copy, editor ADR 1204).
//
// How the work comes back depends on whose page it is. An editor that IS
// the page reloads it. An embedded editor never reloads its host's page:
// it asks the host to restart it (`setEngineRestart`, the embedding API's
// `actions.restart`), and without that it only says what happened; the
// host hears of the failure either way (the `engineFailure` event).

import { useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import { Button } from "../components/ui/button";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { editorOwnsPage, editorRootOf } from "../state/editor-root";
import {
  scoped,
  useEditorScope,
  type EditorScope,
} from "../state/editor-scope";
import { ENGINE_FAILURE } from "./messages";

const RESTART = scoped("engineRestart", () => ({
  restart: null as (() => void) | null,
  listeners: new Set<() => void>(),
}));

/** How `scope`'s editor is started again after its engine stopped, when
 *  the editor is not the page: its host's restart (dispose it and create
 *  it again). Null takes it away. */
export function setEngineRestart(
  scope: EditorScope,
  restart: (() => void) | null,
): void {
  const store = scope.get(RESTART);
  store.restart = restart;
  for (const l of [...store.listeners]) l();
}

/** What the notice's button does, or null when there is nothing the
 *  editor itself may do: reload the page when the editor is the page (or
 *  has no root of its own: a shell on its own page), else the host's
 *  restart. */
export function engineRecovery(
  scope: EditorScope,
  reload: () => void = () => location.reload(),
): { kind: "reload" | "restart"; run: () => void } | null {
  const embedded = editorRootOf(scope) !== null && !editorOwnsPage(scope);
  if (!embedded) return { kind: "reload", run: reload };
  const restart = scope.get(RESTART).restart;
  return restart ? { kind: "restart", run: restart } : null;
}

const never = () => () => {};
const none = () => null;

export function EngineFailureNotice() {
  const strings = useStrings();
  const client = useOptionalCanvasClient();
  const scope = useEditorScope();
  const failure = useSyncExternalStore(
    client ? (notify) => client.onFatal(() => notify()) : never,
    client ? () => client.failure : none,
    none,
  );
  // Which recovery there is, as a snapshot (ADR 229): the host may hand
  // its restart over after the editor mounted.
  const kind = useSyncExternalStore(
    (notify) => {
      const { listeners } = scope.get(RESTART);
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => engineRecovery(scope)?.kind ?? "none",
    () => "none" as const,
  );
  if (!failure) return null;
  const recovery =
    kind === "none" ? null : { kind, run: () => engineRecovery(scope)?.run() };
  return (
    <div role="alert" data-engine-failure="" style={noticeStyle}>
      <strong>{strings.t(ENGINE_FAILURE.title)}</strong>
      <span style={{ flex: 1 }}>
        {strings.t(
          recovery?.kind === "reload"
            ? ENGINE_FAILURE.body
            : recovery
              ? ENGINE_FAILURE.bodyRestart
              : ENGINE_FAILURE.bodyHost,
        )}
      </span>
      {recovery && (
        <Button
          size="sm"
          variant="outline"
          data-engine-recovery={recovery.kind}
          onClick={recovery.run}
        >
          {strings.t(
            recovery.kind === "reload"
              ? ENGINE_FAILURE.reload
              : ENGINE_FAILURE.restart,
          )}
        </Button>
      )}
    </div>
  );
}

const noticeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  border: "1px solid var(--status-error)",
  background: "color-mix(in srgb, var(--status-error) 12%, transparent)",
  color: "var(--fg)",
  borderRadius: "var(--radius-md)",
  padding: 8,
  fontSize: 12,
  margin: 8,
};
