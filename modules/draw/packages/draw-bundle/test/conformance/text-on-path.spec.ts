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

// TYPE ON A PATH conformance — the C-29 protocol-58 pair through the
// REAL engine wasm the harness boots. Pins:
//   (1) the ENGINE-OP PROBE gate (attachTextToPath + detachTextFromPath
//       are really in this build's vocabulary);
//   (2) the EXACT wire shapes, including that `pathEffect` is NEVER
//       emitted — only RainbowPathEffect renders, so core exposes no
//       knob and neither does this bundle;
//   (3) the MEASURED undo shape: ONE batch ⇒ exactly ONE undo step for
//       attach and detach, proven by showing the SECOND undo takes the
//       PREVIOUS mutation instead;
//   (4) the FREE-STORY resolution — the half `frameChain` alone cannot
//       answer, because a story already flowing along a PATH reports an
//       empty frame chain exactly like an unflowed one;
//   (5) the REFUSALS with the engine's own sentence: an oval host, a
//       TEXT FRAME host (its glyphs come from the story pass), a story
//       already flowing into a frame, a story already on another path,
//       an unknown story, a detach on a path carrying nothing;
//   (6) the TOOL: click attaches, alt+click detaches, a text frame under
//       the click is refused with the reason, empty canvas is a no-op.

import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  CommandContribution,
  ElementId,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyAttachTextToPath,
  applyDetachTextFromPath,
  attachTextToPathMutationFor,
  createTypeOnPathHandler,
  detachTextFromPathMutationFor,
  documentStories,
  engineOpVocabulary,
  flipPathEffectOf,
  freeStories,
  getTextOnPathStory,
  pathHostRefusal,
  pathTypeAlignmentOf,
  resolveAttachStory,
  setTextOnPathStory,
  supportsTextOnPath,
  textOnPathAttachBatchFor,
  textOnPathDetachBatchFor,
  textOnPathLinks,
  textOnPathOf,
  textPathSpecOf,
  v58RefusalReason,
  withTextOnPathKey,
  drawBundle,
  ATTACH_TEXT_TO_PATH_COMMAND_ID,
  BIND_TEXT_ON_PATH_STATUS,
  BIND_TEXT_ON_PATH_STORY,
  DETACH_TEXT_FROM_PATH_COMMAND_ID,
  FLIP_PATH_EFFECTS,
  NO_FREE_STORY_NOTE,
  PATH_TYPE_ALIGNMENTS,
  TEXT_ON_PATH_COMMAND_IDS,
  TEXT_ON_PATH_KINDS,
  TEXT_ON_PATH_TOOL_IDS,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: "urect" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const LINE = { kind: "graphicLine", id: "uline" } as ElementId;

