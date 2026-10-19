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

// The kit's plain parts: the refusal wording over every shape a refusal
// reaches a panel in, `humanize`, the debouncer and its hook, and the
// tokens' one-fallback rule.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "bun:test";

import {
  color,
  createDebouncer,
  font,
  humanize,
  refusalText,
  status,
  useDebouncedValue,
} from "../src";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("refusalText", () => {
  it("drops a command id in front and the trailing no-op", () => {
    expect(
      refusalText(
        "media.paged.draw.blend.make: select exactly two objects — no-op",
      ),
    ).toBe("Select exactly two objects.");
    expect(refusalText("draw panel: the engine refused the batch")).toBe(
      "The engine refused the batch.",
    );
    expect(refusalText("Already a sentence.")).toBe("Already a sentence.");
    expect(refusalText(new Error("no page selected"))).toBe(
      "No page selected.",
    );
    expect(refusalText("")).toBe("The action did not run.");
    expect(refusalText(null)).toBe("The action did not run.");
  });

  // PN-4: a write the engine refused reached the Stroke panel as
  // `failed: {"error":{...}}`.
  it("reads an engine error in a write result's JSON as words", () => {
    const raw =
      'failed: {"error":{"kind":"notImplemented","details":{"what":"frame mutation failed: property FrameStrokeMiterLimit is not supported on Oval(\\"u3\\")"}}}';
    expect(refusalText(raw)).toBe(
      "Stroke miter limit does not apply to an oval.",
    );
    expect(refusalText(raw)).not.toContain("{");
  });

  // The draw commands log `<label>: rejected by engine: <the error's JSON>`.
  it("reads an engine error behind words as the error", () => {
    expect(
      refusalText(
        'Blend: rejected by engine: {"kind":"notImplemented","details":{"what":"frame mutation failed: property FrameFillColor is not supported on Group(\\"g1\\")"}}',
      ),
    ).toBe("Fill color does not apply to a group.");
    expect(refusalText("Could not place {name} here")).toBe(
      "Could not place {name} here.",
    );
  });

  // PN-262: Intersect on a rectangle and an oval showed the variant name.
  it("never shows a Rust variant name; the subject says what was refused", () => {
    const error = {
      kind: "notImplemented",
      details: { what: "Mutation::PathfinderBoolean" },
    };
    expect(refusalText(error, "Intersect")).toBe(
      "Intersect is not available for these objects yet.",
    );
    expect(refusalText(error)).toBe(
      "The engine cannot do this with these objects yet.",
    );
    expect(refusalText("Mutation::PathfinderBoolean")).not.toContain("::");
  });

  it("takes the reason after an internal head", () => {
    expect(
      refusalText({
        kind: "notImplemented",
        details: {
          what: "frame mutation failed: invalid value for FramePath on u9: the path has no closed face",
        },
      }),
    ).toBe("The path has no closed face.");
  });

  it("says what an error kind or a result code means, never the token", () => {
    expect(refusalText({ kind: "noDocument" })).toBe("No document is open.");
    expect(refusalText({ kind: "unknownPage", details: { pageId: "p" } })).toBe(
      "That page is no longer in the document.",
    );
    expect(refusalText("invalidValue")).toBe("That value cannot be used here.");
    expect(refusalText({ applied: false, code: "readOnly" })).toBe(
      "This value cannot be changed.",
    );
    expect(
      refusalText({
        applied: false,
        code: "invalidValue",
        reason: "the targets differ (mixed)",
      }),
    ).toBe("The targets differ (mixed)");
    expect(refusalText("invalidValue: the targets differ")).toBe(
      "The targets differ.",
    );
  });
});

describe("humanize", () => {
  it("turns tokens into sentence-case words", () => {
    expect(humanize("topLeft")).toBe("Top left");
    expect(humanize("easeInOut")).toBe("Ease in out");
    expect(humanize("grid")).toBe("Grid");
    expect(humanize("FrameStrokeMiterLimit")).toBe("Frame stroke miter limit");
    expect(humanize("")).toBe("");
  });
});

describe("createDebouncer", () => {
  it("a burst yields one trailing call, ms after the last", () => {
    vi.useFakeTimers();
    const d = createDebouncer(300);
    const calls: number[] = [];
    for (let i = 0; i < 5; i++) {
      d.schedule(() => calls.push(i));
      vi.advanceTimersByTime(100);
    }
    expect(calls).toEqual([]);
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(199);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([4]);
    expect(d.pending()).toBe(false);
  });

  it("cancel drops the pending call; flush runs it now", () => {
    vi.useFakeTimers();
    const d = createDebouncer(50);
    const fn = vi.fn();
    d.schedule(fn);
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    d.schedule(fn);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d.flush(); // nothing pending: nothing runs
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs on the timers it is given", () => {
    const queue: Array<() => void> = [];
    const d = createDebouncer(10, {
      setTimeout: (fn) => queue.push(fn),
      clearTimeout: () => {},
    });
    const fn = vi.fn();
    d.schedule(fn);
    expect(queue).toHaveLength(1);
    queue[0]!();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("useDebouncedValue", () => {
  it("shows the first value at once and a change once it settled", () => {
    vi.useFakeTimers();
    function Shown(props: { value: string }) {
      return <span>{useDebouncedValue(props.value, 300)}</span>;
    }
    const view = render(<Shown value="a" />);
    expect(view.container.textContent).toBe("a");
    view.rerender(<Shown value="ab" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    view.rerender(<Shown value="abc" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(view.container.textContent).toBe("a");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(view.container.textContent).toBe("abc");
  });
});

describe("tokens", () => {
  it("every token names a variable and exactly one fallback", () => {
    for (const value of [
      ...Object.values(color),
      ...Object.values(status),
      ...Object.values(font),
    ]) {
      expect(value).toMatch(/^var\(--[a-z0-9-]+, [^,]+\)$/);
    }
  });
});
