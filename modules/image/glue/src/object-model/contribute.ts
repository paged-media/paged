// Registers paged.image's object model and its TYPED commands
// (`contribute.objectModel`, ADR 323).
//
// Every untyped command keeps working; each gets a typed twin with the
// same id, which takes it off the shrink-only untyped baseline. Most of
// them act on the image open in the edit context (the selection, the
// active layer) and take no arguments. Four become headless and name
// their target instead — `addLayer`, `addLayerMask`,
// `addLayerMaskHideAll`, `convertLayerToSmart` — and some are new
// (`replaceLayerPixels`, `cropImage`, `canvasSize`, `applyAdjustment`,
// `filterRegion`). Those run through `host.objects` like any other
// caller, so each is one undo step.

import type {
  BundleHost,
  ObjectModelHandle,
  ObjectOp,
  ObjectsSurface,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";

import { bootEngine } from "../engine";
import {
  createImageObjects,
  FILTER_FIELDS,
  KIND_CONTENT,
  KIND_PREFIX,
  KIND_ROWS,
  KIND_TITLES,
  parseImageAddress,
  imageAddress,
  layerAddress,
  type ImageCodec,
  type ImageKind,
  type ImageObjects,
  type SelectionSource,
} from "./image-objects";
import { ANCHORS, QUARTER_OPS } from "./canvas-ops";
import { IMAGE_TEMPLATE_FIELDS, imageTemplateFields } from "./template-fields";

/** A native handler's answer "no target named: run the interactive twin". */
const INTERACTIVE = Symbol("interactive");

/** Interactive twins that work with no image open (they open one). */
const STARTS_A_SESSION = new Set(["media.paged.image.command.openImage"]);

/** One untyped command as `activate` registers it. */
export interface UntypedCommand {
  id: string;
  title: string;
  handler: (paged: unknown, payload?: unknown) => unknown;
}

const NO_ARGS: ValueType = { kind: "struct", fields: {} };
const LAYER_REF: ValueType = { kind: "ref", to: `${KIND_PREFIX}layer` };
const IMAGE_REF: ValueType = { kind: "ref", to: `${KIND_PREFIX}image` };
const q = (kind: ImageKind) => `${KIND_PREFIX}${kind}`;

/** The typed twins whose arguments differ from "none", and the new ones. */
export const TYPED_ARGS: Record<string, { args: ValueType; title?: string }> = {
  "media.paged.image.command.addLayer": {
    args: {
      kind: "struct",
      fields: {
        image: { kind: "ref", to: q("image") },
        name: { kind: "text" },
      },
    },
  },
  "media.paged.image.command.addLayerMask": {
    args: { kind: "struct", fields: { layer: LAYER_REF } },
  },
  "media.paged.image.command.addLayerMaskHideAll": {
    args: { kind: "struct", fields: { layer: LAYER_REF } },
  },
  "media.paged.image.command.convertLayerToSmart": {
    args: { kind: "struct", fields: { layer: LAYER_REF } },
  },
  ...Object.fromEntries(
    (
      [
        "rotateCw",
        "rotateCcw",
        "rotate180",
        "flipHorizontal",
        "flipVertical",
      ] as const
    ).map((suffix) => [
      `media.paged.image.command.${suffix}`,
      {
        args: {
          kind: "struct",
          fields: { image: { ...IMAGE_REF, optional: true } },
        } as ValueType,
      },
    ]),
  ),
  "media.paged.image.command.cropImage": {
    title: "Crop image",
    args: {
      kind: "struct",
      fields: { image: IMAGE_REF, bounds: { kind: "bounds" } },
    },
  },
  "media.paged.image.command.canvasSize": {
    title: "Canvas size",
    args: {
      kind: "struct",
      fields: {
        image: IMAGE_REF,
        width: { kind: "number", integer: true },
        height: { kind: "number", integer: true },
        anchor: { kind: "enum", members: ANCHORS, default: "center" },
      },
    },
  },
  "media.paged.image.command.applyAdjustment": {
    title: "Apply adjustment",
    args: {
      kind: "struct",
      fields: {
        image: IMAGE_REF,
        name: { kind: "text", optional: true },
        params: { kind: "struct", fields: {}, open: true },
      },
    },
  },
  "media.paged.image.command.filterRegion": {
    title: "Filter a region",
    args: {
      kind: "struct",
      fields: { layer: LAYER_REF, ...FILTER_FIELDS },
    },
  },
  "media.paged.image.command.replaceLayerPixels": {
    title: "Replace layer pixels",
    args: {
      kind: "struct",
      fields: { layer: LAYER_REF, source: { kind: "asset" } },
    },
  },
};

/** The CPU codec over the engine wasm (booted once; no GPU requested). */
export function engineCodec(): () => Promise<ImageCodec> {
  let booted: Promise<ImageCodec> | null = null;
  return () =>
    (booted ??= bootEngine().then((e) => ({
      decode(bytes: Uint8Array) {
        const d = e.decode(bytes);
        try {
          return {
            width: d.width,
            height: d.height,
            rgba: e.tile(d.handle, 0, 0, d.width, d.height),
          };
        } finally {
          e.freeImage(d.handle);
        }
      },
      encodePng: (rgba: Uint8Array, width: number, height: number) =>
        e.encode(rgba, width, height, "png"),
      // The GPU when this realm's engine has a device (the editor's
      // session requested one); the CPU twins otherwise (ADR 465).
      async filterRegion(rgba, width, height, wire, rect, mask) {
        const gpu = e.gpuReady();
        return {
          rgba: await e.filterRegion(rgba, width, height, wire, rect, mask),
          gpu,
        };
      },
    })));
}

const fail = (r: { applied: boolean; reason?: string; code?: string }) => {
  if (!r.applied)
    throw new Error(`${r.code ?? "failed"}: ${r.reason ?? "not applied"}`);
  return r;
};

function nativeHandlers(
  codec: () => Promise<ImageCodec>,
): Record<string, TypedCommandContribution["handler"]> {
  const frameOf = (layer: string) => {
    const a = parseImageAddress(layer);
    if (!a || a.kind !== "layer")
      throw new Error(`invalidValue: ${layer} is not a paged.image layer`);
    return a.frameId;
  };
  return {
    "media.paged.image.command.addLayer": async ({ objects }, args) => {
      const { image, name } = args as { image: string; name: string };
      return fail(
        await objects.batch([
          { op: "create", kind: q("layer"), within: image, props: { name } },
        ]),
      );
    },
    "media.paged.image.command.addLayerMask": async ({ objects }, args) => {
      const { layer } = args as { layer: string };
      frameOf(layer);
      return fail(
        await objects.batch([{ op: "create", kind: q("mask"), within: layer }]),
      );
    },
    "media.paged.image.command.addLayerMaskHideAll": async (
      { objects },
      args,
    ) => {
      const { layer } = args as { layer: string };
      const image = imageAddress(frameOf(layer));
      const [w, h] = await Promise.all([
        objects.get(image, "width"),
        objects.get(image, "height"),
      ]);
      if (w.kind !== "value" || h.kind !== "value")
        throw new Error(`unknownAddress: ${image}`);
      const [W, H] = [w.value as number, h.value as number];
      const black = new Uint8Array(W * H * 4);
      for (let i = 3; i < black.length; i += 4) black[i] = 255;
      const png = (await codec()).encodePng(black, W, H);
      const mask = layer.replace(`${KIND_PREFIX}layer/`, `${KIND_PREFIX}mask/`);
      return fail(
        await objects.batch([
          { op: "create", kind: q("mask"), within: layer },
          { op: "set", address: mask, path: "content", value: png },
        ]),
      );
    },
    "media.paged.image.command.convertLayerToSmart": async (
      { objects },
      args,
    ) => {
      const { layer } = args as { layer: string };
      frameOf(layer);
      return fail(
        await objects.batch([
          { op: "create", kind: q("smartObject"), within: layer },
        ]),
      );
    },
    ...Object.fromEntries(
      QUARTER_OPS.map((op) => [
        `media.paged.image.command.${op}`,
        async (
          { objects }: { objects: ObjectsSurface },
          args: unknown,
        ): Promise<unknown> => {
          const { image } = args as { image?: string };
          if (image === undefined) return INTERACTIVE;
          return fail(await objects.set(image, "transform", op));
        },
      ]),
    ),
    "media.paged.image.command.cropImage": async ({ objects }, args) => {
      const { image, bounds } = args as { image: string; bounds: number[] };
      return fail(await objects.set(image, "crop", bounds));
    },
    "media.paged.image.command.canvasSize": async ({ objects }, args) => {
      const { image, ...size } = args as {
        image: string;
        width: number;
        height: number;
        anchor: string;
      };
      return fail(await objects.set(image, "canvasSize", size));
    },
    "media.paged.image.command.applyAdjustment": async ({ objects }, args) => {
      const { image, name, params } = args as {
        image: string;
        name?: string;
        params: Record<string, unknown>;
      };
      const a = parseImageAddress(image);
      if (!a || a.kind !== "image")
        throw new Error(`invalidValue: ${image} is not a paged.image image`);
      const ops: ObjectOp[] = [
        { op: "create", kind: q("adjustment"), within: image, props: params },
      ];
      if (name !== undefined) {
        const next = await objects.get(image, "nextLayerId");
        if (next.kind !== "value") throw new Error(`unknownAddress: ${image}`);
        ops.push({
          op: "set",
          address: layerAddress("layer", a.frameId, next.value as number),
          path: "name",
          value: name,
        });
      }
      return fail(await objects.batch(ops));
    },
    "media.paged.image.command.filterRegion": async ({ objects }, args) => {
      const { layer, ...filter } = args as {
        layer: string;
        params: Record<string, unknown>;
      };
      frameOf(layer);
      return fail(await objects.set(layer, "filter", filter));
    },
    "media.paged.image.command.replaceLayerPixels": async (
      { objects },
      args,
    ) => {
      const { layer, source } = args as { layer: string; source: string };
      return fail(await objects.set(layer, "pixelSource", source));
    },
  };
}

/** The typed commands: one twin per untyped command, plus the new ones. */
export function typedCommands(
  untyped: readonly UntypedCommand[],
  codec: () => Promise<ImageCodec>,
  /** Whether an image is open in the editor's session (the interactive
   *  twins act on it). Headless, nothing is: they refuse. */
  live: () => boolean = () => true,
): TypedCommandContribution[] {
  const native = nativeHandlers(codec);
  const out: TypedCommandContribution[] = untyped.map((c) => {
    // The interactive twin: the same action on the image in the edit
    // context. It returns nothing; its effect is the session's. With no
    // image open it refuses rather than doing nothing.
    const interactive = () => {
      if (!STARTS_A_SESSION.has(c.id) && !live())
        throw new Error(
          `unmapped: ${c.id} acts on the image open in the editor, and none is open` +
            (TARGETED.has(c.id) ? "; name the image to run it headless" : ""),
        );
      c.handler(null, undefined);
      return null;
    };
    const own = native[c.id];
    return {
      id: c.id,
      title: c.title,
      args: TYPED_ARGS[c.id]?.args ?? NO_ARGS,
      handler: own
        ? async (ctx, args) => {
            const r = await own(ctx, args);
            return r === INTERACTIVE ? interactive() : r;
          }
        : interactive,
    };
  });
  for (const [id, spec] of Object.entries(TYPED_ARGS)) {
    if (out.some((c) => c.id === id)) continue;
    out.push({
      id,
      title: spec.title ?? id,
      args: spec.args,
      handler: native[id]!,
    });
  }
  return out;
}

/** The interactive twins that also take a target and then run headless. */
const TARGETED = new Set(
  QUARTER_OPS.map((op) => `media.paged.image.command.${op}`),
);

/** `contributes.objectModel` as the manifest declares it (the kinds'
 *  rows live in `object-model/<kind>.json`, generated from KIND_ROWS). */
export function manifestObjectModel(
  commands: readonly TypedCommandContribution[],
) {
  return {
    kinds: (Object.keys(KIND_ROWS) as ImageKind[]).map((kind) => ({
      kind,
      title: KIND_TITLES[kind],
      schema: `object-model/${kind}.json`,
    })),
    commands: commands.map((c) => ({ id: c.id, title: c.title, args: c.args })),
    templateFields: IMAGE_TEMPLATE_FIELDS.map((f) => ({ ...f })),
  };
}

/** The rows a kind's schema file holds (the registry adds `content`). */
export function schemaFileRows(kind: ImageKind) {
  return KIND_ROWS[kind];
}

export { KIND_CONTENT };

/**
 * Register the object model. Null when the host has no object registry
 * (`contribute.objectModel@1` false) — the bundle then works as before.
 * `selection` reads the editor session's live selection for
 * `filterRegion`'s `selection: true` (absent headless, where it refuses).
 */
export function contributeImageObjectModel(
  host: BundleHost,
  untyped: readonly UntypedCommand[],
  codec: () => Promise<ImageCodec> = engineCodec(),
  live?: () => boolean,
  selection?: SelectionSource,
): { handle: ObjectModelHandle; objects: ImageObjects } | null {
  if (!host.supports("contribute.objectModel@1")) return null;
  const objects = createImageObjects(host, codec, selection);
  const handle = host.contribute.objectModel({
    kinds: objects.kinds,
    batch: objects.batch,
    commands: typedCommands(untyped, codec, live),
    templateFields: imageTemplateFields(),
  });
  return {
    handle,
    objects,
  };
}

export type { ObjectsSurface };
