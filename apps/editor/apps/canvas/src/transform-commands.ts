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

// WP4.4 — the typed commands that move objects in spread space: Align
// (`paged.align.objects`, align-plan.ts) and Transform Each
// (`paged.object.transformEach`, transform-each-plan.ts). Both read
// through the invoking editor's canvas client (spread-targets.ts) and
// commit through `host.objects`: ONE batch, one undo step. The canvas
// app and the headless editor register them from here, so the two run
// the same code.

import type { ElementId } from "@paged-media/client";
import type {
  CommandContribution,
  ShellObjectOp,
  ShellObjectWriteResult,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import {
  ALIGN_ARGS,
  ALIGN_COMMAND,
  runAlign,
  type AlignArgs,
} from "./align-plan";
import {
  readAlignPages,
  readSpreadTargets,
  type SpreadReadClient,
} from "./spread-targets";
import {
  runTransformEach,
  TRANSFORM_EACH_ARGS,
  TRANSFORM_EACH_COMMAND,
  type TransformEachArgs,
} from "./transform-each-plan";

const M = defineMessages("app.transformCommands", {
  alignObjects: "Align objects",
  transformEach: "Transform each",
});

/** What the commands commit through (`host.objects`' batch). */
export interface TransformCommandObjects {
  batch(
    ops: readonly ShellObjectOp[],
    opts?: { label?: string },
  ): Promise<ShellObjectWriteResult>;
}

const clientOf = (paged: unknown): SpreadReadClient => {
  const client = (paged as { client?: SpreadReadClient } | null)?.client;
  if (!client) throw new Error("failed: no canvas client to read from");
  return client;
};

export function buildTransformCommands(
  objects: TransformCommandObjects,
  elementIdOf?: (address: string) => ElementId | null,
): CommandContribution[] {
  const targetsOf = (paged: unknown) => (addresses: readonly string[]) =>
    readSpreadTargets(clientOf(paged), addresses, elementIdOf);
  return [
    {
      id: ALIGN_COMMAND,
      get title() {
        return t(M.alignObjects);
      },
      category: "Object",
      args: ALIGN_ARGS,
      handler: (paged: unknown, payload?: unknown) =>
        runAlign(
          {
            targets: targetsOf(paged),
            pages: () => readAlignPages(clientOf(paged)),
            batch: (ops, opts) => objects.batch(ops, opts),
          },
          payload as AlignArgs,
        ),
    },
    {
      id: TRANSFORM_EACH_COMMAND,
      get title() {
        return t(M.transformEach);
      },
      category: "Object",
      args: TRANSFORM_EACH_ARGS,
      handler: (paged: unknown, payload?: unknown) =>
        runTransformEach(
          {
            targets: targetsOf(paged),
            batch: (ops, opts) => objects.batch(ops, opts),
          },
          payload as TransformEachArgs,
        ),
    },
  ];
}
