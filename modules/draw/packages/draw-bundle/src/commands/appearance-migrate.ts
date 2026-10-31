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

// THE MIGRATION of draw's metadata appearance stacks (draw ADR 354) to
// the engine's native appearance (engine ADR 1043), on open (WP6.3, draw
// ADR 367). When the host's engine draws native appearance, every element
// whose envelope still holds a stack is moved over in ONE batch — one
// undo step for the whole document:
//
//   · an UNBAKED stack: `migrateAppearanceMutations` — the lower fills
//     and strokes become native layers around the frame's own fill and
//     stroke (which already paint the top ones), the top layers' opacity
//     and blend go to the frame's fill and stroke targets, and the
//     envelope's stack is removed;
//   · a GROUP-BAKED stack (ADR 354's group of single-paint items): the
//     bake's release batch first (the group dissolved, the derived layers
//     deleted, the carrier's paint restored), then the same migration —
//     the engine draws what the group drew, IDML export bakes it again.
//
// GRAPHIC STYLES move with them: the library part is converted to native
// styles (v2, `nativeStyleOf`) and written back — a container write,
// outside the undo stack like every library write — and every element
// whose link was IN SYNC before gets its revision re-stamped to what it
// now reads, in a second batch that AMENDS the first (engine ADR 1004),
// so a style's followers do not turn up "overridden" by the move.
//
// IDEMPOTENT: a migrated envelope holds no stack and a v2 library needs
// no conversion, so a second run finds nothing; a document opened again
// does not move twice. A refusal leaves the document as it was (the batch
// is atomic) and is logged.

