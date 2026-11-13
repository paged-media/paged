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

// The local interaction trace (the interaction specification, §22.1,
// `UXI-OBS-001`…`003`): what the coordinator decided, in order, kept in a
// ring buffer in the page and never sent anywhere. It records ids, owner
// names, phases, pointer types, epochs, results and reasons, and nothing
// a user typed or a document holds (`UXI-OBS-002`): an entry has no field
// that could carry text. Development and demo builds fill it and the page
// entry shows it as `__interaction`; a production build records nothing.

import type { InteractionOwner, InteractionPhase } from "./owners";

/** What a trace entry records. */
export type TraceEvent =
  | "begin"
  | "phase"
  | "end"
  | "refused"
  | "illegal-transition"
  | "abort-all"
  | "stale"
  | "epoch"
  | "deferred";

export interface TraceEntry {
  /** ms since the trace was created. */
  t: number;
  event: TraceEvent;
  /** The session (`i-12`), when the entry is about one. */
  id?: string;
  owner?: InteractionOwner;
  /** A tool id (`paged.tool.select`): a registry key, never user text. */
  tool?: string;
  phase?: InteractionPhase;
  pointerType?: string;
  /** commit | cancel | abort, on `end`. */
  result?: string;
  /** A fixed diagnostic (`capture-lost`, `stale hit-test discarded`). */
  reason?: string;
  /** The document epoch at the entry. */
  doc: number;
  latencyMs?: number;
}

export interface InteractionTrace {
  record(entry: Omit<TraceEntry, "t">): void;
  /** Oldest first. */
  entries(): readonly TraceEntry[];
  clear(): void;
  readonly enabled: boolean;
}

const CAPACITY = 256;

export function createTrace(
  enabled: boolean,
  now: () => number = () => performance.now(),
): InteractionTrace {
  const start = now();
  const ring: TraceEntry[] = [];
  return {
    enabled,
    record(entry) {
      if (!enabled) return;
      ring.push({ t: Math.round(now() - start), ...entry });
      if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
    },
    entries: () => ring.slice(),
    clear() {
      ring.length = 0;
    },
  };
}
