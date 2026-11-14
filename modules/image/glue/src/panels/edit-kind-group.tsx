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

// The raster context's control-bar group (image ADR 487): "Editing:
// Pixels", "Editing: Mask · non-destructive", "Editing: Adjustment ·
// non-destructive" — what the next edit inside the image changes, beside
// the tool in hand, read from the session as it changes.

import { useSyncExternalStore, type ComponentType } from "react";

import type { ControlBarGroupProps } from "@paged-media/plugin-api";

import { editKindOf, type EditKind } from "../edit-kind";
import type { ImageSession } from "../session";
import { EditKindBadge } from "./sections/edit-kind-badge";

/** The session's current edit kind (a string, so the snapshot is stable). */
function editKindNow(session: ImageSession): EditKind {
  const layers = session.state().layers;
  const active = layers.layers.find((l) => l.index === layers.active);
  return editKindOf(active, layers.editTarget ?? "pixels");
}

export function makeEditKindGroup(
  session: ImageSession,
): ComponentType<ControlBarGroupProps> {
  const subscribe = (listener: () => void) => {
    const sub = session.onDidChange(listener);
    return () => sub.dispose();
  };
  const read = () => editKindNow(session);
  const EditKindGroup = () => {
    const kind = useSyncExternalStore(subscribe, read, read);
    return <EditKindBadge kind={kind} />;
  };
  return EditKindGroup;
}
