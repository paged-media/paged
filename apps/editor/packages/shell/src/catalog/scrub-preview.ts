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

// A numeric field's LIVE PREVIEW as one undo step (the interaction spec's
// UXI-PNL-005: "numeric scrub as one undo step"; editor ADR 1216).
//
// The field hands its owner a preview for every scrubbed value and one
// commit on release, all under one `coalesceKey`. Every write carries that
// key to the engine (`mutate(op, { coalesce })`, engine ADR 1304, protocol
// 80): consecutive writes with one key are ONE undo step. The release
// writes the final value with the key and ends the run (`endCoalesce`).
// Escape, a lost pointer or a release where the scrub began ends the run
// and undoes its one step, so the document is as it was.
//
// Writes run one at a time, in order (an object-model write plans before it
// sends, and a preview that planned slower than the release must not land
// after it); previews are throttled to one per frame, the last value of a
// frame winning.

import type { CanvasClient } from "@paged-media/client";
import { useState } from "react";

import { useOptionalCanvasClient } from "../state/canvas-client-context";

type CoalesceClient = Pick<CanvasClient, "endCoalesce" | "undo">;

/** A write: it sends the value with the scrub's coalesce key (null for a
 *  typed commit), and may answer a promise the next write waits for. */
export type PreviewWrite = (coalesce: string | null) => unknown;

export interface PreviewCommitter {
  /** A live value of the scrub `key`; `write` sends it. */
  preview(key: string, write: PreviewWrite): void;
  /** The scrub's (or a typed) final value; ends the scrub's run. */
  commit(key: string | null, write: PreviewWrite): void;
  /** The scrub ended without a new value: put the document back. */
  cancel(key: string): void;
}

const nextFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
};

export function createPreviewCommitter(
  client: CoalesceClient,
): PreviewCommitter {
  let pending: { key: string | null; write: PreviewWrite } | null = null;
  let busy = false;
  let waiters: Array<() => void> = [];
  let cancelFrame: (() => void) | null = null;
  /** Keys whose run sent at least one write. */
  const wrote = new Set<string>();

  const settle = () => {
    if (busy || pending) return;
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };
  const pump = () => {
    if (busy || !pending) {
      settle();
      return;
    }
    const { key, write } = pending;
    pending = null;
    busy = true;
    if (key !== null) wrote.add(key);
    void Promise.resolve()
      .then(() => write(key))
      .catch(() => {})
      .then(() => {
        busy = false;
        pump();
      });
  };
  /** Every queued and running write has settled. */
  const idle = () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      settle();
    });
  const dropFrame = () => {
    cancelFrame?.();
    cancelFrame = null;
  };
  const endRun = async (key: string) => {
    await idle();
    return client.endCoalesce(key);
  };

  return {
    preview(key, write) {
      pending = { key, write };
      if (!cancelFrame)
        cancelFrame = nextFrame(() => {
          cancelFrame = null;
          pump();
        });
    },
    commit(key, write) {
      dropFrame();
      // The final value replaces any preview still waiting.
      pending = { key, write };
      pump();
      if (key !== null) {
        wrote.delete(key);
        void endRun(key);
      }
    },
    cancel(key) {
      dropFrame();
      pending = null;
      void endRun(key).then(async (step) => {
        // The run's one step goes back: the document is as it was.
        if (wrote.delete(key) && step !== null) await client.undo();
      });
    },
  };
}

/** This field's preview committer over the editor's canvas client; null
 *  without one (a bare test, a panel outside an editor). */
export function usePreviewCommitter(): PreviewCommitter | null {
  const client = useOptionalCanvasClient();
  const [held, setHeld] = useState<{
    client: CoalesceClient;
    committer: PreviewCommitter;
  } | null>(() =>
    client ? { client, committer: createPreviewCommitter(client) } : null,
  );
  // A new client (a re-mounted editor) gets a committer of its own: state
  // that follows a prop, moved during render (React's pattern for it).
  if (client && held?.client !== client) {
    setHeld({ client, committer: createPreviewCommitter(client) });
  }
  return client && held?.client === client ? held.committer : null;
}
