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

// The one door the agent drives the document through. The editor implements
// it over `CanvasClient.executeScript` (the worker's wasm engine), the CLI
// over the headless host's `runScript`; the agent never knows which.

/** What one script run returned: the console lines (`[log] …`), the error
 *  (`Name: message`, or `runtime budget exceeded: …`) and which budget
 *  tripped, if one did. */
export interface ScriptRun {
  output: string[];
  error: string | null;
  budgetKind?: string | null;
}

export interface ScriptEngine {
  /** Run a `paged.*` Boa script against the open document. Never throws for
   *  a script failure — that is `error`. */
  runScript(source: string): Promise<ScriptRun>;
  /** A PNG of page `pageIndex` (1-based), for the model to judge the look.
   *  Absent where the host cannot rasterise. */
  renderPage?(pageIndex: number): Promise<Uint8Array | null>;
}

/** Story health after a run, read through the same script door. */
export interface StoryHealth {
  stories: number;
  overset: string[];
}

const HEALTH_PROBE = `console.log(paged.stories());`;

/** Read which stories are overset. A failure reads as "unknown" (null)
 *  rather than failing the agent's turn. */
export async function readStoryHealth(engine: ScriptEngine): Promise<StoryHealth | null> {
  const run = await engine.runScript(HEALTH_PROBE);
  if (run.error) return null;
  // Console lines carry their level: `[log] [{"selfId":…}]`.
  const line = run.output.map((l) => l.replace(/^\[\w+\] /, "")).find((l) => l.startsWith("["));
  if (!line) return null;
  try {
    const rows = JSON.parse(line) as Array<{ selfId: string; overset?: boolean }>;
    return { stories: rows.length, overset: rows.filter((r) => r.overset).map((r) => r.selfId) };
  } catch {
    return null;
  }
}
