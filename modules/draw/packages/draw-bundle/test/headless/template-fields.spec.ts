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

// paged.draw's template field kinds (extensions ADR 335) on a real
// engine: an author builds a template whose fields are draw parts, the
// session takes the FILLER role, and every field is read and written
// through `host.objects` — so each write is checked against the policy
// like any other. A value outside a field's choices is refused with a
// sentence; a write outside the fields is refused by the engine.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId, TemplateFieldRef } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyAttachTextToPath,
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  documentStories,
  drawBundle,
  symbolInstances,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost, withoutEngineSymbols } from "./host";

const D = "media.paged.draw";
const RECT = { kind: "rectangle", id: "urect" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const LINE = { kind: "graphicLine", id: "uline" } as ElementId;

type Reply = { kind: string; payload: Record<string, unknown> };

const send = (h: HeadlessHost, kind: string, payload: unknown) =>
  h.host.editor.client.send({ kind, payload } as never) as Promise<Reply>;

/** Mark `elementId` as a module field of `kind` (author only). */
async function markField(
  h: HeadlessHost,
  elementId: ElementId,
  name: string,
  kind: string,
  grants: readonly string[],
  def: unknown,
): Promise<void> {
  const out = await send(h, "mutate", {
    op: "setPluginMetadata",
    args: {
      elementId,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: {
          field: { name, kind: "module", module: { kind, grants, def } },
        },
      }),
    },
  });
  if (out.kind !== "mutationApplied")
    throw new Error(`field ${name}: ${JSON.stringify(out)}`);
}

const ref = (
  name: string,
  targetId: string,
  kind: string,
  def: unknown,
): TemplateFieldRef => ({ name, targetId, kind: `${D}.${kind}`, def });

async function grantsOf(h: HeadlessHost, kind: string): Promise<string[]> {
  const info = (await h.objects.templateFieldKinds()).find(
    (k) => k.kind === `${D}.${kind}`,
  );
  return [...(info?.grants ?? [])];
}

