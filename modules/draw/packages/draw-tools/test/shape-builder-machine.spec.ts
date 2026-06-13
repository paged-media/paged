import { describe, expect, it } from "vitest";

import { ShapeBuilderMachine } from "../src";

const NONE = { alt: false };
const ALT = { alt: true };

describe("ShapeBuilderMachine", () => {
  it("down begins a gesture; mode is unite without Alt", () => {
    const m = new ShapeBuilderMachine();
    const s = m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    expect(s.building).toBe(true);
    expect(s.mode).toBe("unite");
    expect(s.path).toEqual([[10, 10]]);
    expect(s.crossed).toEqual([]);
  });

  it("Alt-down fixes the gesture to subtract for the whole gesture", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: ALT });
    // A later cross does not change the (start-fixed) mode.
    const s = m.handle({ type: "cross", key: "ua" });
    expect(s.mode).toBe("subtract");
  });

  it("collects crossed region keys in first-cross order, de-duped", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    m.handle({ type: "move", point: [50, 50] });
    m.handle({ type: "cross", key: "ub" });
    // A repeat of ua (re-entering the first region) is ignored.
    m.handle({ type: "cross", key: "ua" });
    const s = m.handle({ type: "cross", key: "uc" });
    expect(s.crossed).toEqual(["ua", "ub", "uc"]);
  });

  it("ignores cross events that arrive before a down (no active gesture)", () => {
    const m = new ShapeBuilderMachine();
    const s = m.handle({ type: "cross", key: "ua" });
    expect(s.crossed).toEqual([]);
    expect(s.building).toBe(false);
  });

  it("move extends the gesture polyline while dragging", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [10, 0] });
    const s = m.handle({ type: "move", point: [20, 0] });
    expect(s.path).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it("up freezes the gesture; crossed + path persist, building flips false", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    m.handle({ type: "cross", key: "ub" });
    const s = m.handle({ type: "up", point: [100, 100] });
    expect(s.building).toBe(false);
    expect(s.crossed).toEqual(["ua", "ub"]);
    expect(s.path?.at(-1)).toEqual([100, 100]);
    // After up, further cross events are inert (no active drag).
    const after = m.handle({ type: "cross", key: "uc" });
    expect(after.crossed).toEqual(["ua", "ub"]);
  });

  it("Escape clears the gesture state", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    const s = m.handle({ type: "key", key: "Escape" });
    expect(s.path).toBeNull();
    expect(s.crossed).toEqual([]);
    expect(s.building).toBe(false);
  });

  it("snapshots are defensive copies (mutating a snapshot doesn't leak)", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const s = m.handle({ type: "cross", key: "ua" });
    (s.crossed as string[]).push("mutant");
    (s.path as unknown as number[][])?.push([99, 99]);
    const fresh = m.handle({ type: "move", point: [1, 1] });
    expect(fresh.crossed).toEqual(["ua"]);
    expect(fresh.path).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});
