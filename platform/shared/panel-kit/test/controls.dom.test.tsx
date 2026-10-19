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

// The panel kit's controls, rendered in happy-dom: the confirm step, the
// disclosures, the refusal line and the action feedback, and the named
// icon button and pressed segment.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  About,
  CONFIRM_MS,
  ConfirmButton,
  Disclosure,
  IconButton,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  LabelledBy,
  NamedAs,
  Refusal,
  Segment,
  StatusLine,
  Tab,
  status,
  useActionFeedback,
  useConfirm,
  useDisclosure,
  useFieldName,
} from "../src";

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
    expect(button.getAttribute("data-armed")).toBe("false");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Confirm delete");
    expect(button.getAttribute("data-armed")).toBe("true");
    expect(button.style.color).toBe(status.error);
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
      vi.advanceTimersByTime(CONFIRM_MS + 1);
    });
    expect(button.textContent).toBe("Delete");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says the caller's words while armed and keeps its own title until then", () => {
    const view = render(
      <ConfirmButton
        label="New workbook"
        confirmLabel="Confirm replace"
        title="Replace the open workbook"
        onConfirm={() => {}}
      />,
    );
    const button = view.getByRole("button");
    expect(button.title).toBe("Replace the open workbook");
    fireEvent.click(button);
    expect(button.textContent).toBe("Confirm replace");
    expect(button.title).toMatch(/cannot be undone/);
  });
});

describe("useConfirm", () => {
  function Two(props: { onA: () => void; onB: () => void }) {
    const { armed, confirm } = useConfirm();
    return (
      <div>
        <button type="button" onClick={() => confirm("a", props.onA)}>
          {armed === "a" ? "Confirm a" : "A"}
        </button>
        <button type="button" onClick={() => confirm("b", props.onB)}>
          {armed === "b" ? "Confirm b" : "B"}
        </button>
      </div>
    );
  }

  it("arms one key at a time; arming another replaces the arm", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const view = render(<Two onA={onA} onB={onB} />);
    const [a, b] = view.getAllByRole("button");
    fireEvent.click(a!);
    expect(a!.textContent).toBe("Confirm a");
    fireEvent.click(b!);
    expect(a!.textContent).toBe("A");
    expect(b!.textContent).toBe("Confirm b");
    fireEvent.click(a!);
    expect(onA).not.toHaveBeenCalled();
    fireEvent.click(a!);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it("the arm lapses after CONFIRM_MS, restarted by a new arm", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    const view = render(<Two onA={onA} onB={() => {}} />);
    const [a, b] = view.getAllByRole("button");
    fireEvent.click(a!);
    act(() => {
      vi.advanceTimersByTime(CONFIRM_MS - 100);
    });
    fireEvent.click(b!);
    act(() => {
      vi.advanceTimersByTime(CONFIRM_MS - 100);
    });
    expect(b!.textContent).toBe("Confirm b");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(b!.textContent).toBe("B");
  });
});

