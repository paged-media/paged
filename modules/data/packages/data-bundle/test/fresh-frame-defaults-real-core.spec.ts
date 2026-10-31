// A merged frame copies only what its template frame sets beyond a fresh
// frame (src/merge.ts `isSetValue`): the merge writer makes one
// `setElementProperty` per copied property and record, so a property every
// frame reads at its default would cost an operation per record for nothing
// (the W8 merge budget, test/perf/perf-budgets-merge.spec.ts).
//
// The engine keeps adding frame properties (effect stacks, appearances, the
// paint v2 paths). Here a FRESH text frame and a fresh graphic frame of the
// real engine are read back and handed to the writer's own filter: it must
// copy nothing. A property the engine adds with a default the filter does not
// recognise fails here, named, instead of as an unexplained budget overrun.
//
// Gate: skips without canvas-wasm, EXCEPT under REQUIRE_REAL_CORE=1.

import { afterEach, describe, expect, it } from "bun:test";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { copiedFrameEntries, isSetValue } from "../src/merge";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";

type Minted = { minted?: { element: { kind: string; id: string } }[] };

/** A fresh frame of `kind` on the fixture's page; its address. */
async function freshFrame(
  host: BundleHost,
  kind: "textFrame" | "rectangle",
): Promise<ElementId> {
  const op = kind === "textFrame" ? "insertTextFrame" : "insertFrame";
  const r = (await host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op, args: { pageId: "usp", bounds: [72, 72, 144, 216] } },
        { op: "bindCreated", args: { handle: "f" } },
      ],
    },
  } as never)) as Minted;
  return { kind, id: r.minted![0]!.element.id } as ElementId;
}

describe("a fresh frame's values are not copied", () => {
  it("an empty structure is a fresh-frame default, whatever its path", () => {
    // A container property the engine might add tomorrow, read as on a
    // fresh frame: nothing in it, so nothing to copy.
    expect(
      isSetValue(
        { type: "futureStack", value: { items: [], prev: null } },
        "frameFutureStack",
      ),
    ).toBe(false);
    expect(
      isSetValue(
        { type: "futureStack", value: { inner: { items: [] }, name: "" } },
        "frameFutureStack",
      ),
    ).toBe(false);
    // The same container with something in it is copied.
    expect(
      isSetValue(
        { type: "futureStack", value: { items: [{ kind: "x" }], prev: null } },
        "frameFutureStack",
      ),
    ).toBe(true);
    expect(
      isSetValue({ type: "appearance", value: { layers: [], prev: null } }),
    ).toBe(false);
  });

  it("a choice at the engine catalog's default is not copied, another is", () => {
    // Paint v2 (engine ADR 1007): every frame reads its gradient stroke's
    // mode, "Within" on a fresh one — the catalog's default.
    expect(
      isSetValue({ type: "text", value: "Within" }, "frameGradientStrokeMode"),
    ).toBe(false);
    expect(
      isSetValue({ type: "text", value: "Along" }, "frameGradientStrokeMode"),
    ).toBe(true);
    // A length at the catalog's value is still copied: a fresh frame's
    // stroke weight may come from the document's defaults instead.
    expect(isSetValue({ type: "length", value: 1 }, "frameStrokeWeight")).toBe(
      true,
    );
  });

  describe.skipIf(!ENGINE_ANCHOR && !REQUIRE_REAL_CORE)(
    "over the real core",
    () => {
      const hosts: HeadlessHost[] = [];
      afterEach(() => {
        for (const h of hosts.splice(0)) h.dispose?.();
      });

      for (const kind of ["textFrame", "rectangle"] as const) {
        it(`a fresh ${kind} copies none of its properties`, async () => {
          const h = await openRealHost();
          hosts.push(h);
          const frame = await freshFrame(h.host, kind);
          const props = await h.host.document.elementProperties(frame);
          const entries = (props?.entries ?? []) as {
            path: string;
            value?: { type?: string; value?: unknown } | null;
          }[];
          // The read is a real one: a frame reads dozens of properties.
          expect(entries.length).toBeGreaterThan(20);
          // Every path named here is a frame property the engine reads at a
          // value the merge writer would copy onto every merged frame. Add its
          // fresh value to FRESH_FRAME_DEFAULTS in src/merge.ts.
          expect(
            copiedFrameEntries(entries).map(
              (p) => `${p.path} = ${JSON.stringify(p.value)}`,
            ),
          ).toEqual([]);
        });
      }
    },
  );
});
