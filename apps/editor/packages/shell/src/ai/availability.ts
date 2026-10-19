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

// Is the AI service there? (UX audit F-25, findings PN-352 and PN-355.)
// The same-origin proxy at /api/ai answers 503 when the deployment has no
// key (or no usage store, or no budget left today), and a fetch that fails
// means there is no proxy at all. One probe per session answers it before
// anyone types a request, so the ask affordances can say so up front
// instead of failing after the request. Any other answer — the proxy
// refusing a bare GET as not same-origin, or not a route — means a proxy
// that serves the editor's POSTs.

import { useEffect, useSyncExternalStore } from "react";

import { AI_PROXY_PATH } from "./editor-ai";

export type AiAvailability = "unknown" | "available" | "unavailable";

let availability: AiAvailability = "unknown";
let probe: Promise<AiAvailability> | null = null;
const listeners = new Set<() => void>();

function publish(next: AiAvailability): void {
  if (next === availability) return;
  availability = next;
  for (const l of [...listeners]) l();
}

/** What the probe answered; `"unknown"` before it settles. */
export function getAiAvailability(): AiAvailability {
  return availability;
}

/** Set the answer without a probe: a host that knows (an embedding with
 *  its own service, a test), or a request that came back 503 later. */
export function setAiAvailability(next: AiAvailability): void {
  probe = Promise.resolve(next);
  publish(next);
}

/** Forget the answer, so the next use probes again (a deployment whose
 *  service changed; a test). */
export function resetAiAvailability(): void {
  probe = null;
  publish("unknown");
}

/** Probe the proxy once per session (later calls share the answer). */
export function probeAiService(): Promise<AiAvailability> {
  probe ??= (async (): Promise<AiAvailability> => {
    try {
      const url = new URL(
        `${AI_PROXY_PATH}/v1/messages`,
        window.location.origin,
      );
      const res = await fetch(url.href, {
        method: "GET",
        cache: "no-store",
      });
      return res.status === 503 ? "unavailable" : "available";
    } catch {
      return "unavailable";
    }
  })().then((answer) => {
    // A host may have set the answer while the probe ran; theirs stands.
    if (availability === "unknown") publish(answer);
    return availability;
  });
  return probe;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The service's availability, probing on first use. Ask affordances are
 *  live while it is `"unknown"` or `"available"`, and say why they are off
 *  when it is `"unavailable"`. */
export function useAiAvailability(): AiAvailability {
  const value = useSyncExternalStore(subscribe, getAiAvailability);
  useEffect(() => {
    void probeAiService();
  }, []);
  return value;
}

/** The words an ask affordance shows when the service is unavailable. */
export const AI_UNAVAILABLE_TEXT =
  "Claude is not available here: this deployment has no AI service.";
