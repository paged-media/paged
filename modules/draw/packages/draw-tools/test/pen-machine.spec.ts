import { describe, expect, it } from "vitest";

import { PenMachine, type PenModifiers } from "../src/pen-machine";

const NONE: PenModifiers = { shift: false, alt: false };
const SHIFT: PenModifiers = { shift: true, alt: false };
const ALT: PenModifiers = { shift: false, alt: true };

function machine() {
  return new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
}

function click(m: PenMachine, point: [number, number], mods = NONE) {
  m.handle({ type: "down", point, modifiers: mods });
  return m.handle({ type: "up", point, modifiers: mods });
}

describe("PenMachine — clicks", () => {
  it("click places a corner anchor", () => {
    const m = machine();
    const snap = click(m, [10, 10]);
    expect(snap.anchors).toHaveLength(1);
    expect(snap.anchors[0]).toEqual({
      anchor: [10, 10],
      left: [10, 10],
      right: [10, 10],
    });
    expect(snap.active).toBe(true);
    expect(snap.commit).toBeNull();
  });

  it("Shift+click constrains placement to 45° from the previous anchor", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = click(m, [20, 3], SHIFT);
    expect(snap.anchors[1].anchor[1]).toBeCloseTo(0);
  });

  it("Enter commits an open path with >= 2 anchors", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(true);
    expect(snap.commit!.anchors).toHaveLength(2);
    expect(snap.active).toBe(false);
  });

  it("Enter with a single anchor cancels instead of committing", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape cancels without commit", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });
});

describe("PenMachine — drags (smooth anchors)", () => {
  it("drag creates a smooth anchor with mirrored handles", () => {
    const m = machine();
    m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    m.handle({ type: "move", point: [18, 14], modifiers: NONE });
    const snap = m.handle({ type: "up", point: [18, 14], modifiers: NONE });
    expect(snap.anchors[0].anchor).toEqual([10, 10]);
    expect(snap.anchors[0].right).toEqual([18, 14]);
    expect(snap.anchors[0].left).toEqual([2, 6]);
  });

  it("movement under the drag threshold stays a corner", () => {
    const m = machine();
    m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    m.handle({ type: "move", point: [11, 10], modifiers: NONE });
    const snap = m.handle({ type: "up", point: [11, 10], modifiers: NONE });
    expect(snap.anchors[0].right).toEqual([10, 10]);
  });

  it("Alt during drag freezes the mirrored left handle", () => {
    const m = machine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [10, 0], modifiers: NONE });
    // left mirrored to [-10, 0] here; Alt breaks the pair…
    m.handle({ type: "move", point: [10, 10], modifiers: ALT });
    const snap = m.handle({ type: "up", point: [10, 10], modifiers: ALT });
    expect(snap.anchors[0].right).toEqual([10, 10]);
    expect(snap.anchors[0].left).toEqual([-10, 0]);
  });

  it("Shift constrains the handle pull", () => {
    const m = machine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [20, 2], modifiers: SHIFT });
    const snap = m.handle({ type: "up", point: [20, 2], modifiers: SHIFT });
    expect(snap.anchors[0].right[1]).toBeCloseTo(0);
  });
});

describe("PenMachine — closing + preview", () => {
  it("clicking the first anchor closes the path", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    click(m, [30, 30]);
    const snap = click(m, [1, 1]); // within closeTolerance of [0,0]
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(false);
    expect(snap.commit!.anchors).toHaveLength(3);
    expect(snap.active).toBe(false);
  });

  it("hover publishes the rubber band and the close preview", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    let snap = m.handle({ type: "move", point: [40, 10], modifiers: NONE });
    expect(snap.rubberTo).toEqual([40, 10]);
    expect(snap.closePreview).toBe(false);
    snap = m.handle({ type: "move", point: [2, 1], modifiers: NONE });
    expect(snap.closePreview).toBe(true);
  });

  it("a close-click on the first anchor of a 1-anchor path places a point instead", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = click(m, [1, 1]);
    expect(snap.commit).toBeNull();
    expect(snap.anchors).toHaveLength(2);
  });

  it("events after commit are inert", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    m.handle({ type: "key", key: "Enter" });
    const snap = click(m, [50, 50]);
    expect(snap.active).toBe(false);
    expect(snap.anchors).toHaveLength(2);
  });
});