function click(
  pageId: string,
  point: [number, number],
  alt = false,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function until(
  predicate: () => Promise<boolean>,
  what = "the type-on-path gesture to land",
): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leafKeys(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const id = node.id as { kind?: string; id?: string } | undefined;
      if (id?.id) out.push(`${id.kind}:${id.id}`);
      if (node.children) walk(node.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out;
}

/**
 * Mint an UNFLOWED story — the only way to get one on this wire, and
 * the exact recipe the refusal message tells a user to run by hand:
 * insert a text frame (which MINTS a story bound to it), type into it,
 * then delete the FRAME. `RemoveNode` does not touch `doc.stories`, so
 * the story survives with its text, flowing nowhere.
 *
 * Costs THREE undo steps, which is precisely why "just seed a story for
 * me" is NOT a command in this bundle (see commands/text-on-path.ts).
 */
async function mintFreeStory(h: HeadlessHost, text: string): Promise<string> {
  const before = new Set((await documentStories(h.host)).map((s) => s.selfId));
  const frame = await h.host.document.mutate({
    op: "insertTextFrame",
    args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
  });
  if (!frame.applied) throw new Error("insertTextFrame failed");
  const minted = (await documentStories(h.host)).find(
    (s) => !before.has(s.selfId),
  );
  if (!minted) throw new Error("insertTextFrame minted no story");
  const typed = await h.host.document.mutate({
    op: "insertText",
    args: { storyId: minted.selfId, offset: 0, text },
  });
  if (!typed.applied) throw new Error("insertText failed");
  const removed = await h.host.document.mutate({
    op: "deleteFrame",
    args: { frameId: String((frame.createdId as { id: unknown }).id) },
  });
  if (!removed.applied) throw new Error("deleteFrame failed");
  return minted.selfId;
}

describe("draw conformance — type on a path (C-29, engine protocol v58)", () => {
  // ------------------------------------------------------------- pure

  describe("the model + the wire builders (pure)", () => {
    it("emits the EXACT v58 shapes, omitting unset knobs rather than nulling them", () => {
      expect(attachTextToPathMutationFor(POLY, "Story/u0")).toEqual({
        op: "attachTextToPath",
        args: { elementId: POLY, storyId: "Story/u0" },
      });
      expect(
        attachTextToPathMutationFor(POLY, "Story/u0", {
          pathTypeAlignment: "CenterPathType",
          flipPathEffect: "Flipped",
          startBracket: 5,
          endBracket: 120,
        }),
      ).toEqual({
        op: "attachTextToPath",
        args: {
          elementId: POLY,
          storyId: "Story/u0",
          pathTypeAlignment: "CenterPathType",
          flipPathEffect: "Flipped",
          startBracket: 5,
          endBracket: 120,
        },
      });
      expect(detachTextFromPathMutationFor(POLY)).toEqual({
        op: "detachTextFromPath",
        args: { elementId: POLY },
      });
    });

    it("NEVER emits a pathEffect — only Rainbow renders, so no knob is offered", () => {
      // The deliberate absence, asserted rather than assumed: Skew,
      // 3D-ribbon, stair-step and gravity all parse and then draw as
      // Rainbow, so a control for them would be silently ignored.
      const full = attachTextToPathMutationFor(POLY, "Story/u0", {
        pathTypeAlignment: "CenterPathType",
        flipPathEffect: "Flipped",
        startBracket: 1,
        endBracket: 2,
      }) as { args: Record<string, unknown> };
      expect(Object.keys(full.args).sort()).toEqual([
        "elementId",
        "endBracket",
        "flipPathEffect",
        "pathTypeAlignment",
        "startBracket",
        "storyId",
      ]);
      expect("pathEffect" in full.args).toBe(false);
    });

    it("the attach batch is the op PLUS the host's stamp — one batch, one step", () => {
      const batch = textOnPathAttachBatchFor({
        element: POLY,
        storyId: "Story/u0",
        spec: { pathTypeAlignment: "CenterPathType" },
        envelope: null,
      }) as { op: string; args: { ops: { op: string; args: unknown }[] } };
      expect(batch.op).toBe("batch");
      expect(batch.args.ops.map((o) => o.op)).toEqual([
        "attachTextToPath",
        "setPluginMetadata",
      ]);
      const stamp = batch.args.ops[1]!.args as { value: string };
      expect(JSON.parse(stamp.value)).toEqual({
        v: 1,
        data: {
          textOnPath: {
            story: "Story/u0",
            pathTypeAlignment: "CenterPathType",
            flipPathEffect: null,
            startBracket: null,
            endBracket: null,
          },
        },
      });
    });

    it("the detach batch unstamps WITHOUT taking another feature's keys", () => {
      const batch = textOnPathDetachBatchFor({
        element: POLY,
        envelope: {
          v: 1,
          data: {
            textOnPath: { story: "Story/u0" },
            graphicStyle: { id: "gs-1" },
          },
        },
      }) as { op: string; args: { ops: { op: string; args: unknown }[] } };
      expect(batch.args.ops.map((o) => o.op)).toEqual([
        "detachTextFromPath",
        "setPluginMetadata",
      ]);
      const stamp = batch.args.ops[1]!.args as { value: string };
      expect(JSON.parse(stamp.value)).toEqual({
        v: 1,
        data: { graphicStyle: { id: "gs-1" } },
      });
    });

    it("coerces payload knobs to values core accepts, dropping the rest", () => {
      expect(pathTypeAlignmentOf("CenterPathType")).toBe("CenterPathType");
      expect(pathTypeAlignmentOf("SpiralPathType")).toBeNull();
      expect(pathTypeAlignmentOf(7)).toBeNull();
      // A checkbox payload is the natural caller shape for the flip.
      expect(flipPathEffectOf(true)).toBe("Flipped");
      expect(flipPathEffectOf(false)).toBe("NotFlipped");
      expect(flipPathEffectOf("Flipped")).toBe("Flipped");
      expect(flipPathEffectOf("upside-down")).toBeNull();
      expect(
        textPathSpecOf({
          pathTypeAlignment: "AscenderPathType",
          flipPathEffect: true,
          startBracket: 3,
          endBracket: "nope",
        }),
      ).toEqual({
        pathTypeAlignment: "AscenderPathType",
        flipPathEffect: "Flipped",
        startBracket: 3,
        endBracket: null,
      });
    });

    it("the envelope round-trips, and an empty envelope clears to null", () => {
      const ref = {
        story: "Story/u0",
        pathTypeAlignment: "BaselinePathType" as const,
        flipPathEffect: null,
        startBracket: null,
        endBracket: 90,
      };
      const env = withTextOnPathKey(null, ref);
      expect(textOnPathOf(env)).toEqual(ref);
      expect(withTextOnPathKey(env, null)).toBeNull();
      expect(textOnPathOf(null)).toBeNull();
      expect(textOnPathOf({ v: 1, data: { textOnPath: { story: "" } } })).toBeNull();
    });

    it("the host-kind mirror and the tool's pre-explanations match core's gate", () => {
      expect([...TEXT_ON_PATH_KINDS].sort()).toEqual([
        "graphicLine",
        "polygon",
        "rectangle",
      ]);
      // An OVAL is out — the model gives it no text_paths and the
      // renderer's pass never walks one.
      expect(TEXT_ON_PATH_KINDS.has("oval")).toBe(false);
      expect(pathHostRefusal("polygon")).toBeNull();
      expect(pathHostRefusal("textFrame")).toContain("STORY pass");
      expect(pathHostRefusal("oval")).toContain("draw nothing");
      expect(pathHostRefusal("group")).toContain(
        "Rectangle / GraphicLine / Polygon",
      );
    });

    it("the knob vocabularies are exactly core's", () => {
      expect([...PATH_TYPE_ALIGNMENTS]).toEqual([
        "BaselinePathType",
        "CenterPathType",
        "AscenderPathType",
        "DescenderPathType",
      ]);
      expect([...FLIP_PATH_EFFECTS]).toEqual(["NotFlipped", "Flipped"]);
    });

    it("the no-free-story message stays ACTIONABLE, not just a refusal", () => {
      // It must name (a) that this flows an EXISTING story, (b) that no
      // create-story op exists, and (c) the workflow that produces one.
      expect(NO_FREE_STORY_NOTE).toContain("EXISTING STORY");
      expect(NO_FREE_STORY_NOTE).toContain("no create-story op");
      expect(NO_FREE_STORY_NOTE).toContain("delete the FRAME");
    });
  });

  // ---------------------------------------------------- the real engine

  describe("against the real engine (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    // A FRESH document per test: the undo arithmetic and the free-story
    // arithmetic are only readable from a known baseline.
    beforeEach(async () => {
      await h.load(F1_MULTI_SHAPE.bytes());
      await h.host.selection.set([]);
      setTextOnPathStory(null);
      h.host.bindings.publish(BIND_TEXT_ON_PATH_STATUS, null);
    });

    it("THE GATE: this engine's op vocabulary carries both C-29 ops", async () => {
      const vocab = await engineOpVocabulary(h.host);
      expect(vocab).not.toBeNull();
      expect(vocab!.has("attachTextToPath")).toBe(true);
      expect(vocab!.has("detachTextFromPath")).toBe(true);
      expect(await supportsTextOnPath(h.host)).toBe(true);
    });

    it("registers the two commands with titles that name the honest scope", () => {
      for (const id of TEXT_ON_PATH_COMMAND_IDS) {
        expect(commandFor(h, id).category).toBe("Type");
      }
      expect(commandFor(h, ATTACH_TEXT_TO_PATH_COMMAND_ID).title).toContain(
        "flows an EXISTING story — no story is created",
      );
      expect(commandFor(h, DETACH_TEXT_FROM_PATH_COMMAND_ID).title).toContain(
        "the story survives",
      );
    });

    it("INV-REG-1: the tool takes shift+h — shift+t belongs to the INERT built-in", () => {
      const tools = h
        .toolsContributed()
        .filter((t) => (TEXT_ON_PATH_TOOL_IDS as readonly string[]).includes(t.id));
      expect(tools.map((t) => t.id)).toEqual([...TEXT_ON_PATH_TOOL_IDS]);
      expect(tools[0]!.shortcut).toBe("shift+h");
      // It sits in the built-in `type` group, one slot past the editor's
      // gesture-less `paged.tool.typePath` placeholder, and borrows that
      // placeholder's REAL glyph token (an invented one renders the rail
      // button glyphless — the stroke panel's recorded lesson).
      expect(tools[0]!.group).toBe("type");
      expect(tools[0]!.icon).toBe("tool-typePath");
      const all = h.toolsContributed().map((t) => t.shortcut);
      expect(new Set(all).size).toBe(all.length);
      expect(all).not.toContain("shift+t");
      expect(all).not.toContain("t");
    });

    // ------------------------------------------------- free stories

    it("a story flowing into a FRAME is not free; deleting the frame frees it", async () => {
      expect(await freeStories(h.host)).toEqual([]);
      const before = new Set((await documentStories(h.host)).map((s) => s.selfId));
      const frame = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
      });
      if (!frame.applied) throw new Error("insertTextFrame failed");
      const minted = (await documentStories(h.host)).find(
        (s) => !before.has(s.selfId),
      )!;
      // The story exists but flows into the frame — NOT free.
      expect((await freeStories(h.host)).map((s) => s.selfId)).toEqual([]);
      expect(
        (await h.host.document.frameChain(minted.selfId)).map((l) => l.frameId),
      ).toHaveLength(1);
      await h.host.document.mutate({
        op: "deleteFrame",
        args: { frameId: String((frame.createdId as { id: unknown }).id) },
      });
      expect((await freeStories(h.host)).map((s) => s.selfId)).toEqual([
        minted.selfId,
      ]);
    });

    it("ATTACH links the story and stamps the host — ONE undo step", async () => {
      const story = await mintFreeStory(h, "Hello path");
      expect((await freeStories(h.host)).map((s) => s.selfId)).toEqual([story]);

      const ref = await applyAttachTextToPath(h.host, {
        elementId: POLY,
        pathTypeAlignment: "CenterPathType",
        flipPathEffect: true,
        startBracket: 4,
        endBracket: 150,
      });
      expect(ref).toEqual({
        story,
        pathTypeAlignment: "CenterPathType",
        flipPathEffect: "Flipped",
        startBracket: 4,
        endBracket: 150,
      });
      expect(textOnPathOf(await h.host.document.getMetadata(POLY))).toEqual(ref);
      expect((await textOnPathLinks(h.host)).map((l) => l.ref.story)).toEqual([
        story,
      ]);
      // The story is no longer free — and note this is EXACTLY the case
      // frameChain alone cannot see: a path-attached story has no frame
      // chain, so without the stamp it would still look free.
      expect(await h.host.document.frameChain(story)).toEqual([]);
      expect(await freeStories(h.host)).toEqual([]);

      // MEASURED, not claimed: ONE undo drops both the link and the
      // stamp…
      await h.host.document.undo();
      expect(await h.host.document.getMetadata(POLY)).toBeNull();
      const reDetach = await h.host.document.mutate(
        detachTextFromPathMutationFor(POLY),
      );
      if (reDetach.applied) throw new Error("expected the engine to refuse");
      expect(v58RefusalReason(reDetach.error)).toBe(
        "the element hosts no text-on-a-path",
      );
      // …and the SECOND undo takes the PREVIOUS mutation (the mint's
      // deleteFrame), which is what proves the attach consumed one step.
      await h.host.document.undo();
      expect((await leafKeys(h)).some((k) => k.startsWith("textFrame:"))).toBe(
        true,
      );
    });

    it("DETACH frees the story again and KEEPS it — ONE undo step", async () => {
      const story = await mintFreeStory(h, "Round trip");
      await applyAttachTextToPath(h.host, { elementId: LINE });
      expect(await freeStories(h.host)).toEqual([]);

      await h.host.selection.set([LINE]);
      expect(await applyDetachTextFromPath(h.host)).toBe(true);
      expect(await h.host.document.getMetadata(LINE)).toBeNull();
      // THE STORY SURVIVES — detach unlinks, it does not delete.
      const stories = await documentStories(h.host);
      expect(stories.map((s) => s.selfId)).toContain(story);
      expect(stories.find((s) => s.selfId === story)!.characterCount).toBe(
        "Round trip".length,
      );
      expect((await freeStories(h.host)).map((s) => s.selfId)).toEqual([story]);

      // ONE undo re-attaches with the record intact.
      await h.host.document.undo();
      expect(textOnPathOf(await h.host.document.getMetadata(LINE))?.story).toBe(
        story,
      );
    });

    it("a RECTANGLE hosts type on a path too (it carries text_paths)", async () => {
      await mintFreeStory(h, "On a rectangle");
      expect(await applyAttachTextToPath(h.host, { elementId: RECT })).not.toBeNull();
      expect(textOnPathOf(await h.host.document.getMetadata(RECT))).not.toBeNull();
    });

    // ---------------------------------------------------- the refusals

    it("REFUSES an OVAL host — the renderer's pass never walks one", async () => {
      const story = await mintFreeStory(h, "Nope");
      const oval = await h.host.document.mutate({
        op: "insertOval",
        args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [400, 400, 500, 500] },
      });
      expect(oval.applied).toBe(true);
      expect(
        await applyAttachTextToPath(h.host, {
          elementId: (oval as { createdId: ElementId }).createdId,
          storyId: story,
        }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toContain(
        "cannot host text-on-a-path",
      );
    });

    it("REFUSES a TEXT FRAME host, saying WHY (its glyphs come from the story pass)", async () => {
      const frame = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
      });
      const story = await mintFreeStory(h, "Nope");
      expect(
        await applyAttachTextToPath(h.host, {
          elementId: (frame as { createdId: ElementId }).createdId,
          storyId: story,
        }),
      ).toBeNull();
      const reason = String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS));
      expect(reason).toContain("a TextFrame cannot host text-on-a-path");
      expect(reason).toContain("text-path pass walks");
    });

    it("REFUSES a story that already flows into a text frame (one story, one flow)", async () => {
      const before = new Set((await documentStories(h.host)).map((s) => s.selfId));
      await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
      });
      const flowed = (await documentStories(h.host)).find(
        (s) => !before.has(s.selfId),
      )!.selfId;
      expect(
        await applyAttachTextToPath(h.host, { elementId: POLY, storyId: flowed }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toContain(
        "already flows into a text frame",
      );
    });

    it("REFUSES a story already attached to another path", async () => {
      const story = await mintFreeStory(h, "Only once");
      await applyAttachTextToPath(h.host, { elementId: POLY });
      expect(
        await applyAttachTextToPath(h.host, { elementId: LINE, storyId: story }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toContain(
        "already attached to a path",
      );
    });

    it("REFUSES an unknown story id with the engine's own sentence", async () => {
      expect(
        await applyAttachTextToPath(h.host, {
          elementId: POLY,
          storyId: "Story/ghost",
        }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toBe(
        "no story `Story/ghost` in this document",
      );
    });

    it("with NO free story, the refusal NAMES the workflow that makes one", async () => {
      expect(await applyAttachTextToPath(h.host, { elementId: POLY })).toBeNull();
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toBe(
        NO_FREE_STORY_NOTE,
      );
    });

    it("with SEVERAL free stories it refuses to guess — and lists them", async () => {
      const first = await mintFreeStory(h, "One");
      const second = await mintFreeStory(h, "Two");
      const resolved = await resolveAttachStory(h.host);
      expect(resolved.storyId).toBeNull();
      const reason = (resolved as { reason: string }).reason;
      expect(reason).toContain(first);
      expect(reason).toContain(second);
      // …unless one is PENDING, which is what the picker sets.
      setTextOnPathStory(second);
      expect((await resolveAttachStory(h.host)).storyId).toBe(second);
      // A pending story that is NO LONGER FREE is not honoured: after
      // `second` lands on a path, the pick falls through to the only
      // remaining free story rather than aiming at one the engine would
      // refuse.
      await applyAttachTextToPath(h.host, { elementId: POLY, storyId: second });
      setTextOnPathStory(second);
      expect((await resolveAttachStory(h.host)).storyId).toBe(first);
    });

    it("attaching clears the pending pick, so the next click does not re-aim at it", async () => {
      const story = await mintFreeStory(h, "Pending");
      setTextOnPathStory(story);
      expect(getTextOnPathStory()).toBe(story);
      await applyAttachTextToPath(h.host, { elementId: POLY });
      expect(getTextOnPathStory()).toBeNull();
    });

    it("DETACHING a path that carries nothing reports the engine's sentence", async () => {
      await h.host.selection.set([POLY]);
      expect(await applyDetachTextFromPath(h.host)).toBe(false);
      expect(String(h.host.bindings.get(BIND_TEXT_ON_PATH_STATUS))).toBe(
        "the element hosts no text-on-a-path",
      );
    });

    // -------------------------------------------------------- the tool

    it("the TOOL attaches on click and DETACHES on alt+click", async () => {
      const story = await mintFreeStory(h, "Tool driven");
      const handler = createTypeOnPathHandler(h.host);
      handler.onActivate(undefined as never);
      // The readout publishes what a click would place.
      await until(
        async () => h.host.bindings.get(BIND_TEXT_ON_PATH_STORY) === story,
        "the pending-story readout",
      );
      // (200, 200) is inside F1's rectangle (100..300 square).
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [200, 200]));
      await until(
        async () =>
          textOnPathOf(await h.host.document.getMetadata(RECT))?.story === story,
      );
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [200, 200], true));
      await until(async () => (await h.host.document.getMetadata(RECT)) === null);
      // …and the story is free again, so the readout comes back.
      await until(
        async () => h.host.bindings.get(BIND_TEXT_ON_PATH_STORY) === story,
        "the readout after detach",
      );
      handler.onDeactivate("switch");
    });

    it("the TOOL refuses a TEXT FRAME under the click and writes nothing", async () => {
      await mintFreeStory(h, "Not here");
      const frame = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [400, 400, 560, 500] },
      });
      const frameId = (frame as { createdId: ElementId }).createdId;
      const handler = createTypeOnPathHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [450, 450]));
      await new Promise((r) => setTimeout(r, 120));
      expect(await h.host.document.getMetadata(frameId)).toBeNull();
      expect(await h.host.document.getMetadata(RECT)).toBeNull();
      handler.onDeactivate("switch");
    });

    it("the TOOL is a no-op on empty canvas", async () => {
      await mintFreeStory(h, "Nowhere");
      const handler = createTypeOnPathHandler(h.host);
      handler.onActivate(undefined as never);
      // (760, 40) hits nothing in F1.
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [760, 40]));
      await new Promise((r) => setTimeout(r, 120));
      expect(await textOnPathLinks(h.host)).toEqual([]);
      handler.onDeactivate("switch");
    });
  });
});
