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

// The terminal events no single owner sees (the interaction specification,
// §7.2, `UXI-INV-014`): the window losing focus, the page being hidden, the
// worker failing, and the editor going away. Each ends every open session
// of THIS editor's coordinator, whose owners roll their gesture back. A lost pointer
// capture, a document switch and a tool switch are seen where they happen
// (the canvas, the document and tool contexts) and end the sessions there.

import { useEffect, type PropsWithChildren } from "react";

import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useInteractionCoordinator } from "./coordinator";

export function InteractionProvider({ children }: PropsWithChildren) {
  const coordinator = useInteractionCoordinator();
  const client = useOptionalCanvasClient();
  // A worker that can no longer answer ends every gesture: none may stay
  // pending on a reply that will never come (`UXI-ASY-005`).
  useEffect(
    () => client?.onFatal(() => coordinator.abortAll("worker-failed")),
    [client, coordinator],
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    // A blur or a hidden page ends the presses; a mode (a loaded text
    // cursor, an armed placement) waits for the user to come back.
    const onBlur = () => coordinator.abortAll("blur", { keepModes: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden")
        coordinator.abortAll("hidden", { keepModes: true });
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      coordinator.abortAll("unmount");
    };
  }, [coordinator]);
  return children;
}
