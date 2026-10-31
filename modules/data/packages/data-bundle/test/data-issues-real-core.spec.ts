// Data issues (data ADR 564) against the REAL stack: real core (canvas-wasm
// in the headless host) and the real data-js engine. A long value placed
// into a small text frame is overset, named at its frame, and published to
// the Problems store; enlarging the frame clears it. A picture over an
// asset column the user did not consent to is missing; a 1×1 picture in a
// frame is far under the resolution floor; an empty value is noted.
//
// The headless host lays text out without fonts: it reports no overflow and
// measures every word at zero. The test gives the host a font (6 pt a
// character, `text.measureStrings`), and the engine wraps the placed text
// at it, as the measured overset does in an editor whose layout said
// nothing.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import {
  bootRealEngine,
  DATA_JS_WASM,
  REQUIRE_REAL_ENGINE,
} from "./real-engine";

const actualEngine = await importActual(() => import("../src/engine"));
const ready = ENGINE_ANCHOR !== null && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_ENGINE;

// A 1×1 PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

const CONSUMER: PluginManifest = {
  id: "com.example.reader",
  name: "reader",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { data: { read: true, bind: true } },
};

describe.skipIf(!ready && !required)(
  "data issues over the real stack [data.issues]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    /** The bundle over the real stack, a consumer of its data door and a
     *  6 pt-a-character font; one CSV source, one query, refreshed. */
    async function boot() {
      expect(
        ready,
        "real core and the data-js wasm must both be available",
      ).toBe(true);
      mock.module("../src/engine", () => ({
        ...actualEngine,
        bootEngine: (today: number) => bootRealEngine(today),
      }));
      const mod = await import("../src/index");
      const h = await openRealHost({ engineShaper: true });
      hosts.push(h);
      let dataHost!: BundleHost;
      h.loadBundle({
        ...mod.dataBundle,
        activate: (bh: BundleHost) => {
          dataHost = bh;
          return mod.dataBundle.activate(bh);
        },
      } as typeof mod.dataBundle);
      let consumer!: BundleHost;
      h.loadBundle({
        manifest: CONSUMER,
        activate(bh: BundleHost) {
          consumer = bh;
          return { dispose() {} };
        },
      } as never);
      vi.spyOn(dataHost.text, "measureStrings").mockImplementation(
        async (_family, _style, texts) =>
          texts.map((t) => ({
            advance: t.length * 6,
            ascender: 9,
            descender: 3,
          })),
      );
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      await s.registerCsvSource(
        "products",
        `sku,name,note,photo,remote\nA-1,${LONG},,"data:image/png;base64,${PNG_B64}",https://unconsented.example/a.png\n`,
      );
      s.addQuery("q", "SELECT * FROM products", "recordStream");
      await s.refreshData();
      expect(await consumer.data.issues()).toEqual([]);
      const frameAt = async (bounds: number[]) => {
        const fr = (await dataHost.document.mutate({
          op: "batch",
          args: {
            ops: [
              { op: "insertTextFrame", args: { pageId: "usp", bounds } },
              { op: "bindCreated", args: { handle: "f" } },
            ],
          },
        } as never)) as { minted?: { element: { id: string } }[] };
        return fr.minted![0]!.element.id;
      };
      return { h, dataHost, consumer, s, frameAt };
    }

    it("reports overset text at its frame and clears it when the frame grows; missing, coarse and empty too", async () => {
      const { dataHost, consumer, s, frameAt } = await boot();

      // A long value in a small frame: overset, at that frame.
      const small = await frameAt([100, 100, 130, 200]);
      const placed = await consumer.data.place(
        `textFrame:${small}`,
        "q",
        "name",
      );
      const overset = (await consumer.data.issues()).filter(
        (i) => i.kind === "overset",
      );
      expect(overset).toEqual([
        {
          kind: "overset",
          severity: "warning",
          message: expect.stringContaining("does not fit its frame"),
          binding: placed.binding,
          address: `textFrame:${small}`,
        },
      ]);
      // Published to the Problems store, with the frame as its source.
      expect(
        dataHost.diagnostics
          .get("issues")
          .filter((d) => d.source === `textFrame:${small}`),
      ).toHaveLength(1);

      // An empty value placed: noted, not an error.
      const other = await frameAt([300, 100, 400, 400]);
      const empty = await consumer.data.place(
        `textFrame:${other}`,
        "q",
        "note",
      );
      expect(
        (await consumer.data.issues()).find((i) => i.binding === empty.binding),
      ).toMatchObject({ kind: "emptyValue", severity: "info" });

      // The frame grows: the text fits, the issue and its problem are gone.
      const grown = await dataHost.document.mutate({
        op: "resizeFrame",
        args: { frameId: small, bounds: [100, 100, 700, 500] },
      } as never);
      expect(grown.applied).toBe(true);
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([]);
      expect(
        dataHost.diagnostics
          .get("issues")
          .filter((d) => d.source === `textFrame:${small}`),
      ).toEqual([]);

      // Pictures over asset columns: one missing (no consent), one placed
      // at 1×1 pixels — far under the floor at any frame size.
      s.setAssetColumn("q", "photo", {});
      s.setAssetColumn("q", "remote", {});
      s.addImageBinding("img", "urect", "q", "photo");
      s.addImageBinding("img2", "urect", "q", "remote");
      await s.lowerBinding("img");
      await s.lowerBinding("img2");
      const pictures = (await consumer.data.issues()).filter(
        (i) => i.binding === "img" || i.binding === "img2",
      );
      expect(pictures).toEqual([
        {
          kind: "missingAsset",
          severity: "error",
          message: expect.stringContaining("is missing"),
          binding: "img2",
          address: "rectangle:urect",
        },
        {
          kind: "lowResolution",
          severity: "warning",
          message: expect.stringMatching(/is \d+ ppi .* under 150 ppi/),
          binding: "img",
          address: "rectangle:urect",
        },
      ]);
    });

    it("checks a variable Lower placed: its frame is in the placements and its overset is named there", async () => {
      const { consumer, s } = await boot();
      s.addVariableBinding("v_name", "v_name", "q", "name");
      await s.lowerAll();
      // Placed as a text variable in a frame Lower minted (160 × 60 pt).
      const at = (await consumer.data.placements()).find(
        (p) => p.binding === "v_name",
      );
      expect(at?.address).toMatch(/^textFrame:/);
      const overset = (await consumer.data.issues()).filter(
        (i) => i.kind === "overset",
      );
      expect(overset).toEqual([
        {
          kind: "overset",
          severity: "warning",
          message: expect.stringContaining("does not fit its frame"),
          binding: "v_name",
          address: at!.address,
        },
      ]);
    });

    it("checks a copy of a field's text variable pasted by hand into another story", async () => {
      const { dataHost, consumer, s, frameAt } = await boot();
      s.addVariableBinding("v_name", "v_name", "q", "name");
      await s.lowerAll();
      // The field's text variable, and a second, tiny frame holding an
      // instance of it the session never placed (a copy the user pasted).
      const [variable] = await dataHost.objects.query(
        'textVariable[name="paged:v_name"]',
      );
      expect(variable).toBeTruthy();
      const frame = await frameAt([400, 100, 410, 110]);
      const geom = await dataHost.document.elementGeometry([
        { kind: "textFrame", id: frame } as never,
      ]);
      const g = geom[0] as { bounds: number[]; pageId: string };
      const hit = await dataHost.document.hitTest(g.pageId as never, [
        (g.bounds[1]! + g.bounds[3]!) / 2,
        (g.bounds[0]! + g.bounds[2]!) / 2,
      ]);
      const storyId = hit!.storyId as string;
      const pasted = await dataHost.document.mutate({
        op: "insertField",
        args: {
          storyId,
          offset: 0,
          field: {
            textVariable: {
              variableId: variable!.slice("textVariable:".length),
            },
          },
        },
      } as never);
      expect(pasted.applied).toBe(true);
      const overset = (await consumer.data.issues()).filter(
        (i) => i.kind === "overset" && i.address === `textFrame:${frame}`,
      );
      expect(overset).toEqual([
        expect.objectContaining({ binding: "v_name", kind: "overset" }),
      ]);
    });

    it("measures a story threaded over two frames and names its overset at the last one", async () => {
      const { dataHost, consumer, frameAt } = await boot();
      const first = await frameAt([100, 100, 130, 200]);
      const last = await frameAt([200, 100, 230, 200]);
      const linked = await dataHost.document.mutate({
        op: "linkFrames",
        args: { from: first, to: last },
      } as never);
      expect(linked.applied).toBe(true);
      const placed = await consumer.data.place(
        `textFrame:${first}`,
        "q",
        "name",
      );
      // The host's chain reports no overflow (no fonts); the engine wraps
      // the text through both frames and runs out at the second.
      const story = (await dataHost.document.hitTest(
        "usp" as never,
        [150, 115],
      ))!.storyId!;
      const chain = await dataHost.document.frameChain(story);
      expect(chain.map((l) => l.frameId)).toEqual([first, last]);
      expect(chain.some((l) => l.overflow)).toBe(false);
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([
        {
          kind: "overset",
          severity: "warning",
          message: expect.stringContaining("does not fit its frame"),
          binding: placed.binding,
          address: `textFrame:${last}`,
        },
      ]);
      // The second frame grows: the text fits the chain, the issue is gone.
      const grown = await dataHost.document.mutate({
        op: "resizeFrame",
        args: { frameId: last, bounds: [200, 100, 700, 500] },
      } as never);
      expect(grown.applied).toBe(true);
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([]);
    });

    it("measures a run at its character style's size, not the story's", async () => {
      const { dataHost, consumer, frameAt } = await boot();
      const frame = await frameAt([100, 100, 160, 400]);
      const placed = await consumer.data.place(
        `textFrame:${frame}`,
        "q",
        "sku",
      );
      const story = (await dataHost.document.hitTest(
        "usp" as never,
        [250, 130],
      ))!.storyId!;
      const content = await dataHost.document.storyContent(story);
      const length = content!.paragraphs
        .flatMap((p) => p.runs.map((r) => r.text))
        .join("").length;
      // A character style sets 72 pt; the run itself names no size.
      const made = await dataHost.document.mutate({
        op: "createCharacterStyle",
        args: { name: "Big" },
      } as never);
      expect(made.applied).toBe(true);
      const before = new Set<string>();
      const style = (await dataHost.objects.query("style")).find(
        (a) =>
          a.startsWith("style:character/") &&
          !a.includes("$ID") &&
          !before.has(a),
      )!;
      expect(style).toBeTruthy();
      const ref = style.slice("style:character/".length);
      await dataHost.objects.set(style, "characterFontSize", 72 as never);
      expect(
        (
          (await dataHost.objects.get(style, "characterFontSize")) as {
            value?: unknown;
          }
        ).value,
      ).toBe(72);
      const styled = await dataHost.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertText",
              args: { storyId: story, offset: length, text: " Big" },
            },
            {
              op: "setElementProperty",
              args: {
                elementId: {
                  kind: "storyRange",
                  id: { story_id: story, start: length + 1, end: length + 4 },
                },
                path: "appliedCharacterStyle",
                value: { type: "text", value: ref },
              },
            },
          ],
        },
      } as never);
      expect(styled.applied).toBe(true);
      const runs = (await dataHost.document.storyContent(
        story,
      ))!.paragraphs.flatMap((p) => p.runs);
      expect(runs.some((r) => r.characterStyle === ref)).toBe(true);
      expect(runs.every((r) => r.pointSize !== 72)).toBe(true);
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([
        expect.objectContaining({
          kind: "overset",
          binding: placed.binding,
          address: `textFrame:${frame}`,
        }),
      ]);
    });

    it("measures each run at its own size: a large run oversets a story one size would call fitting", async () => {
      const { dataHost, consumer, frameAt } = await boot();
      // 300 × 60 pt: "A-1" fits at any reading size.
      const frame = await frameAt([100, 100, 160, 400]);
      const placed = await consumer.data.place(
        `textFrame:${frame}`,
        "q",
        "sku",
      );
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([]);
      // The user adds a word set at 72 pt after the value: its line is
      // 86.4 pt tall (auto leading). The story's size now reads as mixed,
      // so a measure at one size (the story's default) would still fit.
      const story = (await dataHost.document.hitTest(
        "usp" as never,
        [250, 130],
      ))!.storyId!;
      const content = await dataHost.document.storyContent(story);
      const length = content!.paragraphs
        .flatMap((p) => p.runs.map((r) => r.text))
        .join("").length;
      const big = await dataHost.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertText",
              args: { storyId: story, offset: length, text: " Big" },
            },
            {
              op: "setElementProperty",
              args: {
                elementId: {
                  kind: "storyRange",
                  id: { story_id: story, start: length + 1, end: length + 4 },
                },
                path: "characterFontSize",
                value: { type: "length", value: 72 },
              },
            },
          ],
        },
      } as never);
      expect(big.applied).toBe(true);
      const sizes = (await dataHost.document.storyContent(story))!.paragraphs
        .flatMap((p) => p.runs)
        .map((r) => r.pointSize ?? null);
      expect(sizes).toContain(72);
      expect(
        (await consumer.data.issues()).filter((i) => i.kind === "overset"),
      ).toEqual([
        {
          kind: "overset",
          severity: "warning",
          // Measured, not the composer's word: the message says so.
          message: expect.stringContaining("an estimate"),
          binding: placed.binding,
          address: `textFrame:${frame}`,
        },
      ]);
    });

    it("asks the host the pixel size of a picture placed from a plain link", async () => {
      const { consumer, s } = await boot();
      // No asset column: the reference is placed as the link it is.
      s.addImageBinding("linked", "urect", "q", "photo");
      await s.lowerBinding("linked");
      expect(
        (await consumer.data.issues()).filter((i) => i.binding === "linked"),
      ).toEqual([
        {
          kind: "lowResolution",
          severity: "warning",
          message: expect.stringMatching(/is \d+ ppi .* under 150 ppi/),
          binding: "linked",
          address: "rectangle:urect",
        },
      ]);
    });
  },
);
