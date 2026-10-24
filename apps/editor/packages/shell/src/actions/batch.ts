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

// WP4.11 — Batch: run one action over a set of files (Photoshop's
// File ▸ Automate ▸ Batch…). PURE like the player: the app hands in how
// a file opens, how the result is exported and where the bytes go, so
// the loop — and its honesty about what failed — is tested without a
// browser.
//
// Per file: open it through the editor's ONE open path (the importer
// registry first, then the IDML / .paged load), play the action with
// its stops and breakpoints passed by (nobody is there to answer them;
// each passed stop is logged), export the result in the chosen format,
// deliver the bytes under the file's name with the format's extension,
// and go on. A file that fails at any stage is logged with the stage
// and the error, and the batch continues; nothing is retried silently.

import { ActionPlayer, type PlayerDeps, type PlayerState } from "./player";
import type { PagedAction } from "./model";

export type BatchFormat = "idml" | "pdf" | "paged";

export const BATCH_FORMATS: readonly BatchFormat[] = ["paged", "idml", "pdf"];

/** The extension a result is delivered with. */
export function batchExtension(format: BatchFormat): string {
  return format;
}

/** `Annual Report.idml` → `Annual Report.pdf`. */
export function batchOutputName(input: string, format: BatchFormat): string {
  const leaf = input.split(/[\\/]/).pop() ?? input;
  const dot = leaf.lastIndexOf(".");
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  return `${base || "document"}.${batchExtension(format)}`;
}

export interface BatchFile {
  name: string;
}

export type BatchStage = "open" | "play" | "export" | "deliver";

export interface BatchLogEntry {
  file: string;
  ok: boolean;
  /** Where it failed. */
  stage?: BatchStage;
  error?: string;
  /** The delivered name. */
  output?: string;
  /** Steps that ran, and those that failed (the file still exports: a
   *  failed step is a fact about the action, not about the file). */
  ran: number;
  failedSteps: number;
  /** Stops passed by, with their messages. */
  passedStops: string[];
  /** Document undo steps the replay became (see the player). */
  undoSteps: number;
}

export interface BatchProgress {
  done: number;
  total: number;
  current: string | null;
}

export interface BatchDeps<F extends BatchFile> {
  open(file: F): Promise<void>;
  /** The player's registry and undo group (see `PlayerDeps`). */
  player: PlayerDeps;
  exportAs(format: BatchFormat): Promise<Uint8Array>;
  deliver(
    name: string,
    bytes: Uint8Array,
    format: BatchFormat,
  ): Promise<void> | void;
  /** After a file is done (delivered or failed) — the app marks the
   *  document saved so the next open does not ask about it. */
  afterFile?(file: F): Promise<void> | void;
}

export interface BatchResult {
  log: BatchLogEntry[];
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one stage, answering its error as text (the `try` outside the
 *  loop keeps the loop compiler-friendly, ADR 229). */
async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

export async function runBatch<F extends BatchFile>(
  files: readonly F[],
  action: PagedAction,
  format: BatchFormat,
  deps: BatchDeps<F>,
  hooks: {
    onProgress?: (p: BatchProgress) => void;
    onLog?: (entry: BatchLogEntry) => void;
    signal?: { readonly aborted: boolean };
  } = {},
): Promise<BatchResult> {
  const log: BatchLogEntry[] = [];
  let cancelled = false;
  const total = files.length;
  for (let i = 0; i < total; i++) {
    if (hooks.signal?.aborted) {
      cancelled = true;
      break;
    }
    const file = files[i];
    hooks.onProgress?.({ done: i, total, current: file.name });
    const entry: BatchLogEntry = {
      file: file.name,
      ok: false,
      ran: 0,
      failedSteps: 0,
      passedStops: [],
      undoSteps: 0,
    };
    const opened = await attempt(() => deps.open(file));
    if (!opened.ok) {
      entry.stage = "open";
      entry.error = opened.error;
    } else {
      const played = await attempt<PlayerState>(() =>
        new ActionPlayer(action, deps.player, {
          ignoreStops: true,
          ignorePauses: true,
        }).start(),
      );
      if (!played.ok) {
        entry.stage = "play";
        entry.error = played.error;
      } else {
        const ran = played.value.ran.filter((r) => !r.passedStop);
        entry.ran = ran.length;
        entry.failedSteps = ran.filter((r) => r.error !== null).length;
        entry.passedStops = played.value.ran
          .filter((r) => r.passedStop)
          .map((r) => r.title);
        entry.undoSteps = played.value.undoSteps;
        const exported = await attempt(() => deps.exportAs(format));
        if (!exported.ok) {
          entry.stage = "export";
          entry.error = exported.error;
        } else {
          const output = batchOutputName(file.name, format);
          const delivered = await attempt(async () => {
            await deps.deliver(output, exported.value, format);
          });
          if (!delivered.ok) {
            entry.stage = "deliver";
            entry.error = delivered.error;
          } else {
            entry.ok = true;
            entry.output = output;
          }
        }
      }
    }
    await attempt(async () => {
      await deps.afterFile?.(file);
    });
    log.push(entry);
    hooks.onLog?.(entry);
  }
  hooks.onProgress?.({ done: log.length, total, current: null });
  const succeeded = log.filter((e) => e.ok).length;
  return { log, succeeded, failed: log.length - succeeded, cancelled };
}
