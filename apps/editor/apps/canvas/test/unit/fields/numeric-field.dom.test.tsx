/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The one numeric field (packages/ui inputs/NumericField.tsx): a scrub is
// one commit with live previews under one coalesce key, Escape restores, a
// mixed selection reads "Mixed", a refused value says why, a relative entry
// over a mixed selection goes to each object, the bound badge, the locale's
// decimal comma.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
  StringsProvider,
} from "@paged-media/strings";
import {
  NumericField,
  POINTS_PER_UNIT,
  resetDocumentUnit,
  type NumericCommitMeta,
} from "@paged-media/ui";

beforeEach(() => {
  localStorage.clear();
  resetDocumentUnit();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetDocumentUnit();
  // A StringsProvider makes its strings the active ones; back to English.
  setActiveStrings(createStrings());
});

const input = (c: HTMLElement) => c.querySelector("input")!;
const handle = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-scrub-handle]")!;

/** A scrub on the handle: down at x0, a move to each x, then up (or a
 *  pointer cancel). */
async function scrub(
  c: HTMLElement,
  xs: number[],
  end: "up" | "cancel" = "up",
  x0 = 100,
) {
  const h = handle(c);
  await act(async () => {
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: x0 });
  });
  for (const x of xs)
    await act(async () => {
      fireEvent.pointerMove(h, { pointerId: 1, clientX: x });
    });
  await act(async () => {
    if (end === "up") fireEvent.pointerUp(h, { pointerId: 1, clientX: x0 });
    else fireEvent.pointerCancel(h, { pointerId: 1 });
  });
}