describe("disclosures", () => {
  it("Disclosure is a native details: closed by default, open on request, toggled by the user", () => {
    const onToggle = vi.fn();
    const view = render(
      <>
        <Disclosure summary="Closed" data-closed="">
          <p>inside</p>
        </Disclosure>
        <Disclosure summary="Open" defaultOpen onToggle={onToggle}>
          <p>inside</p>
        </Disclosure>
      </>,
    );
    const [closed, open] = view.container.querySelectorAll("details");
    expect(closed!.open).toBe(false);
    expect(closed!.hasAttribute("data-closed")).toBe(true);
    expect(closed!.querySelector("summary")!.textContent).toBe("Closed");
    // The content stays mounted while closed.
    expect(closed!.querySelector("p")).not.toBeNull();
    expect(open!.open).toBe(true);
    open!.open = false;
    fireEvent(open!, new Event("toggle"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("About is collapsed, says About, and its body's text is exactly the note", () => {
    const view = render(
      <About attr="data-note">The longer explanation.</About>,
    );
    const details = view.container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("About");
    expect(view.container.querySelector("[data-note]")!.textContent).toBe(
      "The longer explanation.",
    );
  });

  it("useDisclosure gives the header aria-expanded and points it at the open content", () => {
    function Section() {
      const d = useDisclosure(false);
      return (
        <div>
          <button type="button" {...d.toggle}>
            Section
          </button>
          {d.open ? <div {...d.region}>body</div> : null}
        </div>
      );
    }
    const view = render(<Section />);
    const button = view.getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const id = button.getAttribute("aria-controls")!;
    expect(view.container.querySelector(`[id="${id}"]`)!.textContent).toBe(
      "body",
    );
  });
});

describe("status lines", () => {
  it("StatusLine carries its tone and renders nothing without text", () => {
    const view = render(
      <>
        <StatusLine tone="ok" attr="data-done">
          Saved.
        </StatusLine>
        <StatusLine tone="error">{null}</StatusLine>
      </>,
    );
    const lines = view.getAllByRole("status");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.getAttribute("data-tone")).toBe("ok");
    expect(lines[0]!.hasAttribute("data-done")).toBe(true);
    expect(lines[0]!.style.borderLeft).toContain(status.ok);
  });

  it("Refusal is an error line, or nothing", () => {
    const view = render(<Refusal text="Select two objects." />);
    expect(view.getByRole("status").getAttribute("data-tone")).toBe("error");
    view.rerender(<Refusal text={null} />);
    expect(view.queryByRole("status")).toBeNull();
  });
});

describe("useActionFeedback", () => {
  const fakeHost = () => {
    const warn = vi.fn();
    return {
      host: {
        log: { warn, info: vi.fn(), debug: vi.fn() },
      } as unknown as BundleHost,
      warn,
    };
  };

  function Harness(props: {
    host: BundleHost;
    work: (host: BundleHost) => Promise<unknown>;
    after: () => void;
  }) {
    const { refusal, run } = useActionFeedback(
      props.host,
      props.after,
      "test panel",
    );
    return (
      <div>
        <button
          type="button"
          onClick={() => void run(() => props.work(props.host))}
        >
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
          h.log.warn(
            "media.paged.draw.command.defineSymbol: nothing capturable in the selection — no-op",
          );
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(view.getByRole("status").textContent).toBe(
      "Nothing capturable in the selection.",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("shows a thrown error (logged under the panel's name), and nothing when the action succeeds", async () => {
    const { host, warn } = fakeHost();
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
    expect(view.getByRole("status").textContent).toBe(
      "The engine refused the batch.",
    );
    expect(warn).toHaveBeenCalledWith(
      "test panel: the engine refused the batch",
    );
    fail = false;
    await act(async () => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(view.queryByRole("status")).toBeNull();
  });
});

describe("named controls", () => {
  it("IconButton is named in words, and the glyph is hidden from the name", () => {
    const view = render(
      <IconButton label="Delete swatch" data-action="remove" onClick={() => {}}>
        ✕
      </IconButton>,
    );
    const button = view.getByRole("button", { name: "Delete swatch" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.title).toBe("Delete swatch");
    expect(button.textContent).toBe("✕");
    expect(button.querySelector('[aria-hidden="true"]')!.textContent).toBe("✕");
    expect(button.hasAttribute("data-action")).toBe(true);
  });

  it("Segment says whether it is on with aria-pressed and data-active", () => {
    const view = render(
      <div role="group">
        <Segment pressed>Paragraph</Segment>
        <Segment pressed={false}>Character</Segment>
      </div>,
    );
    const [on, off] = view.getAllByRole("button");
    expect(on!.getAttribute("aria-pressed")).toBe("true");
    expect(on!.getAttribute("data-active")).toBe("true");
    expect(off!.getAttribute("aria-pressed")).toBe("false");
    expect(off!.getAttribute("data-active")).toBe("false");
  });

  it("Tab is a tab that says whether it is selected", () => {
    const view = render(
      <div role="tablist">
        <Tab selected>Paragraph</Tab>
        <Tab selected={false}>Character</Tab>
      </div>,
    );
    const tabs = view.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(tabs[0]!.getAttribute("data-active")).toBe("true");
    expect(view.getByRole("tab", { selected: true }).textContent).toBe(
      "Paragraph",
    );
  });
});

describe("row labels", () => {
  function Field(props: { "aria-label"?: string }) {
    return <input {...useFieldName(props)} />;
  }

  it("a control without a name takes the row label's; one with a name keeps it", () => {
    const view = render(
      <div>
        <span id="size-label">Size</span>
        <LabelledBy id="size-label">
          <Field />
          <Field aria-label="Size unit" />
          <NamedAs name="Leading">
            <Field />
          </NamedAs>
          <NamedAs name="Ignored" fallback>
            <Field />
          </NamedAs>
        </LabelledBy>
        <NamedAs name="Tracking" fallback>
          <Field />
        </NamedAs>
        <Field />
      </div>,
    );
    const [inRow, named, inner, rowWins, fallback, outside] =
      view.getAllByRole("textbox");
    expect(inRow!.getAttribute("aria-labelledby")).toBe("size-label");
    expect(view.getAllByRole("textbox", { name: "Size" })).toEqual([
      inRow!,
      rowWins!,
    ]);
    expect(named!.hasAttribute("aria-labelledby")).toBe(false);
    expect(view.getByRole("textbox", { name: "Size unit" })).toBe(named!);
    // The nearest naming wins.
    expect(inner!.getAttribute("aria-label")).toBe("Leading");
    expect(inner!.hasAttribute("aria-labelledby")).toBe(false);
    // A fallback name yields to the row's; alone, it names the control.
    expect(rowWins!.getAttribute("aria-labelledby")).toBe("size-label");
    expect(fallback!.getAttribute("aria-label")).toBe("Tracking");
    expect(outside!.hasAttribute("aria-labelledby")).toBe(false);
    expect(outside!.hasAttribute("aria-label")).toBe(false);
  });

  it("the native fields take their row's name and keep everything else", () => {
    const view = render(
      <div>
        <span id="row">Style</span>
        <LabelledBy id="row">
          <FieldSelect data-picker="" defaultValue="b">
            <option value="a">A</option>
            <option value="b">B</option>
          </FieldSelect>
          <FieldInput placeholder="Name" />
          <FieldTextarea aria-label="Source" />
        </LabelledBy>
      </div>,
    );
    const select = view.getByRole("combobox", { name: "Style" });
    expect((select as HTMLSelectElement).value).toBe("b");
    expect(select.hasAttribute("data-picker")).toBe(true);
    expect(view.getAllByRole("textbox", { name: "Style" })).toHaveLength(1);
    expect(view.getByRole("textbox", { name: "Source" }).tagName).toBe(
      "TEXTAREA",
    );
  });
});