describe("paged.draw — template field kinds, filled as a filler", () => {
  let h: HeadlessHost;
  let swatchA = "";
  let swatchB = "";
  let swatchOff = "";
  let instance = "";
  let story = "";
  const fields: Record<string, TemplateFieldRef> = {};

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
    // The symbol field kind reads the re-emitted lane's library (draw ADR
    // 356).
    withoutEngineSymbols(h);
    expect(
      (await send(h, "setSessionPolicy", { policy: { role: "author" } })).kind,
    ).toBe("sessionPolicyApplied");

    for (const [selfId, value] of [
      ["Color/Red", [0, 100, 100, 0]],
      ["Color/Blue", [100, 60, 0, 0]],
      ["Color/Green", [80, 0, 100, 0]],
    ] as const) {
      const made = await h.host.document.mutate({
        op: "createSwatch",
        args: {
          spec: {
            selfId,
            name: selfId.slice(6),
            space: "CMYK",
            value: [...value],
          },
        },
      });
      expect(made.applied).toBe(true);
    }
    const swatches = (await h.host.document.collection("swatches")) as {
      selfId: string;
      name: string;
    }[];
    const colours = swatches.filter((s) =>
      ["Color/Red", "Color/Blue", "Color/Green"].includes(s.selfId),
    );
    expect(colours.length).toBeGreaterThanOrEqual(3);
    [swatchA, swatchB, swatchOff] = colours.map((s) => s.selfId) as [
      string,
      string,
      string,
    ];

    // Two graphic styles.
    for (const [name, weight] of [
      ["Bold", 6],
      ["Thin", 1],
    ] as const) {
      const made = await h.objects.batch([
        {
          op: "create",
          kind: `plugin:${D}/graphicStyle`,
          props: {
            name,
            strokes: [
              {
                color: "Color/Black",
                weight,
                opacity: 100,
                blendMode: "Normal",
              },
            ],
          },
        },
      ]);
      expect(made.applied, made.reason).toBe(true);
    }

    // Three symbols: two of one piece, one of two; an instance of "Box".
    await h.host.selection.set([RECT]);
    expect(await applyDefineSymbol(h.host, { name: "Box" })).not.toBeNull();
    await h.host.selection.set([POLY]);
    expect(await applyDefineSymbol(h.host, { name: "Hook" })).not.toBeNull();
    await h.host.selection.set([RECT, POLY]);
    expect(await applyDefineSymbol(h.host, { name: "Pair" })).not.toBeNull();
    const [leaf] = await applyPlaceSymbolInstance(h.host, "sym-1", {
      x: 400,
      y: 400,
    });
    expect(leaf).toBeDefined();
    instance = String(leaf!.id);

    // A story on the line.
    const before = new Set(
      (await documentStories(h.host)).map((s) => s.selfId),
    );
    const frame = await h.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [20, 20, 140, 80] },
    });
    story = (await documentStories(h.host)).find(
      (s) => !before.has(s.selfId),
    )!.selfId;
    await h.host.document.mutate({
      op: "insertText",
      args: { storyId: story, offset: 0, text: "Along the line" },
    });
    await h.host.document.mutate({
      op: "deleteFrame",
      args: {
        frameId: String(
          (frame as { createdId?: { id: unknown } }).createdId!.id,
        ),
      },
    });
    expect(
      await applyAttachTextToPath(h.host, { elementId: LINE, storyId: story }),
    ).not.toBeNull();

    // The template: four module fields, with the grants each kind declares.
    const defs = {
      colour: { channel: "fill", allowed: [swatchA, swatchB] },
      style: { allowed: ["Bold", "Thin"] },
      caption: {},
      badge: { allowed: ["Box", "Hook", "Pair"] },
    };
    await markField(
      h,
      RECT,
      "colour",
      `${D}.paint`,
      await grantsOf(h, "paint"),
      defs.colour,
    );
    await markField(
      h,
      POLY,
      "style",
      `${D}.graphicStyle`,
      await grantsOf(h, "graphicStyle"),
      defs.style,
    );
    await markField(
      h,
      LINE,
      "caption",
      `${D}.textOnPath`,
      await grantsOf(h, "textOnPath"),
      defs.caption,
    );
    await markField(
      h,
      { kind: "polygon", id: instance } as ElementId,
      "badge",
      `${D}.symbolChoice`,
      await grantsOf(h, "symbolChoice"),
      defs.badge,
    );
    fields.colour = ref("colour", "urect", "paint", defs.colour);
    fields.style = ref("style", "upoly", "graphicStyle", defs.style);
    fields.caption = ref("caption", "uline", "textOnPath", defs.caption);
    fields.badge = ref("badge", instance, "symbolChoice", defs.badge);

    expect(
      (await send(h, "setSessionPolicy", { policy: { role: "filler" } })).kind,
    ).toBe("sessionPolicyApplied");
  });
  afterAll(() => h?.dispose());

  it("lists the four kinds with their controls and grants", async () => {
    const kinds = (await h.objects.templateFieldKinds()).filter(
      (k) => k.owner === D,
    );
    expect(kinds.map((k) => k.kind).sort()).toEqual(
      ["graphicStyle", "paint", "symbolChoice", "textOnPath"].map(
        (k) => `${D}.${k}`,
      ),
    );
    expect(await grantsOf(h, "textOnPath")).toEqual(["text.edit"]);
  });

  it("the engine lists the module fields", async () => {
    const rows = (await h.host.editor.client.collection(
      "templateFields" as never,
    )) as { field: { name: string; module?: { kind: string } } }[];
    expect(
      Object.fromEntries(rows.map((r) => [r.field.name, r.field.module?.kind])),
    ).toEqual({
      colour: `${D}.paint`,
      style: `${D}.graphicStyle`,
      caption: `${D}.textOnPath`,
      badge: `${D}.symbolChoice`,
    });
  });

  it("paint: offers the allowed swatches, writes the frame's fill, refuses others", async () => {
    const read = await h.objects.readTemplateField(fields.colour!);
    expect(read.control).toMatchObject({ kind: "choice" });
    expect(
      (read.control as unknown as { options: { value: string }[] }).options.map(
        (o) => o.value,
      ),
    ).toEqual([swatchA, swatchB]);
    expect(read.value).toBe("Color/Black");

    expect(await h.objects.writeTemplateField(fields.colour!, swatchB)).toEqual(
      { ok: true },
    );
    expect(await h.objects.get("rectangle:urect", "frameFillColor")).toEqual({
      kind: "value",
      value: swatchB,
    });
    expect((await h.objects.readTemplateField(fields.colour!)).value).toBe(
      swatchB,
    );

    const bad = await h.objects.writeTemplateField(fields.colour!, swatchOff);
    expect(bad).toEqual({
      ok: false,
      problem: `"${swatchOff}" is not one of this field's colours`,
    });
  });

  it("paint on an appearance stack recolours the stack's top layer", async () => {
    // A stroke field on the same item, whose stack an author built.
    await send(h, "setSessionPolicy", { policy: { role: "author" } });
    const set = await h.objects.set(
      `plugin:${D}/appearance/rectangle:urect`,
      "strokes",
      [
        { color: swatchA, weight: 2, opacity: 100, blendMode: "Normal" },
        { color: swatchA, weight: 1, opacity: 100, blendMode: "Normal" },
      ],
    );
    expect(set.applied, set.reason).toBe(true);
    await send(h, "setSessionPolicy", { policy: { role: "filler" } });
    const stroke = ref("colour", "urect", "paint", {
      channel: "stroke",
      allowed: [swatchA, swatchB],
    });
    expect(await h.objects.writeTemplateField(stroke, swatchB)).toEqual({
      ok: true,
    });
    const strokes = await h.objects.get(
      `plugin:${D}/appearance/rectangle:urect`,
      "strokes",
    );
    expect(
      (strokes as { value: { color: string }[] }).value.map((s) => s.color),
    ).toEqual([swatchA, swatchB]);
    expect(await h.objects.get("rectangle:urect", "frameStrokeColor")).toEqual({
      kind: "value",
      value: swatchB,
    });
  });

  it("graphicStyle: applies a style from the list", async () => {
    const read = await h.objects.readTemplateField(fields.style!);
    expect(
      (
        read.control as unknown as { options: { label?: string }[] }
      ).options.map((o) => o.label),
    ).toEqual(["Bold", "Thin"]);
    expect(read.value).toBeNull();

    expect(await h.objects.writeTemplateField(fields.style!, "Thin")).toEqual({
      ok: true,
    });
    expect(await h.objects.get("polygon:upoly", "frameStrokeWeight")).toEqual({
      kind: "value",
      value: 1,
    });
    const id = (await h.objects.readTemplateField(fields.style!))
      .value as string;
    expect(id).toMatch(/^gs-/);
    expect(
      await h.objects.writeTemplateField(fields.style!, "Missing"),
    ).toEqual({
      ok: false,
      problem: `"Missing" is not one of this field's styles`,
    });
  });

  it("symbolChoice: swaps a one-piece symbol in place, refuses a two-piece one", async () => {
    const read = await h.objects.readTemplateField(fields.badge!);
    expect(read.value).toBe("sym-1");
    expect(await h.objects.writeTemplateField(fields.badge!, "Hook")).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(fields.badge!)).value).toBe(
      "sym-2",
    );
    // The same element, now the other symbol's shape.
    const [inst] = await symbolInstances(h.host);
    expect(inst!.symbol).toBe("sym-2");
    expect(inst!.leaves.map((l) => String(l.id))).toEqual([instance]);
    const anchors = await h.host.document.pathAnchors({
      kind: "polygon",
      id: instance,
    } as ElementId);
    expect(anchors!.anchors.length).toBe(3);

    expect(await h.objects.writeTemplateField(fields.badge!, "Pair")).toEqual({
      ok: false,
      problem: `"Pair" has 2 pieces; a symbol field swaps one-piece symbols`,
    });
  });

  it("textOnPath: reads the story; a filler writes it with the field's own grant", async () => {
    expect((await h.objects.readTemplateField(fields.caption!)).value).toBe(
      "Along the line",
    );
    expect(
      await h.objects.writeTemplateField(fields.caption!, "two\nlines"),
    ).toEqual({
      ok: false,
      problem: "text on a path is one line: remove the line breaks",
    });
    // A story on a path has no text frame: the engine decides it by the
    // item that carries its path, so the field's text.edit reaches it.
    expect(
      await h.objects.writeTemplateField(fields.caption!, "Along the path"),
    ).toEqual({ ok: true });
    expect((await h.objects.readTemplateField(fields.caption!)).value).toBe(
      "Along the path",
    );
  });

  it("a write outside the fields is refused", async () => {
    // A field item's geometry: the paint field grants colour, not size.
    const moved = await h.objects.set(
      "rectangle:urect",
      "frameBounds",
      [0, 0, 50, 50],
    );
    expect(moved.applied).toBe(false);
    // A draw write on the style field's item beyond its grants: its path.
    const reshaped = await h.objects.set(
      `plugin:${D}/path/polygon:upoly`,
      "points",
      [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [9, 9], left: [9, 9], right: [9, 9] },
      ],
    );
    expect(reshaped.applied).toBe(false);
    // The paint field's colour on an item that is no field.
    const other = ref("colour", "upoly", "paint", {
      channel: "fill",
      allowed: [swatchA],
      target: "uline",
    });
    const refused = await h.objects.writeTemplateField(other, swatchA);
    expect(refused.ok).toBe(false);
  });
});