describe("UXI-PNL-005 — the one numeric field commits by input type @uxi:UXI-PNL-002", () => {
  test("a scrub previews live and commits once, every value under one key", async () => {
    const onPreview = mock((_v: number, _m: NumericCommitMeta) => {});
    const onCommit = mock((_v: number, _m: NumericCommitMeta) => {});
    const { container } = render(
      <NumericField
        value={10}
        label="W"
        onPreview={onPreview}
        onCommit={onCommit}
      />,
    );
    await scrub(container, [103, 106, 109]);
    expect(onPreview.mock.calls.map(([v]) => v)).toEqual([13, 16, 19]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [value, meta] = onCommit.mock.calls[0]!;
    expect(value).toBe(19);
    expect(meta.source).toBe("scrub");
    expect(meta.coalesceKey).toBeTruthy();
    for (const [, m] of onPreview.mock.calls)
      expect(m.coalesceKey).toBe(meta.coalesceKey);
  });

  test("two scrubs carry two keys", async () => {
    const keys: (string | null)[] = [];
    const { container } = render(
      <NumericField
        value={0}
        label="X"
        onPreview={() => {}}
        onCommit={(_v, m) => keys.push(m.coalesceKey)}
      />,
    );
    await scrub(container, [110]);
    await scrub(container, [120]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a cancelled scrub commits nothing and puts back the preview", async () => {
    const onCommit = mock(() => {});
    const onCancelPreview = mock(() => {});
    const { container } = render(
      <NumericField
        value={10}
        label="W"
        onPreview={() => {}}
        onCommit={onCommit}
        onCancelPreview={onCancelPreview}
      />,
    );
    await scrub(container, [130], "cancel");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
    expect(input(container).value).toBe("10");
  });

  test("a scrub released where it began closes its preview without a commit", async () => {
    const onCommit = mock(() => {});
    const onCancelPreview = mock(() => {});
    const { container } = render(
      <NumericField
        value={10}
        label="W"
        onPreview={() => {}}
        onCommit={onCommit}
        onCancelPreview={onCancelPreview}
      />,
    );
    await scrub(container, [130, 100]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });

  test("without a preview the scrub shows its number and commits on release only", async () => {
    const onCommit = mock((_v: number) => {});
    const { container } = render(
      <NumericField value={5} label="R" onCommit={onCommit} />,
    );
    const h = handle(container);
    await act(async () => {
      fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 0 });
    });
    await act(async () => {
      fireEvent.pointerMove(h, { pointerId: 1, clientX: 7 });
    });
    expect(input(container).value).toBe("12");
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerUp(h, { pointerId: 1 });
    });
    expect(onCommit.mock.calls.map(([v]) => v)).toEqual([12]);
  });

  test("Enter commits a typed expression; Escape restores and commits nothing", async () => {
    const user = userEvent.setup();
    const onCommit = mock((_v: number, _m: NumericCommitMeta) => {});
    const { container, rerender } = render(
      <NumericField
        value={10 * POINTS_PER_UNIT.mm}
        length
        unit="mm"
        onCommit={onCommit}
      />,
    );
    expect(input(container).value).toBe("10 mm");
    await user.click(input(container));
    await user.clear(input(container));
    await user.type(input(container), "50{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(input(container).value).toBe("10 mm");

    await user.click(input(container));
    await user.clear(input(container));
    await user.type(input(container), "10 mm + 2 pt{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    // 10 mm + 2 pt is 10.7056 mm, committed as shown: to the unit's digits.
    expect(onCommit.mock.calls[0]![0]).toBeCloseTo(
      10.71 * POINTS_PER_UNIT.mm,
      6,
    );
    expect(onCommit.mock.calls[0]![1].source).toBe("type");
    rerender(
      <NumericField
        value={onCommit.mock.calls[0]![0]}
        length
        unit="mm"
        onCommit={onCommit}
      />,
    );
    expect(input(container).value).toBe("10.71 mm");
  });

  test("blur commits typed text once (Enter's blur is not a second commit)", async () => {
    const user = userEvent.setup();
    const onCommit = mock((_v: number) => {});
    const { container } = render(
      <>
        <NumericField value={1} onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );
    await user.click(input(container));
    await user.clear(input(container));
    await user.type(input(container), "2{Enter}");
    await user.click(container.querySelector("button")!);
    expect(onCommit.mock.calls.map(([v]) => v)).toEqual([2]);
    await user.click(input(container));
    await user.clear(input(container));
    await user.type(input(container), "3*3");
    await user.click(container.querySelector("button")!);
    expect(onCommit.mock.calls.map(([v]) => v)).toEqual([2, 9]);
  });

  test("an arrow key steps by the step (Shift ×10) and commits as a step", async () => {
    const user = userEvent.setup();
    const onCommit = mock((_v: number, _m: NumericCommitMeta) => {});
    const { container } = render(
      <NumericField value={4} step={0.5} onCommit={onCommit} />,
    );
    await user.click(input(container));
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(onCommit.mock.calls.map(([v]) => v)).toEqual([4.5, -0.5]);
    expect(onCommit.mock.calls[0]![1].source).toBe("step");
  });
});

describe("UXI-PNL-008 — mixed, empty and zero are different states @uxi:UXI-SEL-016", () => {
  test("a mixed selection reads Mixed, never 0", () => {
    const { container } = render(
      <NumericField value={null} mixed onCommit={() => {}} />,
    );
    expect(input(container).value).toBe("Mixed");
    const root = container.querySelector("[data-numeric-field]")!;
    expect(root.getAttribute("data-field-state")).toBe("mixed");
    expect(root.hasAttribute("data-mixed")).toBe(true);
  });

  test("no value reads the em-dash; zero reads 0; an unset value its name", () => {
    const none = render(<NumericField value={null} />).container;
    expect(input(none).value).toBe("—");
    expect(
      none
        .querySelector("[data-numeric-field]")!
        .getAttribute("data-field-state"),
    ).toBe("none");
    cleanup();
    expect(input(render(<NumericField value={0} />).container).value).toBe("0");
    cleanup();
    expect(
      input(render(<NumericField value={null} unsetText="Auto" />).container)
        .value,
    ).toBe("Auto");
  });

  test("the field reads Gemischt in German", () => {
    const { container } = render(
      <StringsProvider strings={createStrings("de", BUILT_IN_LOCALES.de)}>
        <NumericField value={null} mixed />
      </StringsProvider>,
    );
    expect(input(container).value).toBe("Gemischt");
  });
});

describe("UXI-PNL-010 — a relative entry over a mixed selection applies to each", () => {
  test("+=5 mm goes to each object as an edit in points", async () => {
    const user = userEvent.setup();
    const onCommit = mock(() => {});
    const onCommitRelative = mock(() => {});
    const { container } = render(
      <NumericField
        value={null}
        mixed
        length
        unit="mm"
        onCommit={onCommit}
        onCommitRelative={onCommitRelative}
      />,
    );
    await user.click(input(container));
    await user.type(input(container), "+=5 mm{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    const [edit] = onCommitRelative.mock.calls[0] as unknown as [
      { op: string; operand: number; percent: boolean },
    ];
    expect(edit.op).toBe("+");
    expect(edit.operand).toBeCloseTo(5 * POINTS_PER_UNIT.mm, 6);
    await user.click(input(container));
    await user.type(input(container), "*110%{Enter}");
    expect(
      (onCommitRelative.mock.calls[1] as unknown as [{ operand: number }])[0]
        .operand,
    ).toBeCloseTo(1.1, 9);
  });

  test("without a per-object write a relative entry over Mixed is refused in words", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <NumericField value={null} mixed onCommit={() => {}} />,
    );
    await user.click(input(container));
    await user.type(input(container), "+=5{Enter}");
    expect(input(container).getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "+=5",
    );
  });
});

