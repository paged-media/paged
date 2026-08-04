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

// OPACITY MASK conformance — the C-28 protocol-58 pair through the REAL
// engine wasm the harness boots. Pins:
//   (1) the ENGINE-OP PROBE: this build's mutation vocabulary really
//       carries applyOpacityMask + releaseOpacityMask. It is the gate —
//       without it every assertion below could be silently testing a
//       refusal path;
//   (2) the EXACT wire shapes (optional args omitted, never nulled);
//   (3) the MEASURED undo shape: ONE batch ⇒ exactly ONE undo step for
//       both make and release, proven by undoing twice and showing the
//       second undo has nothing of ours left to take;
//   (4) the REFUSALS reaching the user with the ENGINE'S OWN SENTENCE —
//       self-masking, an already-masked target, a grouped mask item, a
//       text frame — on the log and on the status binding;
//   (5) the HONESTY WORDING: the canvas/export asymmetry is in the
//       command title AND in OPACITY_MASK_CANVAS_NOTE, and neither may
//       be softened into a WYSIWYG claim.

import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyMakeOpacityMask,
  applyOpacityMaskMutationFor,
  applyReleaseOpacityMask,
  engineOpVocabulary,
  opacityMaskApplyBatchFor,
  opacityMaskLinks,
  opacityMaskOf,
  opacityMaskReleaseBatchFor,
  releaseOpacityMaskMutationFor,
  resolveMaskTarget,
  supportsOpacityMask,
  v58RefusalReason,
  withOpacityMaskKey,
  drawBundle,
  BIND_OPACITY_MASK_STATUS,
  DEFAULT_OPACITY_MASK_MODE,
  MAKE_OPACITY_MASK_COMMAND_ID,
  OPACITY_MASK_CANVAS_NOTE,
  OPACITY_MASK_COMMAND_IDS,
  OPACITY_MASK_KINDS,
  RELEASE_OPACITY_MASK_COMMAND_ID,
} from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

/** `ua` — the BACK square (100…300)². */
const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
/** `ub` — the FRONT square (200…400)²: the topmost, so the MASK. */
const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;

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

