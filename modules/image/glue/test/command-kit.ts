// The shared set-up of the command specs: the bundle as the editor loads
// it, over the fake editor (`commands.spec.ts`, the unit layer) or the
// headless host and its real canvas engine (`headless/commands.spec.ts`),
// with a placed 4×2 image to act on.
//
// The image is two colours, left half red and right half blue, so a
// rotate or a flip is visible in the pixels and not only in the size.
// Commands are invoked through the REGISTERED contribution (its
// `handler`), the way the palette and the menus do; the session they act
// on is read through `bundle-session.ts`.

import { expect } from "bun:test";

import { fileURLToPath } from "node:url";

import type {
  ElementGeometryItem,
  PagedEditor,
  ToolContribution,
} from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  loadBundle,
  type HeadlessHost,
  type ToolSettingsBackend,
} from "@paged-media/plugin-sdk";
import { gestures, waitFor } from "@paged-media/test-kit";

import { imageBundle, PANEL_ID } from "../src";
import { bootEngine, type ImageEngine } from "../src/engine";
import type { ImageSession } from "../src/session";
import { lastSession } from "./bundle-session";
import { minimalIdml } from "./fixtures/minimal-idml";
import {
  makeFakeEditor,
  mapBacking,
  shellStub,
  silentConsole,
} from "./helpers";

export { PANEL_ID };

export const C = "media.paged.image.command";
export const RED = [200, 0, 0, 255] as const;
export const BLUE = [0, 0, 200, 255] as const;
export const W = 4;
export const H = 2;

let engine: Promise<ImageEngine> | null = null;
/** The image-js engine (the same wasm instance the session boots, so a
 *  session's handles are readable through it). */
export const imageEngine = (): Promise<ImageEngine> =>
  (engine ??= bootEngine());

/** The W×H RGBA8 pixels: columns 0–1 red, 2–3 blue. */
export function twoColourRgba(w = W, h = H): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px.set(x < w / 2 ? RED : BLUE, (y * w + x) * 4);
  return px;
}

/** The two-colour image as PNG bytes, encoded by the engine itself. */
export async function twoColourPng(w = W, h = H): Promise<Uint8Array> {
  return (await imageEngine()).encode(twoColourRgba(w, h), w, h, "png");
}

/** Decode encoded bytes to `{ w, h, px }`. */
export async function decoded(bytes: Uint8Array) {
  const e = await imageEngine();
  const d = e.decode(bytes);
  try {
    return {
      w: d.width,
      h: d.height,
      px: Array.from(e.tile(d.handle, 0, 0, d.width, d.height)),
    };
  } finally {
    e.freeImage(d.handle);
  }
}

/** The session's current source pixels, row-major RGBA8. */
export async function sourcePixels(session: ImageSession) {
  const s = session.state().source;
  if (!s) throw new Error("no source ingested");
  const e = await imageEngine();
  return {
    w: s.width,
    h: s.height,
    px: Array.from(e.tile(s.handle, 0, 0, s.width, s.height)),
  };
}

/** One pixel of a `{ w, px }` readout. */
export const at = (img: { w: number; px: number[] }, x: number, y: number) =>
  img.px.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 4);

/** Wait until the session is idle: not busy, and no change for a few
 *  macrotasks. Commands fire their work without awaiting it (`void`). */
export async function quiesce(session: ImageSession): Promise<void> {
  let changes = 0;
  const sub = session.onDidChange(() => void changes++);
  try {
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < 4; i++) {
      const before = changes;
      await new Promise((r) => setTimeout(r, 2));
      quiet = !session.state().busy && changes === before ? quiet + 1 : 0;
    }
  } finally {
    sub.dispose();
  }
}

type Handler = (paged: unknown, payload?: unknown) => unknown;

/** The bundle loaded over the fake editor, with its frame `u1` holding
 *  the two-colour PNG at [top 0, left 0, bottom 100, right 200] and
 *  selected (so `adjustSelected` ingests it). */