describe("UXI-PNL-009 — a refused value says why", () => {
  test("invalid syntax, out of range and an unsupported unit, each in words", async () => {
    const user = userEvent.setup();
    const onCommit = mock(() => {});
    const { container } = render(
      <NumericField
        value={50}
        suffix="%"
        min={0}
        max={100}
        onCommit={onCommit}
      />,
    );
    const alert = () => container.querySelector('[role="alert"]');
    const typed = async (text: string) => {
      await user.click(input(container));
      await user.clear(input(container));
      await user.type(input(container), `${text}{Enter}`);
    };
    await typed("10 +");
    expect(input(container).getAttribute("aria-invalid")).toBe("true");
    expect(alert()!.getAttribute("data-numeric-error")).toBe("syntax");
    expect(input(container).getAttribute("aria-describedby")).toBe(alert()!.id);
    await user.keyboard("{Escape}");
    expect(alert()).toBeNull();

    await typed("150");
    expect(alert()!.textContent).toBe("Between 0 % and 100 %");
    await user.keyboard("{Escape}");

    await typed("10 mm");
    expect(alert()!.textContent).toBe("This field does not take mm");
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(input(container).value).toBe("50 %");
  });

  test("German reads the decimal comma", async () => {
    const user = userEvent.setup();
    const onCommit = mock((_v: number) => {});
    const { container } = render(
      <StringsProvider strings={createStrings("de", BUILT_IN_LOCALES.de)}>
        <NumericField value={1} onCommit={onCommit} />
      </StringsProvider>,
    );
    await user.click(input(container));
    await user.clear(input(container));
    await user.type(input(container), "12,5{Enter}");
    expect(onCommit.mock.calls.map(([v]) => v)).toEqual([12.5]);
  });
});

describe("UXI-PNL-011 — a data-bound value shows its binding", () => {
  test("the bound badge names the source", () => {
    const { container } = render(
      <NumericField value={3} bound="Products" onCommit={() => {}} />,
    );
    const badge = container.querySelector('[data-badge="bound"]')!;
    expect(badge.getAttribute("title")).toBe("Bound to Products");
    expect(
      container
        .querySelector("[data-numeric-field]")!
        .hasAttribute("data-bound"),
    ).toBe(true);
  });
});