describe("draw conformance — opacity masks (C-28, engine protocol v58)", () => {
  // ------------------------------------------------------------- pure

  describe("the model + the wire builders (pure)", () => {
    it("emits the EXACT v58 shapes, omitting optional args rather than nulling them", () => {
      expect(applyOpacityMaskMutationFor({ targetId: A, maskId: B })).toEqual({
        op: "applyOpacityMask",
        args: { targetId: A, maskId: B },
      });
      expect(
        applyOpacityMaskMutationFor({
          targetId: A,
          maskId: B,
          maskType: "alpha",
          invert: true,
        }),
      ).toEqual({
        op: "applyOpacityMask",
        args: { targetId: A, maskId: B, maskType: "alpha", invert: true },
      });
      expect(releaseOpacityMaskMutationFor(A)).toEqual({
        op: "releaseOpacityMask",
        args: { targetId: A },
      });
    });

    it("the make batch is the op PLUS the target's stamp — one batch, one step", () => {
      const batch = opacityMaskApplyBatchFor({
        target: A,
        mask: B,
        maskType: "luminosity",
        invert: false,
        envelope: null,
      }) as { op: string; args: { ops: { op: string; args: unknown }[] } };
      expect(batch.op).toBe("batch");
      expect(batch.args.ops.map((o) => o.op)).toEqual([
        "applyOpacityMask",
        "setPluginMetadata",
      ]);
      const stamp = batch.args.ops[1]!.args as { value: string };
      expect(JSON.parse(stamp.value)).toEqual({
        v: 1,
        data: {
          opacityMask: {
            mask: { kind: "polygon", id: "ub" },
            maskType: "luminosity",
            invert: false,
          },
        },
      });
    });

    it("the release batch is the op PLUS the unstamp", () => {
      const batch = opacityMaskReleaseBatchFor({
        target: A,
        envelope: {
          v: 1,
          data: {
            opacityMask: { mask: { kind: "polygon", id: "ub" } },
            // Another feature's key on the SAME element — releasing a
            // mask must not take it with it.
            appearance: { layers: [] },
          },
        },
      }) as { op: string; args: { ops: { op: string; args: unknown }[] } };
      expect(batch.args.ops.map((o) => o.op)).toEqual([
        "releaseOpacityMask",
        "setPluginMetadata",
      ]);
      const stamp = batch.args.ops[1]!.args as { value: string };
      expect(JSON.parse(stamp.value)).toEqual({
        v: 1,
        data: { appearance: { layers: [] } },
      });
    });

    it("the envelope round-trips, and an empty envelope clears to null", () => {
      const ref = {
        mask: { kind: "rectangle", id: "urect" },
        maskType: "alpha" as const,
        invert: true,
      };
      const env = withOpacityMaskKey(null, ref);
      expect(opacityMaskOf(env)).toEqual(ref);
      expect(withOpacityMaskKey(env, null)).toBeNull();
      // Tolerant of foreign / partial shapes (never a throw).
      expect(opacityMaskOf(null)).toBeNull();
      expect(opacityMaskOf({ v: 1, data: { opacityMask: 7 } })).toBeNull();
      expect(
        opacityMaskOf({ v: 1, data: { opacityMask: { mask: { kind: "polygon" } } } }),
      ).toBeNull();
      // An unknown mode reads as the default rather than propagating.
      expect(
        opacityMaskOf({
          v: 1,
          data: { opacityMask: { mask: { kind: "oval", id: "u1" }, maskType: "nope" } },
        })!.maskType,
      ).toBe(DEFAULT_OPACITY_MASK_MODE);
    });

    it("the refusal reader peels the engine's two envelopes and the RFI tag", () => {
      expect(
        v58RefusalReason({
          error: {
            kind: "notImplemented",
            details: {
              what:
                'frame mutation failed: invalid value for FrameTransform on ' +
                'Polygon("ua"): C-28: an item cannot mask itself',
            },
          },
        }),
      ).toBe("an item cannot mask itself");
      expect(v58RefusalReason(null)).toBeNull();
    });

    it("the kind mirror matches core's gate on BOTH sides of a mask", () => {
      expect([...OPACITY_MASK_KINDS].sort()).toEqual([
        "graphicLine",
        "oval",
        "polygon",
        "rectangle",
      ]);
      expect(OPACITY_MASK_KINDS.has("textFrame")).toBe(false);
    });
  });

  // --------------------------------------------------- the honest wording

  describe("the canvas/export asymmetry is stated where a user reads it", () => {
    it("the note names the backend, the two lanes and the visible consequence", () => {
      // Every clause here is load-bearing. If this test starts failing
      // because the note was "tidied up", the fix is to restore the
      // claim — not to relax the assertion.
      expect(OPACITY_MASK_CANVAS_NOTE).toContain("CPU rasterizer");
      expect(OPACITY_MASK_CANVAS_NOTE).toContain("PDF export");
      expect(OPACITY_MASK_CANVAS_NOTE).toContain("NOT");
      expect(OPACITY_MASK_CANVAS_NOTE).toContain("Vello/WebGPU");
      expect(OPACITY_MASK_CANVAS_NOTE).toContain("UNMASKED");
      // …and it must never claim the canvas shows it.
      expect(OPACITY_MASK_CANVAS_NOTE).not.toMatch(/WYSIWYG|live preview/i);
    });
  });

  // ---------------------------------------------------- the real engine

  describe("against the real engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    // A FRESH document per test: the undo arithmetic below is only
    // readable against an empty undo stack.
    beforeEach(async () => {
      await h.load(F4_OVERLAP.bytes());
      await h.host.selection.set([]);
      h.host.bindings.publish(BIND_OPACITY_MASK_STATUS, null);
    });

    it("THE GATE: this engine's op vocabulary carries both C-28 ops", async () => {
      const vocab = await engineOpVocabulary(h.host);
      expect(vocab).not.toBeNull();
      expect(vocab!.has("applyOpacityMask")).toBe(true);
      expect(vocab!.has("releaseOpacityMask")).toBe(true);
      expect(await supportsOpacityMask(h.host)).toBe(true);
    });

    it("registers the two commands, and the TITLES carry the renderer gap", () => {
      for (const id of OPACITY_MASK_COMMAND_IDS) {
        expect(commandFor(h, id).category).toBe("Transparency");
      }
      const make = commandFor(h, MAKE_OPACITY_MASK_COMMAND_ID).title;
      // The `pattern.ts` precedent: a command palette entry is the one
      // surface read BEFORE invoking, so the gap lives there.
      expect(make).toContain("EXPORT ONLY");
      expect(make).toContain("UNMASKED");
      expect(make).toContain("canvas");
      expect(commandFor(h, RELEASE_OPACITY_MASK_COMMAND_ID).title).toContain(
        "comes back on top",
      );
    });

    it("MAKE: the TOP object becomes the mask and leaves the z-order — ONE undo step", async () => {
      // Selected bottom-up ON PURPOSE: the roles come from the scene
      // tree's paint order, not from click order.
      await h.host.selection.set([A, B]);
      const ref = await applyMakeOpacityMask(h.host, {
        maskType: "alpha",
        invert: true,
      });
      expect(ref).toEqual({
        mask: { kind: "polygon", id: "ub" },
        maskType: "alpha",
        invert: true,
      });
      // The mask artwork is GONE from the scene tree (it left
      // `frames_in_order`) — the one part of this feature the canvas
      // does show.
      expect(await leafKeys(h)).toEqual(["polygon:ua"]);
      // The relation is recorded on the TARGET, because the engine
      // exposes no read door for it.
      expect(opacityMaskOf(await h.host.document.getMetadata(A))).toEqual({
        mask: { kind: "polygon", id: "ub" },
        maskType: "alpha",
        invert: true,
      });
      expect((await opacityMaskLinks(h.host)).map((l) => l.ref.mask.id)).toEqual([
        "ub",
      ]);

      // MEASURED, not claimed: ONE undo restores the artwork AND drops
      // the stamp together…
      await h.host.document.undo();
      expect(await leafKeys(h)).toEqual(["polygon:ua", "polygon:ub"]);
      expect(await h.host.document.getMetadata(A)).toBeNull();
      // …and a second undo has nothing of ours left to take (the stack
      // was empty when the test started).
      await h.host.document.undo();
      expect(await leafKeys(h)).toEqual(["polygon:ua", "polygon:ub"]);
    });

    it("MAKE defaults to luminosity, un-inverted, when the payload names nothing", async () => {
      await h.host.selection.set([B, A]);
      const ref = await applyMakeOpacityMask(h.host);
      expect(ref).toEqual({
        mask: { kind: "polygon", id: "ub" },
        maskType: DEFAULT_OPACITY_MASK_MODE,
        invert: false,
      });
    });

    it("RELEASE brings the artwork back and clears the stamp — ONE undo step", async () => {
      await h.host.selection.set([A, B]);
      await applyMakeOpacityMask(h.host);
      expect(await leafKeys(h)).toEqual(["polygon:ua"]);

      await h.host.selection.set([A]);
      expect(await applyReleaseOpacityMask(h.host)).toBe(true);
      expect((await leafKeys(h)).sort()).toEqual(["polygon:ua", "polygon:ub"]);
      expect(await h.host.document.getMetadata(A)).toBeNull();

      // ONE undo re-applies the mask WITH its record.
      await h.host.document.undo();
      expect(await leafKeys(h)).toEqual(["polygon:ua"]);
      expect(opacityMaskOf(await h.host.document.getMetadata(A))).not.toBeNull();
    });

    it("the release target is resolved from the STAMP, not from selection order", async () => {
      await h.host.selection.set([A, B]);
      await applyMakeOpacityMask(h.host);
      // `ua` is the only leaf left, but assert the resolver reaches it
      // through its record rather than by luck of ordering.
      await h.host.selection.set([A]);
      const target = await resolveMaskTarget(h.host);
      expect(target).toEqual(A);
      expect(await resolveMaskTarget(h.host, { targetId: { kind: "polygon", id: "ub" } }))
        .toEqual({ kind: "polygon", id: "ub" });
    });

    // ---------------------------------------------------- the refusals

    it("REFUSES self-masking with the engine's own sentence, on the status binding", async () => {
      expect(
        await applyMakeOpacityMask(h.host, { targetId: A, maskId: A }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_OPACITY_MASK_STATUS))).toBe(
        "an item cannot mask itself",
      );
      // Nothing was written — not the relation, not the record.
      expect(await h.host.document.getMetadata(A)).toBeNull();
      expect((await leafKeys(h)).sort()).toEqual(["polygon:ua", "polygon:ub"]);
    });

    it("REFUSES a second mask on an already-masked target (release first)", async () => {
      await h.host.selection.set([A, B]);
      await applyMakeOpacityMask(h.host);
      const again = await h.host.document.mutate(
        applyOpacityMaskMutationFor({ targetId: A, maskId: B }),
      );
      if (again.applied) throw new Error("expected the engine to refuse");
      expect(v58RefusalReason(again.error)).toBe(
        "the item already carries an opacity mask (release it first)",
      );
    });

    it("REFUSES a GROUPED item as the mask — the engine names the fix", async () => {
      const grouped = await h.host.document.mutate({
        op: "createGroup",
        args: { memberIds: [B] },
      });
      expect(grouped.applied).toBe(true);
      expect(
        await applyMakeOpacityMask(h.host, { targetId: A, maskId: B }),
      ).toBeNull();
      expect(String(h.host.bindings.get(BIND_OPACITY_MASK_STATUS))).toBe(
        "a grouped item cannot become a mask (ungroup first)",
      );
    });

    it("REFUSES a TEXT FRAME on either side, saying WHY (glyphs leave the mask bracket)", async () => {
      const frame = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F4_OVERLAP.pageId, bounds: [10, 10, 120, 60] },
      });
      expect(frame.applied).toBe(true);
      const textFrame = (frame as { createdId: ElementId }).createdId;
      expect(
        await applyMakeOpacityMask(h.host, { targetId: A, maskId: textFrame }),
      ).toBeNull();
      const reason = String(h.host.bindings.get(BIND_OPACITY_MASK_STATUS));
      expect(reason).toContain("cannot take part in an opacity mask");
      expect(reason).toContain("story pass");
      // …and the same refusal on the TARGET side.
      expect(
        await applyMakeOpacityMask(h.host, { targetId: textFrame, maskId: A }),
      ).toBeNull();
      expect(
        String(h.host.bindings.get(BIND_OPACITY_MASK_STATUS)),
      ).toContain("cannot take part in an opacity mask");
    });

    it("RELEASING an unmasked item reports the engine's sentence, not silence", async () => {
      await h.host.selection.set([A]);
      expect(await applyReleaseOpacityMask(h.host)).toBe(false);
      expect(String(h.host.bindings.get(BIND_OPACITY_MASK_STATUS))).toBe(
        "the item carries no opacity mask",
      );
    });

    it("MAKE from a selection that is not exactly two is an honest no-op", async () => {
      await h.host.selection.set([A]);
      expect(await applyMakeOpacityMask(h.host)).toBeNull();
      await h.host.selection.set([]);
      expect(await applyMakeOpacityMask(h.host)).toBeNull();
      expect((await leafKeys(h)).sort()).toEqual(["polygon:ua", "polygon:ub"]);
    });

    it("the command handlers drive the same lane (registered, not just exported)", async () => {
      await h.host.selection.set([A, B]);
      await commandFor(h, MAKE_OPACITY_MASK_COMMAND_ID).handler(
        undefined as never,
        {},
      );
      expect(await leafKeys(h)).toEqual(["polygon:ua"]);
      await h.host.selection.set([A]);
      await commandFor(h, RELEASE_OPACITY_MASK_COMMAND_ID).handler(
        undefined as never,
        {},
      );
      expect((await leafKeys(h)).sort()).toEqual(["polygon:ua", "polygon:ub"]);
    });
  });
});
