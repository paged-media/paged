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

// The ML service of an editor scope (editor ADR 290): the app sets it once
// at mount, Settings ▸ Models reads it. Per editor: two editors on a page
// have two services (and two ML backends).

import { useSyncExternalStore } from "react";

import { scoped, useScoped, type EditorScope } from "@paged-media/shell";

import type { MlService, MlServiceSnapshot } from "./service";

interface Slot {
  service: MlService | null;
  listeners: Set<() => void>;
  subscribe(l: () => void): () => void;
}

const ML_SERVICE = scoped("mlService", (): Slot => {
  const slot: Slot = {
    service: null,
    listeners: new Set(),
    subscribe(l) {
      slot.listeners.add(l);
      return () => slot.listeners.delete(l);
    },
  };
  return slot;
});

export function setMlService(scope: EditorScope, service: MlService | null) {
  const slot = scope.get(ML_SERVICE);
  slot.service = service;
  for (const l of [...slot.listeners]) l();
}

/** The scope's ML service, or null before the app sets one. */
export function useMlService(): MlService | null {
  const slot = useScoped(ML_SERVICE);
  return useSyncExternalStore(
    slot.subscribe,
    () => slot.service,
    () => null,
  );
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

/** The service's state, re-read when it changes. */
export function useMlSnapshot(
  service: MlService | null,
): MlServiceSnapshot | null {
  return useSyncExternalStore(
    service ? service.subscribe : noSubscribe,
    service ? service.snapshot : noSnapshot,
    noSnapshot,
  );
}
