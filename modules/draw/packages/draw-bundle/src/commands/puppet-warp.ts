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

// PUPPET WARP as commands.
//
// `puppetWarp { holds, from, to, autoPins }` is the tool's session as
// data: the selection's paths are meshed (draw-tools
// `PuppetWarpMachine`), `autoPins` automatic pins are placed, a pin is
// added at every `holds` point (they stay where they are), and the pin at
// `from` (added there when there is none) is dragged to `to`. The ARAP
// result is written in ONE batch — one undo step, as one pin drag of the
// tool is.
//
// `puppetWarpTool` is Object ▸ Puppet warp: it switches to the Puppet
// Warp tool. The contract has no "activate a tool" door; the editor's
// command registry, on the handle a command handler is given, does — it
// runs the `paged.tool.activate.<id>` command every rail entry has. That
// is read STRUCTURALLY, the way `tool-options.ts` reads the tool-settings
// store, and where it is absent (headless, another host) the command says
// how to reach the tool instead of pretending it switched.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { PuppetWarpMachine } from "@paged-media/draw-tools";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import {
  failed,
  numberOr,
  payloadOf,
  pointOf,
  pointsOf,
  readDistortTargets,
  writeDistorted,
  type DistortTarget,
  type Pt,
} from "./distort-shared";
import { EDITABLE_PATH_KINDS } from "./path-rewrite";

const M = defineMessages("draw.puppetWarp", {
  warp: "Puppet warp the selection",
  tool: "Puppet warp",
});

const C = "media.paged.draw.command";
export const PUPPET_WARP_COMMAND_ID = `${C}.puppetWarp`;
export const PUPPET_WARP_TOOL_COMMAND_ID = `${C}.puppetWarpTool`;
export const PUPPET_WARP_TOOL_ID = "media.paged.draw.tool.puppetWarp";
export const PUPPET_COMMAND_IDS = [
  PUPPET_WARP_COMMAND_ID,
  PUPPET_WARP_TOOL_COMMAND_ID,
] as const;

/** The pick radius the command uses for `from` / `holds` (pt). */
const PICK_PT = 4;

/** Mesh `targets`, pin, drag; write. False when nothing moved. */
export async function applyPuppetWarp(
  host: BundleHost,
  targets: readonly DistortTarget[],
  args: { holds: readonly Pt[]; from: Pt; to: Pt; autoPins: number },
): Promise<boolean> {
  if (targets.length === 0) return false;
  const machine = new PuppetWarpMachine({
    targets: targets.map((t) => t.page),
    tolerance: PICK_PT,
    autoPinCount: Math.max(0, Math.round(args.autoPins)),
  });
  if (!machine.usable) return false;
  for (const h of args.holds) {
    machine.handle({ type: "down", point: h });
    machine.handle({ type: "up", point: h });
  }
  machine.handle({ type: "down", point: args.from });
  const snap = machine.handle({ type: "up", point: args.to });
  if (!snap.commit) return false;
  return writeDistorted(
    host,
    "puppet warp",
    snap.commit.map((page, i) => ({ target: targets[i]!, page })),
  );
}

export async function runPuppetWarp(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const from = pointOf(p.from);
  const to = pointOf(p.to);
  if (!from || !to)
    failed("a puppet warp needs the pin to drag (from) and where it goes (to)");
  const ids = host.selection
    .get()
    .filter((i) => EDITABLE_PATH_KINDS.has(i.kind));
  if (ids.length === 0) failed("select the paths to warp");
  const targets = await readDistortTargets(host, ids);
  const ok = await applyPuppetWarp(host, targets, {
    holds: pointsOf(p.holds),
    from: from!,
    to: to!,
    autoPins: numberOr(p.autoPins, 0),
  });
  if (!ok)
    failed("the selection has no outline to warp, or the pin did not move");
  return null;
}

/** The editor's command registry, read structurally (see the header). */
function invokeDoorOf(
  paged: unknown,
): ((id: string) => Promise<unknown>) | null {
  const commands = (
    paged as { registries?: { commands?: { invoke?: unknown } } } | null
  )?.registries?.commands;
  const invoke = commands?.invoke;
  return typeof invoke === "function"
    ? (id: string) =>
        Promise.resolve((invoke as (id: string) => unknown).call(commands, id))
    : null;
}

export function contributePuppetWarpCommands(host: BundleHost): Disposable {
  const subs = [
    registerCommand(host, {
      id: PUPPET_WARP_COMMAND_ID,
      title: M.warp,
      category: "Transform",
      handler: async (_paged, payload) => {
        if (payload !== undefined) return runPuppetWarp(host, payload);
        host.log.info(
          `${PUPPET_WARP_COMMAND_ID}: pick the Puppet Warp tool to pin and drag the selection`,
        );
        return null;
      },
    }),
    registerCommand(host, {
      id: PUPPET_WARP_TOOL_COMMAND_ID,
      title: M.tool,
      category: "Transform",
      handler: async (paged) => {
        const invoke = invokeDoorOf(paged) ?? invokeDoorOf(host.editor);
        if (!invoke) {
          host.log.info(
            `${PUPPET_WARP_TOOL_COMMAND_ID}: this host cannot switch tools for a plugin — pick Puppet Warp in the Free Transform flyout`,
          );
          return { activated: false };
        }
        try {
          await invoke(`paged.tool.activate.${PUPPET_WARP_TOOL_ID}`);
          return { activated: true };
        } catch (e) {
          host.log.warn(`${PUPPET_WARP_TOOL_COMMAND_ID}: ${String(e)}`);
          return { activated: false };
        }
      },
    }),
  ];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
