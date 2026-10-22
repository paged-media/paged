// @feat: image.object-model
//
// paged.image's template field kinds (extensions ADR 335) on the real
// plugin and the real engine: an author builds a template whose fields are
// parts of edited images, the session takes the FILLER role, and each field
// is read and written through `host.objects` — so every write is checked
// against the policy. A value outside a field's choices is refused with a
// sentence; a write outside the fields is refused by the engine. A stack
// whose composite needs a GPU is reported `pending`, never hidden.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import type { TemplateFieldRef } from "@paged-media/plugin-api";
import { sha256Hex } from "@paged-media/helpers";

import { imageBundle } from "../src/index";
import { bootEngine, type ImageEngine } from "../src/engine";
import { minimalIdml } from "./fixtures/minimal-idml";

const ENGINE_ANCHOR = fileURLToPath(new URL(".", import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "wasm", "image_js_bg.wasm"));
const lane = built ? describe : describe.skip;

const I = "media.paged.image";
const P = `plugin:${I}`;

type Reply = { kind: string; payload: Record<string, unknown> };

const solid = (w: number, h: number, rgba: number[]) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return px;
};

lane("paged.image — template field kinds, filled as a filler", () => {
  let engine: ImageEngine;
  let h: HeadlessHost;
  let pageId = "";
  const frames: Record<string, string> = { picture: "urect" };
  const fields: Record<string, TemplateFieldRef> = {};
  const png = (w: number, h: number, rgba: number[]) =>
    engine.encode(solid(w, h, rgba), w, h, "png");

  const send = (kind: string, payload: unknown) =>
    h.host.editor.client.send({ kind, payload } as never) as Promise<Reply>;
  const role = async (r: "author" | "filler") =>
    expect((await send("setSessionPolicy", { policy: { role: r } })).kind).toBe(
      "sessionPolicyApplied",
    );
  const placedSha = async (frame: string) =>
    sha256Hex((await h.host.assets.getPlacedImage(frame))!.bytes);
  const pending = async (frame: string) =>
    (await h.objects.get(`${P}/image/${frame}`, "pending")) as {
      value: unknown;
    };

  async function imageFrame(name: string): Promise<string> {
    const made = await send("mutate", {
      op: "insertFrame",
      args: { pageId, bounds: [10, 10, 60, 60] },
    });
    expect(made.kind).toBe("mutationApplied");
    const id = String((made.payload.createdId as { id: unknown }).id);
    frames[name] = id;
    return id;
  }

  async function place(frame: string, bytes: Uint8Array) {
    const out = await h.host.document.mutate({
      op: "replaceImageBytes",
      args: { elementId: frame, bytes: Array.from(bytes) },
    } as never);
    expect(out.applied).toBe(true);
  }

  async function markField(
    frame: string,
    name: string,
    kind: string,
    def: unknown,
  ) {
    const info = (await h.objects.templateFieldKinds()).find(
      (k) => k.kind === `${I}.${kind}`,
    )!;
    const out = await send("mutate", {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: frame },
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name,
              kind: "module",
              module: { kind: info.kind, grants: info.grants, def },
            },
          },
        }),
      },
    });
    expect(out.kind).toBe("mutationApplied");
    fields[name] = { name, targetId: frame, kind: info.kind, def };
  }

  const PRESETS = [
    { name: "Warm", rows: { "whiteBalance.temp": 0.3 } },
    { name: "Mono", rows: { "blackWhite.enabled": true } },
  ];

  beforeAll(async () => {
    engine = await bootEngine();
    h = await createHeadlessHost({
      resolveFrom: ENGINE_ANCHOR,
      console: silent,
    });
    [pageId] = (await h.load(minimalIdml())) as [string];
    h.loadBundle(imageBundle);
    await role("author");
    await place("urect", png(4, 4, [128, 128, 128, 255]));
    await place(await imageFrame("visibility"), png(4, 4, [0, 0, 255, 255]));
    await place(await imageFrame("preset"), png(4, 4, [200, 100, 50, 255]));
    await place(await imageFrame("scenery"), png(4, 4, [9, 9, 9, 255]));

    // The visibility frame gets a second layer, "Logo".
    const logo = await h.objects.batch([
      {
        op: "create",
        kind: `${P}/layer`,
        within: `${P}/image/${frames.visibility}`,
        props: { name: "Logo", content: png(2, 2, [0, 255, 0, 255]) },
      },
    ]);
    expect(logo.applied, logo.reason).toBe(true);

    await markField("urect", "photo", "picture", {});
    await markField(frames.visibility!, "logo", "layerVisibility", {
      layer: "Logo",
    });
    await markField(frames.preset!, "look", "adjustmentPreset", {
      allowed: PRESETS,
    });
    await role("filler");
  });
  afterAll(() => h?.dispose());

  it("lists its three kinds, each granting image.replace", async () => {
    const kinds = (await h.objects.templateFieldKinds()).filter(
      (k) => k.owner === I,
    );
    expect(kinds.map((k) => [k.kind, k.control.kind, k.grants])).toEqual([
      [`${I}.picture`, "picture", ["image.replace"]],
      [`${I}.adjustmentPreset`, "choice", ["image.replace"]],
      [`${I}.layerVisibility`, "toggle", ["image.replace"]],
    ]);
  });

  it("picture: replaces the layer's pixels and bakes a one-layer stack", async () => {
    expect((await h.objects.readTemplateField(fields.photo!)).value).toEqual({
      name: "Background",
      pending: false,
    });
    const before = await placedSha("urect");
    expect(
      await h.objects.writeTemplateField(fields.photo!, {
        name: "red.png",
        bytes: png(4, 4, [255, 0, 0, 255]),
      }),
    ).toEqual({ ok: true });
    expect(await placedSha("urect")).not.toBe(before);
    expect((await pending("urect")).value).toBe(false);
    expect(
      await h.objects.writeTemplateField(fields.photo!, { name: "x" }),
    ).toEqual({ ok: false, problem: "choose an image file" });
  });

  it("layerVisibility: hiding the top layer leaves an identity composite, so it bakes", async () => {
    expect((await pending(frames.visibility!)).value).toBe(true);
    expect((await h.objects.readTemplateField(fields.logo!)).value).toBe(true);
    expect(await h.objects.writeTemplateField(fields.logo!, false)).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(fields.logo!)).value).toBe(false);
    expect((await pending(frames.visibility!)).value).toBe(false);
    expect(await h.objects.writeTemplateField(fields.logo!, "no")).toEqual({
      ok: false,
      problem: "the value is on or off",
    });
  });

  it("adjustmentPreset: creates, then re-sets, one named adjustment layer — reported pending", async () => {
    const read = await h.objects.readTemplateField(fields.look!);
    expect(read.control).toEqual({
      kind: "choice",
      options: [{ value: "Warm" }, { value: "Mono" }],
    });
    expect(read.value).toBeNull();

    expect(await h.objects.writeTemplateField(fields.look!, "Warm")).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(fields.look!)).value).toBe(
      "Warm",
    );
    const adjustments = await h.objects.query(`${P}/adjustment`);
    expect(adjustments).toHaveLength(1);
    expect((await pending(frames.preset!)).value).toBe(true);

    expect(await h.objects.writeTemplateField(fields.look!, "Mono")).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(fields.look!)).value).toBe(
      "Mono",
    );
    // Still ONE preset layer, and Warm's row is back at its default.
    expect(await h.objects.query(`${P}/adjustment`)).toEqual(adjustments);
    expect(await h.objects.get(adjustments[0]!, "whiteBalance.temp")).toEqual({
      kind: "value",
      value: 0,
    });

    expect(await h.objects.writeTemplateField(fields.look!, "Sepia")).toEqual({
      ok: false,
      problem: `"Sepia" is not one of this field's presets`,
    });
    expect(
      await h.objects.writeTemplateField(
        {
          ...fields.look!,
          def: { allowed: [{ name: "X", rows: { nope: 1 } }] },
        },
        "X",
      ),
    ).toEqual({
      ok: false,
      problem: `preset "X" sets "nope", which is no adjustment parameter`,
    });
  });

  it("picture: a stack that needs a GPU is stored and read back pending", async () => {
    const field = { ...fields.photo!, targetId: frames.preset! };
    // The preset frame's own field is the preset, not the picture: the
    // engine refuses nothing here because the image module's label is the
    // one it writes, but the frame keeps its image (pending).
    const out = await h.objects.writeTemplateField(field, {
      name: "blue.png",
      bytes: png(4, 4, [0, 0, 255, 255]),
    });
    expect(out).toEqual({ ok: true });
    expect((await h.objects.readTemplateField(field)).value).toEqual({
      name: "Background",
      pending: true,
    });
  });

  it("a write outside the fields is refused", async () => {
    // A frame that is no field: the filler may not touch its image.
    const scenery = { ...fields.photo!, targetId: frames.scenery! };
    const refused = await h.objects.writeTemplateField(scenery, {
      name: "red.png",
      bytes: png(4, 4, [255, 0, 0, 255]),
    });
    expect(refused.ok).toBe(false);
    expect((refused as { problem: string }).problem).toMatch(/permitted/);
    // A field frame's geometry is not the field's.
    const moved = await h.objects.set(
      "rectangle:urect",
      "frameBounds",
      [0, 0, 50, 50],
    );
    expect(moved.applied).toBe(false);
  });
});
