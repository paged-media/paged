/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// `paged ai <doc> <brief>` — Claude writes and runs paged.* scripts against
// the document until the brief is done, then the result is saved. The
// model call goes straight to Anthropic with the caller's credential
// (ANTHROPIC_API_KEY, or an `ant auth login` profile); the scripts run here,
// in the headless engine.

import { createDirectTransport, runAgent, type AgentEvent, type ApiCatalog, type ScriptEngine } from "@paged-media/ai";

import Anthropic from "@anthropic-ai/sdk";
import ENGINE_CATALOG from "@paged-media/ai/catalog";

import { flagStr, type OptionSpec, type ParsedArgs } from "./args";
import { CliError, EXIT } from "./errors";
import type { CliSession } from "./session";

export const AI_OPTIONS: readonly OptionSpec[] = [
  { name: "new", value: "size", help: "start from a blank page instead of a file: a4, a5, a3, letter, legal, tabloid, or WxH in points (implies --mode document; save with -o)" },
  { name: "mode", value: "script|document", help: "script: change the document (default); document: build a whole document from the brief" },
  { name: "model", value: "id", help: "Claude model (default claude-haiku-5-5)" },
  { name: "max-turns", value: "n", help: "stop after this many model turns" },
  { name: "verbose", help: "print the scripts and their results to stderr as they run" },
];

/** The engine's capability catalog, as @paged-media/ai ships it (in
 *  lockstep with the engine the wire types were synced from). */
export function loadCatalog(): ApiCatalog {
  return ENGINE_CATALOG;
}

/** The headless session behind the agent's engine door. */
export function sessionEngine(s: CliSession): ScriptEngine {
  return {
    runScript: (source) => s.h.runScript(source),
    async renderPage(pageIndex) {
      const run = await s.h.runScript("console.log(paged.pages())");
      const line = run.output[0]?.replace(/^\[\w+\] /, "");
      const pages = line ? (JSON.parse(line) as Array<{ selfId: string }>) : [];
      const page = pages[pageIndex - 1];
      if (!page) return null;
      const shot = await s.driver.render.snapshot(page.selfId, { widthPx: 1024 });
      return shot?.png ?? null;
    },
  };
}

const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [842, 1191],
  a4: [595, 842],
  a5: [420, 595],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

/** `--new` → page size in points. */
export function parsePageSize(value: string): [number, number] {
  const named = PAGE_SIZES[value.toLowerCase()];
  if (named) return named;
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(value);
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return [Number(m[1]), Number(m[2])];
  throw new CliError(EXIT.usage, `--new takes ${Object.keys(PAGE_SIZES).join(", ")} or WxH in points, not "${value}"`);
}

function trace(event: AgentEvent): void {
  if (event.type === "script") process.stderr.write(`\n--- script ---\n${event.source.trim()}\n`);
  else if (event.type === "scriptResult") {
    const { run, overset } = event;
    for (const line of run.output) process.stderr.write(`${line}\n`);
    if (run.error) process.stderr.write(`error: ${run.error}\n`);
    if (overset?.length) process.stderr.write(`overset: ${overset.join(", ")}\n`);
  } else if (event.type === "lookup") process.stderr.write(`[lookup ${event.query}]\n`);
  else if (event.type === "render") process.stderr.write(`[render page ${event.page}]\n`);
}

export async function runAiVerb(s: CliSession, brief: string, args: ParsedArgs): Promise<{ json: unknown; text: string; scripts: number }> {
  const mode = flagStr(args, "mode") ?? (flagStr(args, "new") !== undefined ? "document" : "script");
  if (mode !== "script" && mode !== "document") throw new CliError(EXIT.usage, `--mode must be script or document, not "${mode}"`);
  const maxTurns = flagStr(args, "max-turns");
  if (maxTurns !== undefined && !/^\d+$/.test(maxTurns)) throw new CliError(EXIT.usage, "--max-turns takes a whole number");
  const catalog = loadCatalog();
  const transport = createDirectTransport({ catalog, model: flagStr(args, "model") });
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent({
      transport,
      engine: sessionEngine(s),
      catalog,
      mode,
      prompt: brief,
      ...(maxTurns !== undefined ? { maxTurns: Number(maxTurns) } : {}),
      ...(args.flags.verbose === true ? { onEvent: trace } : {}),
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new CliError(EXIT.usage, "Anthropic rejected the credential: check ANTHROPIC_API_KEY (or run `ant auth login`)");
    // Raised before any request when no credential is configured at all.
    if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
      throw new CliError(EXIT.usage, "no Anthropic credential: set ANTHROPIC_API_KEY, or run `ant auth login`");
    }
    throw err;
  }
  if (result.outcome === "refused") {
    throw new CliError(EXIT.failed, `Claude declined this request${result.refusal?.category ? ` (${result.refusal.category})` : ""}${result.refusal?.explanation ? `: ${result.refusal.explanation}` : ""}`);
  }
  const json = {
    outcome: result.outcome,
    summary: result.summary,
    turns: result.turns,
    usage: result.usage,
    scripts: result.scripts.map((x) => ({ source: x.source, error: x.run.error, output: x.run.output })),
  };
  const note = result.outcome === "done" ? "" : `\n(stopped: ${result.outcome === "turnLimit" ? "turn limit reached" : "the reply was cut off"})`;
  return { json, text: `${result.summary}${note}`, scripts: result.scripts.length };
}
