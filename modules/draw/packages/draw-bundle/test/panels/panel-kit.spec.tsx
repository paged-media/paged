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

// @vitest-environment jsdom

// The shared panel pieces: the confirm step of a destructive button, the
// refusal a panel shows in place of a silent log line, and the labels.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  CONFIRM_TIMEOUT_MS,
  ConfirmButton,
  Refusal,
  elementKindLabel,
  humanize,
  refusalText,
  useActionFeedback,
} from "../../src/panels/panel-kit";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConfirmButton", () => {
  it("the first click arms it, the second runs the action", () => {
    const onConfirm = vi.fn();
    const view = render(<ConfirmButton label="Delete" onConfirm={onConfirm} />);
    const button = view.getByRole("button");
    expect(button.textContent).toBe("Delete");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Confirm delete");
    expect(button.getAttribute("data-armed")).toBe("true");
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("Delete");
  });

  it("an armed button reverts after a few seconds", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const view = render(<ConfirmButton label="Delete" onConfirm={onConfirm} />);
    const button = view.getByRole("button");
    fireEvent.click(button);
    act(() => {
      vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1);
    });
    expect(button.textContent).toBe("Delete");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("useActionFeedback", () => {
  const fakeHost = () => {
    const warn = vi.fn();
    return { host: { log: { warn, info: vi.fn(), debug: vi.fn() } } as unknown as BundleHost, warn };
  };

  function Harness(props: {
    host: BundleHost;
    work: (host: BundleHost) => Promise<unknown>;
    after: () => void;
  }) {
    const { refusal, run } = useActionFeedback(props.host, props.after);
    return (
      <div>
        <button type="button" onClick={() => void run(() => props.work(props.host))}>
          Go
        </button>
        <Refusal text={refusal} />
      </div>
    );
  }

  it("shows the command's refusal in the panel and still logs it", async () => {
    const { host, warn } = fakeHost();
    const after = vi.fn();
    const view = render(
      <Harness
        host={host}
        after={after}
        work={async (h) => {
          h.log.warn("media.paged.draw.command.defineSymbol: nothing capturable in the selection — no-op");
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(view.getByRole("status").textContent).toBe("Nothing capturable in the selection.");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("shows a thrown error, and nothing when the action succeeds", async () => {
    const { host } = fakeHost();
    let fail = true;
    const view = render(
      <Harness
        host={host}
        after={() => {}}
        work={async () => {
          if (fail) throw new Error("the engine refused the batch");
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(view.getByRole("status").textContent).toBe("The engine refused the batch.");
    fail = false;
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(view.queryByRole("status")).toBeNull();
  });
});

describe("labels", () => {
  it("refusalText drops the command prefix and the trailing no-op", () => {
    expect(refusalText("media.paged.draw.blend.make: select exactly two objects — no-op")).toBe(
      "Select exactly two objects.",
    );
    expect(refusalText("Already a sentence.")).toBe("Already a sentence.");
  });

  it("humanize turns tokens into sentence-case words", () => {
    expect(humanize("topLeft")).toBe("Top left");
    expect(humanize("easeInOut")).toBe("Ease in out");
    expect(humanize("grid")).toBe("Grid");
  });

  it("elementKindLabel names a selected element's kind", () => {
    expect(elementKindLabel({ kind: "polygon", id: "a" })).toBe("path");
    expect(elementKindLabel({ kind: "graphicLine", id: "b" })).toBe("line");
    expect(elementKindLabel({ kind: "textFrame", id: "c" })).toBe("text frame");
  });
});
