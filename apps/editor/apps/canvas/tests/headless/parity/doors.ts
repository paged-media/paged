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

// The SURFACES and their DOORS. A surface is a way into the engine a user
// or a program has (the editor's commands, the plugin API, Boa scripts,
// editor.* automation, the command line, MCP, the viewer SDK); a door is
// one entry point of a surface, and it is one of three kinds:
//
//   named    the surface names the operation itself (`paged.insertText`,
//            `paged.object.group`, a CLI subcommand)
//   typed    the surface's typed-command door, arguments checked against
//            the operation's schema (`core.<op>` through host.objects,
//            `paged.invoke`, the typed-command dialog, `paged invoke`)
//   generic  the surface's raw door for any wire mutation
//            (`document.mutate`, `paged.batch`, `editor.mutate`)
//
// Every door runs in the headless editor except the CLI's, which runs the
// real `paged` binary on the same precondition, saved.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleHost } from "@paged-media/plugin-api";

import type { HeadlessEditor } from "../harness";
import type { ParityCase } from "./cases";

type Args = Record<string, unknown>;

export type SurfaceId =
  | "editor-ui"
  | "plugin-api"
  | "boa"
  | "automation"
  | "cli"
  | "mcp"
  | "viewer-sdk";

export type DoorKind = "named" | "typed" | "generic";

export interface DoorContext {
  /** The live editor (replaced when an engine trap forces a new one). */
  ed: HeadlessEditor;
  host: BundleHost;
  /** `core.*` typed commands the shared object registry offers. */
  typedCommands: ReadonlySet<string>;
  /** `paged.*` host functions the catalog lists. */
  hostFunctions: ReadonlySet<string>;
  /** Editor command ids registered. */
  editorCommands: ReadonlySet<string>;
  /** Ops `paged ops --json` lists as invokable (null: no binary). */
  cliOps: ReadonlySet<string> | null;
}

export interface Door {
  id: string;
  surface: SurfaceId;
  kind: DoorKind;
  /** The surface id the gate counts (`script:paged.batch`). */
  label: string;
  /** Whether this door reaches the case's op (and can run it). */
  reaches(ctx: DoorContext, c: ParityCase): boolean;
  /** Perform the case's op; the editor holds the precondition. Throws
   *  when the door refused (the refusal is the message). */
  run(ctx: DoorContext, c: ParityCase, args: Args): Promise<unknown>;
  /** Runs out of process on saved documents (the CLI). */
  external?: true;
}

/** A Boa script's answer, or the throw that says the script failed. */
async function boa(ctx: DoorContext, source: string): Promise<string[]> {
  const r = await ctx.ed.script(source);
  if (r.error) throw new Error(`script error: ${r.error}`);
  return r.output;
}

