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
// Engine ADR 1042 — live vector effects through the SDK's doors on the
// real engine: the feature flag, the vector kinds on `frameEffectStack`
// through `host.objects`, the `expandAppearance` op and its core command,
// each one undo step.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

import { CORE_WIRE_OPS } from "../src/core-commands.generated";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { HOST_FEATURES } from "../src/host-impl";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function frameOn(h: HeadlessHost): Promise<ElementId> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [20, 20, 120, 120] },
  });
  if (!out.applied || !out.createdId) throw new Error("no frame inserted");
  return out.createdId;
}

const kinds = (v: unknown) =>
  ((v as { value?: Array<{ kind: string }> }).value ?? []).map((e) => e.kind);

describe("live vector effects (engine ADR 1042) [effects-transparency.live-vector-effects]", () => {
  it("is advertised, and expandAppearance is a core command", () => {
    expect(HOST_FEATURES).toContain("document.vectorEffects@1");
    expect(Object.keys(CORE_WIRE_OPS)).toContain("expandAppearance");
  });

  it("a zig zag is a stack entry; expandAppearance keeps it; each is one undo step", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.vectorEffects@1")).toBe(true);
    const id = await frameOn(h);
    const address = `frame:${String(id.id)}`;
    const out = await h.objects.set(address, "frameEffectStack", [
      { kind: "zigZag", enabled: true, size: 6, ridges: 3 },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(kinds(await h.objects.get(address, "frameEffectStack"))).toEqual([
      "zigZag",
    ]);

    const expanded = await h.host.document.mutate({
      op: "expandAppearance",
      args: { elementId: id },
    });
    expect(expanded.applied).toBe(true);
    expect(kinds(await h.objects.get(address, "frameEffectStack"))).toEqual([]);
    await h.host.document.undo();
    expect(kinds(await h.objects.get(address, "frameEffectStack"))).toEqual([
      "zigZag",
    ]);

    // Nothing to expand is refused, as an outcome.
    await h.host.document.undo();
    const refused = await h.host.document.mutate({
      op: "expandAppearance",
      args: { elementId: id },
    });
    expect(refused.applied).toBe(false);
  });
});