import type {
  BundleHost,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import { appearanceOf, withAppearance } from "./appearance";
import {
  appearanceBakeOf,
  bakedLayersOf,
  releaseBatchFor,
  stampDrawMetadata,
  withAppearanceBake,
} from "./appearance-bake";
import {
  graphicAppearanceDigest,
  graphicStyleOverridden,
  graphicStyleRefOf,
  isNativeStyleAppearance,
  nativeLibraryOf,
  parseGraphicStyleLibrary,
  readGraphicAppearanceAs,
  withGraphicStyleRef,
  writeGraphicStyleLibrary,
  GRAPHIC_STYLES_FEATURE,
  GRAPHIC_STYLES_PART,
  type GraphicStyleRef,
} from "./graphic-styles";
import { readRecipeBytes } from "../recipe-store";
import {
  migrateAppearanceMutations,
  nativeAppearanceOn,
} from "./appearance-native";
import { batchChildrenOf, batchMutationFor } from "./batch-handles";
import { parentGroupOf } from "./parentage";
import { linkIndex } from "../link-index";

/** What a migration moved. */
export interface AppearanceMigration {
  /** Elements whose stack is now native. */
  moved: number;
  /** Of those, the ones that were group-baked and released first. */
  released: number;
  /** Graphic-style links re-stamped to their native revision. */
  restamped: number;
  /** Whether the graphic-style library was converted to native styles. */
  library: boolean;
}

const hasStack = (env: PluginMetadataEnvelope | null) => {
  const s = appearanceOf(env);
  return s.fills.length + s.strokes.length > 0;
};

/** The ops that move one element's stack onto the engine (empty when it
 *  has none). */
async function migrationOpsFor(
  host: BundleHost,
  id: ElementId,
  env: PluginMetadataEnvelope | null,
): Promise<{ ops: Mutation[]; released: boolean }> {
  if (!hasStack(env)) return { ops: [], released: false };
  const record = appearanceBakeOf(env);
  if (!record)
    return { ops: migrateAppearanceMutations(id, env), released: false };
  const stack = appearanceOf(env);
  const released = withAppearanceBake(withAppearance(env, stack), null);
  const roots = await linkIndex(host).tree();
  const release = releaseBatchFor({
    carrier: id,
    group: parentGroupOf(roots, id),
    layers: await bakedLayersOf(host, id, record),
    record,
    stack,
    carrierEnvelope: released,
  });
  return {
    ops: [
      ...batchChildrenOf(release),
      ...migrateAppearanceMutations(id, released),
    ],
    released: true,
  };
}

/** Move every metadata stack of the open document onto the engine's
 *  native appearance, in one batch, and the graphic styles with them.
 *  Null when there is nothing to move or the engine draws no native
 *  appearance. */
export async function migrateAppearanceStacks(
  host: BundleHost,
): Promise<AppearanceMigration | null> {
  const label = "Migrate appearances";
  if (!nativeAppearanceOn(host)) return null;
  const index = linkIndex(host);
  index.invalidate();
  const snap = await index.snapshot();
  const ops: Mutation[] = [];
  let moved = 0;
  let released = 0;
  // The graphic-style links that are in sync TODAY (the metadata lane's
  // reading): they stay in sync after the move.
  const inSync: { id: ElementId; ref: GraphicStyleRef }[] = [];
  for (const { id, envelope } of snap.linked) {
    const ref = graphicStyleRefOf(envelope);
    if (ref) {
      const before = await readGraphicAppearanceAs(host, id, false);
      if (!graphicStyleOverridden(ref, before.appearance))
        inSync.push({ id, ref });
    }
    const one = await migrationOpsFor(host, id, envelope);
    if (one.ops.length === 0) continue;
    ops.push(...one.ops);
    moved++;
    if (one.released) released++;
  }
  let appliedSeq: number | undefined;
  if (ops.length > 0) {
    const out = await host.document.mutate(batchMutationFor(ops), { label });
    if (!out.applied) {
      host.log.warn(
        `${label}: refused by the engine: ${JSON.stringify(out.error)}`,
      );
      return null;
    }
    appliedSeq = (out as { appliedSeq?: number }).appliedSeq;
  }
  // The links, re-stamped to what the native reading now digests.
  const stamps: Mutation[] = [];
  for (const { id, ref } of inSync) {
    const now = await readGraphicAppearanceAs(host, id, true);
    const rev = graphicAppearanceDigest(now.appearance);
    if (rev === ref.rev) continue;
    stamps.push(
      stampDrawMetadata(
        id,
        withGraphicStyleRef(now.envelope, { id: ref.id, rev }),
      ),
    );
  }
  if (stamps.length > 0) {
    const amend =
      typeof appliedSeq === "number" && host.supports("document.mutate.amend@1")
        ? { amend: appliedSeq, label }
        : { label };
    const out = await host.document.mutate(batchMutationFor(stamps), amend);
    if (!out.applied)
      host.log.warn(
        `${label}: the style links could not be re-stamped: ${JSON.stringify(out.error)}`,
      );
  }
  // The library, written back as native styles.
  let library = false;
  if (host.supports(GRAPHIC_STYLES_FEATURE)) {
    const raw = parseGraphicStyleLibrary(
      await readRecipeBytes(host, GRAPHIC_STYLES_PART).catch(() => null),
    );
    if (raw.styles.some((st) => !isNativeStyleAppearance(st.appearance)))
      library = await writeGraphicStyleLibrary(host, nativeLibraryOf(raw));
  }
  if (moved === 0 && stamps.length === 0 && !library) return null;
  host.log.info(
    `${label}: ${moved} appearance(s) moved onto the engine's native appearance` +
      (released ? ` (${released} released from a baked group first)` : "") +
      (stamps.length ? `, ${stamps.length} style link(s) re-stamped` : "") +
      (library ? ", the graphic-style library converted" : ""),
  );
  return { moved, released, restamped: stamps.length, library };
}

/** Run the migration now (a document may already be open) and whenever
 *  a document opens. Serialised: an open during a run waits for it. */
export function installAppearanceMigration(host: BundleHost): {
  dispose(): void;
  /** Resolves when the runs started so far have finished (specs). */
  idle(): Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  const run = () => {
    chain = chain
      .then(() => migrateAppearanceStacks(host))
      .then(
        () => undefined,
        (e) => host.log.warn(`Migrate appearances: ${String(e)}`),
      );
  };
  run();
  let sub: { dispose(): void } | null = null;
  try {
    sub = host.document.onDidOpen(run);
  } catch {
    sub = null;
  }
  return {
    dispose: () => sub?.dispose(),
    idle: () => chain,
  };
}