const isWriteFailure = (answer: unknown): string | null => {
  if (answer === null || answer === undefined) return null;
  if (typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (a["kind"] === "mutationFailed") return JSON.stringify(a["payload"]);
  if (a["applied"] === false)
    return String(a["error"] ?? a["code"] ?? a["reason"] ?? "not applied");
  return null;
};

const refuseIfFailed = (answer: unknown) => {
  const why = isWriteFailure(answer);
  if (why) throw new Error(`refused: ${why}`);
  return answer;
};

const mutation = (c: ParityCase, args: Args) => ({ op: c.op, args });
const typed = (ctx: DoorContext, c: ParityCase) =>
  ctx.typedCommands.has(`core.${c.op}`);

export const IN_PROCESS_DOORS: readonly Door[] = [
  {
    id: "ui.command",
    surface: "editor-ui",
    kind: "named",
    label: "command:<the case's command>",
    reaches: (ctx, c) => !!c.command && ctx.editorCommands.has(c.command.id),
    async run(ctx, c) {
      await ctx.ed.select(c.command!.select as never);
      await ctx.ed.invoke(c.command!.id);
      await ctx.ed.idle();
      const problems = ctx.ed.problems();
      if (problems.length > 0)
        throw new Error(
          `refused: ${problems.map((p) => p.message).join("; ")}`,
        );
      return null;
    },
  },
  {
    id: "ui.dialog",
    surface: "editor-ui",
    kind: "typed",
    label: "command:paged.core.runCommand",
    reaches: (ctx, c) =>
      typed(ctx, c) &&
      (ctx.editorCommands.has(`paged.core.${c.op}`) ||
        ctx.editorCommands.has("paged.core.runCommand")),
    run: (ctx, c, args) => ctx.ed.invokeCore(c.op, args),
  },
  {
    id: "plugin.objects",
    surface: "plugin-api",
    kind: "typed",
    label: "host.objects.invoke",
    reaches: typed,
    run: (ctx, c, args) => ctx.host.objects.invoke(`core.${c.op}`, args),
  },
  {
    id: "plugin.mutate",
    surface: "plugin-api",
    kind: "generic",
    label: "host.document.mutate",
    reaches: (_ctx, c) => c.op !== "bindCreated",
    run: async (ctx, c, args) =>
      refuseIfFailed(
        await ctx.host.document.mutate(mutation(c, args) as never),
      ),
  },
  {
    id: "boa.named",
    surface: "boa",
    kind: "named",
    label: "script:paged.<op>",
    reaches: (ctx, c) =>
      !!c.boa && ctx.hostFunctions.has(`paged.${c.boaName ?? c.op}`),
    async run(ctx, c, args) {
      const out = await boa(
        ctx,
        `console.log(JSON.stringify(${c.boa!(args)}))`,
      );
      const answer = (out[0] ?? "").replace(/^\[log\] /, "");
      if (answer === "false" || answer === "null")
        throw new Error(`refused: paged.${c.op} answered ${answer}`);
      return answer;
    },
  },
  {
    id: "boa.invoke",
    surface: "boa",
    kind: "typed",
    label: "script:paged.invoke",
    reaches: typed,
    run: (ctx, c, args) =>
      boa(
        ctx,
        `console.log(await paged.invoke(${JSON.stringify(`core.${c.op}`)}, ${JSON.stringify(args)}))`,
      ),
  },
  {
    id: "boa.batch",
    surface: "boa",
    kind: "generic",
    label: "script:paged.batch",
    reaches: (_ctx, c) => c.op !== "bindCreated",
    async run(ctx, c, args) {
      const out = await boa(
        ctx,
        `console.log(JSON.stringify(paged.batch([${JSON.stringify(mutation(c, args))}])))`,
      );
      const answer = (out[0] ?? "").replace(/^\[log\] /, "");
      if (answer === "false")
        throw new Error("refused: paged.batch answered false");
      return answer;
    },
  },
  {
    id: "automation.command",
    surface: "automation",
    kind: "named",
    label: "script:editor.runCommand",
    reaches: (ctx, c) => !!c.command && ctx.editorCommands.has(c.command.id),
    async run(ctx, c) {
      const { editor } = ctx.ed.automation;
      await editor.select(c.command!.select);
      await editor.runCommand(c.command!.id);
      await ctx.ed.idle();
      const problems = ctx.ed.problems();
      if (problems.length > 0)
        throw new Error(
          `refused: ${problems.map((p) => p.message).join("; ")}`,
        );
      return null;
    },
  },
  {
    id: "automation.batch",
    surface: "automation",
    kind: "typed",
    label: "script:editor.batch",
    reaches: typed,
    async run(ctx, c, args) {
      const r = await ctx.ed.automation.editor.batch([
        { op: "invoke", command: `core.${c.op}`, args } as never,
      ]);
      return refuseIfFailed(r);
    },
  },
  {
    id: "automation.mutate",
    surface: "automation",
    kind: "generic",
    label: "script:editor.mutate",
    reaches: (_ctx, c) => c.op !== "bindCreated",
    run: async (ctx, c, args) =>
      refuseIfFailed(await ctx.ed.automation.editor.mutate(mutation(c, args))),
  },
];

// ------------------------------------------------------------------ CLI

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));

/** The `paged` binary: `PAGED_CLI_BIN`, else the engine's debug / release
 *  build in this checkout; null when there is none (the CLI doors then
 *  report `unavailable`, and fail under `PAGED_REQUIRE_PAGED_CLI=1`). */