export async function bundleOnFake(
  options: {
    shell?: Partial<ReturnType<typeof shellStub>> & {
      saveFile?: (o: {
        suggestedName: string;
        bytes: Uint8Array;
        mimeType?: string;
      }) => Promise<boolean>;
    };
    select?: boolean;
    toolSettings?: ToolSettingsBackend;
  } = {},
) {
  const fake = makeFakeEditor();
  fake.placed.set("u1", await twoColourPng());
  fake.geometry.set("u1", {
    id: { kind: "rectangle", id: "u1" } as never,
    pageId: "pg1",
    bounds: [0, 0, 100, 200],
  } as ElementGeometryItem);
  if (options.select !== false)
    fake.emitSelection([{ kind: "rectangle", id: "u1" }]);
  const opened: string[] = [];
  const shell = {
    ...shellStub((id) => opened.push(id)),
    ...options.shell,
  };
  const loaded = loadBundle(() => fake.editor, imageBundle, {
    console: silentConsole,
    storage: mapBacking(),
    shell,
    ...(options.toolSettings ? { toolSettings: options.toolSettings } : {}),
  });
  const session = lastSession();
  const handler = (id: string): Handler => {
    const c = fake.commands.get(id) as unknown as { handler?: Handler };
    if (!c?.handler) throw new Error(`no registered command ${id}`);
    return c.handler;
  };
  /** Invoke a registered command and wait for its work to land. */
  const run = async (id: string, payload?: unknown) => {
    await handler(id)(fake.editor as PagedEditor, payload);
    await quiesce(session);
  };
  /** Ingest the selected frame through the Adjust command. */
  const ingest = async () => {
    await run(`${C}.adjustSelected`);
    await waitFor(() => expect(session.state().source).not.toBeNull(), {
      timeout: 5000,
    });
    await quiesce(session);
  };
  /** The mutations sent to the document, the ingest's ownership marker
   *  (`setPluginMetadata`) excluded. */
  const docOps = () =>
    fake.mutations.filter(
      (m) => (m as { op?: string }).op !== "setPluginMetadata",
    ) as Array<{ op: string; args: Record<string, unknown> }>;
  const dispose = () => loaded.dispose();
  /** The gesture DSL over the REGISTERED tools (`g.tool(<tool id>)`
   *  mounts the contribution's own gesture), on the frame's page `pg1`.
   *  The frame is 200×100 pt holding 4×2 px: 50 pt per pixel, origin
   *  (0, 0). */
  const tools = () =>
    gestures({
      editor: fake.editor as PagedEditor,
      pages: [{ id: "pg1", origin: [0, 0], size: [612, 792] }],
      tools: () =>
        fake.tools
          .ids()
          .map((id) => fake.tools.get(id) as unknown as ToolContribution),
    });
  return { fake, loaded, session, run, ingest, opened, docOps, tools, dispose };
}

/** Replace session methods with recorders (optionally answering), so a
 *  tool's gesture can be followed past the GPU gate Node cannot cross:
 *  `brushBegin` answering true lets the stroke's extend / commit
 *  sequence run. Returns the call log. */
export function spyOn(
  session: ImageSession,
  answers: Partial<Record<keyof ImageSession, unknown>>,
): string[] {
  const calls: string[] = [];
  const target = session as unknown as Record<string, unknown>;
  for (const [name, answer] of Object.entries(answers)) {
    target[name] = (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return Promise.resolve(answer);
    };
  }
  return calls;
}

/** What a command must leave alone when it refuses: the source, the
 *  layer stack, the history and the selection. */
export function imageShape(session: ImageSession) {
  const s = session.state();
  return {
    source: s.source && [s.source.width, s.source.height],
    layers: s.layers.layers.map((l) => [l.name, l.kind, l.hasMask]),
    history: s.history && [s.history.depth, s.history.redoDepth],
    selection: s.selection && [
      s.selection.x,
      s.selection.y,
      s.selection.w,
      s.selection.h,
    ],
    pattern: s.pattern,
    uncommitted: s.uncommitted,
  };
}

// ── the headless host: the real canvas engine's document ─────────────

/** This package's own @paged-media/canvas-wasm (the headless engine). */
const ENGINE_ANCHOR = fileURLToPath(new URL(".", import.meta.url));

/** The rectangle of `minimalIdml()` the image is placed in. */
export const FRAME = "urect";

/**
 * The bundle on the headless host: the minimal IDML loaded, the
 * two-colour PNG placed in its rectangle (one document undo step, so the
 * frame's ORIGINAL image is what a later document undo comes back to),
 * the rectangle selected. `changes` counts document changes from here on.
 */
export async function bundleOnHeadless() {
  const h: HeadlessHost = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silentConsole,
  });
  await h.load(minimalIdml());
  h.loadBundle(imageBundle);
  const session = lastSession();
  const placed = await h.host.document.mutate({
    op: "replaceImageBytes",
    args: { elementId: FRAME, bytes: Array.from(await twoColourPng()) },
  } as never);
  expect(placed.applied).toBe(true);
  await h.host.selection.set([{ kind: "rectangle", id: FRAME } as never]);
  let changes = 0;
  const sub = h.host.document.onDidChange(() => void changes++);
  const handler = (id: string): Handler => {
    const c = h.contributions.find((x) => x.kind === "command" && x.id === id);
    const fn = (c?.value as { handler?: Handler } | undefined)?.handler;
    if (!fn) throw new Error(`no registered command ${id}`);
    return fn;
  };
  const run = async (id: string, payload?: unknown) => {
    await handler(id)(h.host.editor, payload);
    await quiesce(session);
  };
  const ingest = async () => {
    await run(`${C}.adjustSelected`);
    await waitFor(() => expect(session.state().source).not.toBeNull(), {
      timeout: 5000,
    });
    await quiesce(session);
    changes = 0;
  };
  /** The frame's placed image, decoded. */
  const framePixels = async () =>
    decoded((await h.host.assets.getPlacedImage(FRAME))!.bytes);
  /** Commit the image's edits to the document. */
  const commit = () => run(`${C}.commitImage`);
  const dispose = () => {
    sub.dispose();
    h.dispose();
  };
  return {
    h,
    session,
    run,
    ingest,
    framePixels,
    commit,
    changes: () => changes,
    dispose,
  };
}
