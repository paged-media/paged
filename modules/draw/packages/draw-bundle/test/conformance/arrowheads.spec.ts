// Phase 4c conformance — the v43 GraphicLine arrowhead lane behind the
// stroke panel's Line ends section. The section's pickers are
// schema-driven (the host's widget commits the property), so what THIS
// file pins is the WIRE CONTRACT the section stands on, against the
// real engine:
//   · every curated vocabulary token applies on a GraphicLine and
//     reads back through the typed property door;
//   · "" CLEARS (and is the cleared read-back spelling);
//   · an unknown token is REJECTED (outcome.applied false, never a
//     silent ArrowheadType::Other corruption);
//   · the property is GraphicLine-ONLY (a rectangle rejects) — the
//     engine gate the panel's published kind-binding mirrors;
//   · undo restores the prior end;
//   · the published `arrowheadControlsVisible` binding flips with the
//     selection's kind (the live gate of the panel section).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  ARROWHEAD_OPTIONS,
  BIND_ARROWHEAD_CONTROLS_VISIBLE,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const LINE = {
  kind: "graphicLine",
  id: F1_MULTI_SHAPE.ids.graphicLine!,
} as ElementId;
const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;

const setArrowhead = (
  elementId: ElementId,
  path: "frameStrokeStartArrowhead" | "frameStrokeEndArrowhead",
  token: string,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "text", value: token } },
});

async function readArrowheads(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ start: string | null; end: string | null }> {
  const props = await h.host.document.elementProperties(id);
  let start: string | null = null;
  let end: string | null = null;
  for (const entry of props?.entries ?? []) {
    const v = entry.value;
    if (!v || v.type !== "text") continue;
    if (entry.path === "frameStrokeStartArrowhead") start = v.value;
    if (entry.path === "frameStrokeEndArrowhead") end = v.value;
  }
  return { start, end };
}

describe("draw conformance — GraphicLine arrowheads (v43, Phase 4c)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("every curated picker token applies on a line and reads back verbatim", async () => {
    for (const option of ARROWHEAD_OPTIONS) {
      const outcome = await h.host.document.mutate(
        setArrowhead(LINE, "frameStrokeStartArrowhead", option.value),
      );
      expect(outcome.applied).toBe(true);
      const read = await readArrowheads(h, LINE);
      // "" is BOTH the clear spelling and the cleared read-back.
      expect(read.start).toBe(option.value);
    }
    // Leave the line clean for the specs below.
    const clear = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeStartArrowhead", ""),
    );
    expect(clear.applied).toBe(true);
  });

  it("start and end are independent slots", async () => {
    const a = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeStartArrowhead", "CircleSolidArrowHead"),
    );
    const b = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeEndArrowhead", "SimpleArrowHead"),
    );
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(await readArrowheads(h, LINE)).toEqual({
      start: "CircleSolidArrowHead",
      end: "SimpleArrowHead",
    });
    await h.host.document.undo();
    await h.host.document.undo();
    expect(await readArrowheads(h, LINE)).toEqual({ start: "", end: "" });
  });

  it("undo restores the prior end (inverse carries the old token)", async () => {
    const first = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeEndArrowhead", "TriangleArrowHead"),
    );
    expect(first.applied).toBe(true);
    const second = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeEndArrowhead", "BarArrowHead"),
    );
    expect(second.applied).toBe(true);
    await h.host.document.undo();
    expect((await readArrowheads(h, LINE)).end).toBe("TriangleArrowHead");
    await h.host.document.undo();
    expect((await readArrowheads(h, LINE)).end).toBe("");
  });

  it("an unknown token is REJECTED, not stored (the Other-corruption guard)", async () => {
    const outcome = await h.host.document.mutate(
      setArrowhead(LINE, "frameStrokeStartArrowhead", "NotAnArrowHead"),
    );
    expect(outcome.applied).toBe(false);
    expect((await readArrowheads(h, LINE)).start).toBe("");
  });

  it("the property is GraphicLine-only — a rectangle rejects (the panel gate's reason)", async () => {
    const outcome = await h.host.document.mutate(
      setArrowhead(RECT, "frameStrokeStartArrowhead", "SimpleArrowHead"),
    );
    expect(outcome.applied).toBe(false);
  });

  it("the published arrowheadControlsVisible binding flips with the selection's kind", async () => {
    await h.host.selection.set([LINE]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.bindings.get(BIND_ARROWHEAD_CONTROLS_VISIBLE)).toBe(true);

    await h.host.selection.set([RECT]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.bindings.get(BIND_ARROWHEAD_CONTROLS_VISIBLE)).toBe(false);

    await h.host.selection.set([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.bindings.get(BIND_ARROWHEAD_CONTROLS_VISIBLE)).toBe(false);
  });
});