export function pagedBinary(): string | null {
  const fromEnv = process.env["PAGED_CLI_BIN"];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const profile of ["release", "debug"]) {
    const p = join(ROOT, "engine/core/target", profile, "paged");
    if (existsSync(p)) return p;
  }
  return null;
}

/** The T3 convention (docs/development/testing.md): an honest skip. */
export function unavailable(resource: string, reason: string): void {
  const line = `unavailable: ${resource}: ${reason}`;
  if (process.env["PAGED_REQUIRE_PAGED_CLI"] === "1") throw new Error(line);
  console.log(line);
  const log = process.env["PAGED_SKIP_LOG"];
  if (log)
    appendFileSync(
      log,
      `tests/headless/parity\t${resource}\t${resource}\t${reason}\n`,
    );
}

/** A CLI run that takes longer than this has hung (a debug binary on a
 *  loaded machine takes seconds; the one hang seen was stdin left open). */
const CLI_TIMEOUT_MS = 120_000;

export function run(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLI_TIMEOUT_MS,
  });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  if (r.exitedDueToTimeout)
    return { ok: false, out: `timed out after ${CLI_TIMEOUT_MS} ms: ${out}` };
  return { ok: r.exitCode === 0, out };
}

/** `paged ops --json`: the ops the CLI's `invoke` verb takes. */
export function cliOps(bin: string): Set<string> {
  const r = run(bin, ["ops", "--json"]);
  if (!r.ok) throw new Error(`paged ops --json failed: ${r.out}`);
  const rows = JSON.parse(r.out) as Array<{ op: string; invokable?: boolean }>;
  return new Set(rows.filter((x) => x.invokable !== false).map((x) => x.op));
}

export interface CliDoor {
  id: string;
  surface: SurfaceId;
  kind: DoorKind;
  label: string;
  reaches(ctx: DoorContext, c: ParityCase): boolean;
  /** Run on `input` (a saved precondition); resolves to the saved result. */
  run(bin: string, c: ParityCase, args: Args, input: Uint8Array): Uint8Array;
}

function withTemp<T>(f: (dir: string) => T): T {
  const keep = process.env["PARITY_KEEP"];
  const dir = mkdtempSync(join(keep || tmpdir(), "paged-parity-"));
  try {
    return f(dir);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

export const CLI_DOORS: readonly CliDoor[] = [
  {
    id: "cli.invoke",
    surface: "cli",
    kind: "typed",
    label: "cli:paged invoke",
    reaches: (ctx, c) => !!ctx.cliOps?.has(c.op),
    run: (bin, c, args, input) =>
      withTemp((dir) => {
        const inPath = join(dir, "in.paged");
        const outPath = join(dir, "out.paged");
        const argsPath = join(dir, "args.json");
        writeFileSync(inPath, input);
        writeFileSync(argsPath, JSON.stringify(args));
        const r = run(bin, [
          "invoke",
          inPath,
          c.op,
          argsPath,
          "-o",
          outPath,
          "--no-default-font",
        ]);
        if (!r.ok)
          throw new Error(`refused: paged invoke: ${r.out.slice(0, 400)}`);
        return new Uint8Array(readFileSync(outPath));
      }),
  },
  {
    id: "cli.script",
    surface: "cli",
    kind: "named",
    label: "cli:paged script",
    reaches: (ctx, c) =>
      !!c.boa && ctx.hostFunctions.has(`paged.${c.boaName ?? c.op}`),
    run: (bin, c, args, input) =>
      withTemp((dir) => {
        const inPath = join(dir, "in.paged");
        const outPath = join(dir, "out.paged");
        const scriptPath = join(dir, "case.js");
        writeFileSync(inPath, input);
        writeFileSync(
          scriptPath,
          `const answer = ${c.boa!(args)};\n` +
            `if (answer === false || answer === null) throw new Error("paged.${c.op} answered " + answer);\n`,
        );
        const r = run(bin, [
          "script",
          inPath,
          scriptPath,
          "-o",
          outPath,
          "--no-default-font",
        ]);
        if (!r.ok)
          throw new Error(`refused: paged script: ${r.out.slice(0, 400)}`);
        return new Uint8Array(readFileSync(outPath));
      }),
  },
];
