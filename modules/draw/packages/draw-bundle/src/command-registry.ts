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

// THE ONE COMMAND DOOR. Every command module registers through
// `registerCommand(host, …)` rather than `host.contribute.command(…)`
// directly, so the bundle keeps its own table of handlers per host.
//
// WHY. The contract has no "run command <id>" door (a command runs when
// the EDITOR dispatches it), and ADR 323's TYPED commands — the twins the
// CLI, Boa and `host.objects.invoke` call — must run exactly the code the
// untyped command runs, not a second copy that drifts. So a typed twin
// (`object-model/typed-commands.ts`) looks its untyped handler up HERE by
// id and calls it with the payload its typed args lower to.
//
// The table is keyed by the host object (a WeakMap), like the link index,
// so two hosts in one process (the headless harness loads several) never
// see each other's handlers, and a disposed registration leaves it.

import type {
  BundleHost,
  CommandContribution,
  Disposable,
} from "@paged-media/plugin-api";

export type CommandHandler = CommandContribution["handler"];

const tables = new WeakMap<object, Map<string, CommandHandler>>();

/** Register a command through the host AND record its handler. */
export function registerCommand(
  host: BundleHost,
  command: CommandContribution,
): Disposable {
  let table = tables.get(host);
  if (!table) {
    table = new Map();
    tables.set(host, table);
  }
  const sub = host.contribute.command(command);
  table.set(command.id, command.handler);
  const own = table;
  return {
    dispose() {
      if (own.get(command.id) === command.handler) own.delete(command.id);
      sub.dispose();
    },
  };
}

/** The handler registered for `id` on `host`, or undefined. */
export function commandHandler(
  host: BundleHost,
  id: string,
): CommandHandler | undefined {
  return tables.get(host)?.get(id);
}
