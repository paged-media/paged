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

// The model and the per-mode request shape. One table, read by the direct
// transport AND the proxy, so the editor, the CLI and the server can never
// disagree about what a mode costs.

/** The model every surface uses unless a host overrides it. */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * What the model is being asked to do. Each mode fixes its own effort,
 * output cap and tool set — the proxy rebuilds a request from the mode, so a
 * client cannot widen any of them.
 *
 * - `script`   — write and run `paged.*` scripts against the open document.
 * - `assist`   — a scoped fix from the AI Assistant card (same tools, less
 *                effort, tighter cap).
 * - `complete` — plain text for a script's `paged.ai.complete()`; no tools.
 * - `document` — build a whole document from a brief.
 */
export type AiMode = "script" | "assist" | "complete" | "document";

export const AI_MODES: readonly AiMode[] = [
  "script",
  "assist",
  "complete",
  "document",
];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModeSpec {
  /** Set explicitly: Haiku 5.5 defaults to `medium`, and the default is not
   *  a decision anyone made. */
  readonly effort: Effort;
  /** Room for adaptive thinking AND the answer — thinking counts here. */
  readonly maxTokens: number;
  /** Whether the script tools are offered. */
  readonly tools: boolean;
  /** Model turns one agent run may take before it is stopped. */
  readonly maxTurns: number;
}

export const MODE_SPECS: Readonly<Record<AiMode, ModeSpec>> = {
  script: { effort: "medium", maxTokens: 32_000, tools: true, maxTurns: 12 },
  assist: { effort: "low", maxTokens: 16_000, tools: true, maxTurns: 6 },
  complete: { effort: "low", maxTokens: 8_000, tools: false, maxTurns: 1 },
  document: { effort: "medium", maxTokens: 64_000, tools: true, maxTurns: 60 },
};

export function isAiMode(value: unknown): value is AiMode {
  return (
    typeof value === "string" && (AI_MODES as readonly string[]).includes(value)
  );
}
