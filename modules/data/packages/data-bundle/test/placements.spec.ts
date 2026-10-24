// The data door's `placements` (editor ADR 291's field markers), without the
// engine: `placedElements` over the session's facts and the labels, and the
// door adding each binding's sync state.

import { describe, expect, it } from "bun:test";
import type { ElementId } from "@paged-media/plugin-api";

import { createDataDoor, type DataDoorDeps } from "../src/data-door";
import {
  placedElements,
  type HostFacts,
  type PayloadJson,
} from "../src/labels";

const el = (kind: string, id: string) => ({ kind, id }) as ElementId;

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  hostOids: new Map(),
  hostElements: new Map(),
  visibility: new Map(),
  image: new Map(),
  barcode: new Map(),
  lowered: new Map(),
  storyHosted: new Map(),
  ...over,
});

describe("placements [editor-shell.data-panel]", () => {
  it("places each binding in the page item that carries it, if the document has it", () => {
    const payload: PayloadJson = {
      bindings: [
        { id: "img", kind: "image" },
        { id: "tbl", kind: "table" },
        { id: "var", kind: "variable" },
        { id: "prop", kind: "property", target: { selector: "x" } },
        { id: "gone", kind: "barcode" },
        { id: "doc", kind: "variable" },
      ] as never,
    };
    const elements = [
      { element: el("rectangle", "u12"), data: null },
      { element: el("textFrame", "u3"), data: null },
      { element: el("textFrame", "u9"), data: null },
      { element: el("oval", "u20"), data: null },
    ];
    const placed = placedElements(
      payload,
      facts({
        image: new Map([["img", { elementId: "u12" }]]),
        lowered: new Map([["tbl", el("textFrame", "u3")]]),
        storyHosted: new Map([["var", { frame: "u9" }]]),
        hostElements: new Map([["prop", el("oval", "u20")]]),
        barcode: new Map([["gone", { elementId: "u99" }]]),
      }),
      elements,
    );
    expect(
      placed.map((p) => [p.binding, `${p.element.kind}:${p.element.id}`]),
    ).toEqual([
      ["img", "rectangle:u12"],
      ["tbl", "textFrame:u3"],
      ["var", "textFrame:u9"],
      ["prop", "oval:u20"],
    ]);
  });

  it("the door answers each placement with its binding's sync state", async () => {
    const status: Record<string, string | null> = {
      a: "linked",
      b: "stale",
      c: null,
    };
    const deps = {
      placements: async () => [
        { binding: "a", address: "rectangle:u1" },
        { binding: "b", address: "textFrame:u2" },
        { binding: "c", address: "oval:u3" },
      ],
      syncStatusOf: (id: string) => status[id] ?? null,
    } as unknown as DataDoorDeps;
    const door = createDataDoor(deps);
    expect(await door.service.placements!()).toEqual([
      { binding: "a", address: "rectangle:u1", status: "linked" },
      { binding: "b", address: "textFrame:u2", status: "stale" },
      { binding: "c", address: "oval:u3", status: "unresolved" },
    ]);
  });
});
