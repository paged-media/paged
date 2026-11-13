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

import { useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import { Button } from "../components/ui/button";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { ENGINE_FAILURE } from "./messages";

const never = () => () => {};
const none = () => null;

export function EngineFailureNotice() {
  const strings = useStrings();
  const client = useOptionalCanvasClient();
  const failure = useSyncExternalStore(
    client ? (notify) => client.onFatal(() => notify()) : never,
    client ? () => client.failure : none,
    none,
  );
  if (!failure) return null;
  return (
    <div role="alert" data-engine-failure="" style={noticeStyle}>
      <strong>{strings.t(ENGINE_FAILURE.title)}</strong>
      <span style={{ flex: 1 }}>{strings.t(ENGINE_FAILURE.body)}</span>
      <Button size="sm" variant="outline" onClick={() => location.reload()}>
        {strings.t(ENGINE_FAILURE.reload)}
      </Button>
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
