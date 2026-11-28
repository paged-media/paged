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

// The one toast channel (editor ADR "Operation feedback"): the worded
// failure with its remedy, a count instead of a storm, technical detail
// only behind Details (UXI-ASY-011), and Close. Its time stands still
// under the pointer and under focus, an error stays until it is closed,
// and two standing live regions announce what arrives.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "bun:test";

import { FeedbackToasts } from "../../src/chrome/FeedbackToasts";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";
import { operationFeedbackOf } from "../../src/state/operation-feedback";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const toastsIn = (root: Element) => [
  ...root.querySelectorAll<HTMLElement>("[data-feedback-toast]"),
];
const announcer = (root: Element, kind: "polite" | "assertive") =>
  root.querySelector<HTMLElement>(`[data-feedback-announcer="${kind}"]`)!;
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

function mount() {
  const scope = createEditorScope();
  const view = render(
    <EditorScopeProvider scope={scope}>
      <FeedbackToasts />
    </EditorScopeProvider>,
  );
  return { scope, view, feedback: operationFeedbackOf(scope) };
}

describe("FeedbackToasts", () => {
  test("a failure shows action, reason, change and remedy; Details hides the engine's words", () => {
    const { view, feedback } = mount();
    const ran: string[] = [];
    feedback.setCommandRunner((id) => ran.push(id));
    act(() => {
      feedback.report({
        action: "paste",
        outcome: "blocked",
        reason: "the clipboard holds nothing to paste",
        document: "unchanged",
        remedy: { label: "Copy something first", command: "paged.edit.copy" },
        detail: "ClipboardError: empty",
        correlationId: "41",
      });
    });
    const toast = view.container.querySelector("[data-feedback-toast]")!;
    expect(toast.getAttribute("data-outcome")).toBe("blocked");
    // The toast itself is no live region; the assertive announcer says it.
    expect(toast.getAttribute("role")).toBe("group");
    expect(announcer(view.container, "assertive").textContent).toBe(
      "Could not paste: the clipboard holds nothing to paste. Nothing changed. Copy something first.",
    );
    expect(announcer(view.container, "polite").textContent).toBe("");
    expect(toast.querySelector("[data-feedback-headline]")!.textContent).toBe(
      "Could not paste: the clipboard holds nothing to paste.",
    );
    expect(toast.querySelector("[data-feedback-change]")!.textContent).toBe(
      "Nothing changed.",
    );
    expect(toast.textContent).not.toContain("ClipboardError");
    fireEvent.click(toast.querySelector("[data-feedback-details-toggle]")!);
    expect(
      view.container.querySelector("[data-feedback-detail]")!.textContent,
    ).toContain("ClipboardError: empty");
    fireEvent.click(
      view.container.querySelector('[data-feedback-action="paged.edit.copy"]')!,
    );
    expect(ran).toEqual(["paged.edit.copy"]);
    // Running the remedy closes the toast.
    expect(view.container.querySelector("[data-feedback-toast]")).toBeNull();
  });

  test("the same failure again counts instead of stacking", () => {
    const { view, feedback } = mount();
    act(() => {
      for (let i = 0; i < 4; i++)
        feedback.report({ action: "move 1 object", outcome: "blocked" });
    });
    const toasts = view.container.querySelectorAll("[data-feedback-toast]");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.getAttribute("data-feedback-count")).toBe("4");
    expect(
      view.container.querySelector("[data-feedback-repeat]")!.textContent,
    ).toBe("4×");
  });

  test("a quiet success shows nothing; a prominent one is a status; Close removes it", () => {
    const { view, feedback } = mount();
    act(() => {
      feedback.report({ action: "nudge", outcome: "success" });
    });
    expect(view.container.querySelector("[data-feedback-toast]")).toBeNull();
    act(() => {
      feedback.report({
        action: "export",
        outcome: "success",
        title: "Exported Annual.pdf · 12 pages",
        prominent: true,
      });
    });
    const toast = view.container.querySelector("[data-feedback-toast]")!;
    expect(toast.getAttribute("role")).toBe("group");
    expect(announcer(view.container, "polite").textContent).toBe(
      "Exported Annual.pdf · 12 pages",
    );
    expect(announcer(view.container, "assertive").textContent).toBe("");
    fireEvent.click(toast.querySelector("[data-feedback-close]")!);
    expect(view.container.querySelector("[data-feedback-toast]")).toBeNull();
  });

  test("the live regions stand before any toast: a polite status and an assertive alert", () => {
    const { view, feedback } = mount();
    // In the DOM with nothing to say, so what arrives is an addition.
    const polite = announcer(view.container, "polite");
    const assertive = announcer(view.container, "assertive");
    expect(polite.getAttribute("role")).toBe("status");
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(assertive.getAttribute("role")).toBe("alert");
    expect(assertive.getAttribute("aria-live")).toBe("assertive");
    expect(polite.textContent).toBe("");
    expect(assertive.textContent).toBe("");
    expect(
      view.container
        .querySelector("[data-feedback-toasts]")!
        .getAttribute("aria-label"),
    ).toBe("Notifications");

    act(() => {
      feedback.report({ action: "save", outcome: "success", prominent: true });
      feedback.report({
        action: "export",
        outcome: "recoverable-failure",
        reason: "the disk is full",
      });
    });
    // The same elements took the words: nothing was remounted.
    expect(announcer(view.container, "polite")).toBe(polite);
    expect(announcer(view.container, "assertive")).toBe(assertive);
    expect(polite.textContent).toBe("Save: done.");
    expect(assertive.textContent).toBe("Could not export: the disk is full.");
    // No toast is a live region of its own (it would be said twice).
    for (const t of toastsIn(view.container)) {
      expect(t.getAttribute("role")).toBe("group");
      expect(t.hasAttribute("aria-live")).toBe(false);
    }
  });

  test("a toast's time stands still under the pointer and runs on with what was left", () => {
    vi.useFakeTimers();
    const { view, feedback } = mount();
    act(() => {
      feedback.report({ action: "save", outcome: "success", prominent: true });
    });
    const toast = toastsIn(view.container)[0]!;
    advance(3000);
    fireEvent.pointerEnter(toast);
    expect(toast.hasAttribute("data-feedback-held")).toBe(true);
    // Far past its four seconds: still there.
    advance(60_000);
    expect(toastsIn(view.container)).toHaveLength(1);
    fireEvent.pointerLeave(toast);
    expect(toast.hasAttribute("data-feedback-held")).toBe(false);
    // One second was left.
    advance(900);
    expect(toastsIn(view.container)).toHaveLength(1);
    advance(200);
    expect(toastsIn(view.container)).toHaveLength(0);
  });

  test("a toast's time stands still while focus is inside it and runs on after", () => {
    vi.useFakeTimers();
    const { view, feedback } = mount();
    act(() => {
      feedback.report({
        action: "export",
        outcome: "success",
        prominent: true,
        detail: "12 pages",
      });
    });
    const toast = toastsIn(view.container)[0]!;
    const details = toast.querySelector<HTMLElement>(
      "[data-feedback-details-toggle]",
    )!;
    const close = toast.querySelector<HTMLElement>("[data-feedback-close]")!;
    advance(1000);
    act(() => details.focus());
    expect(toast.hasAttribute("data-feedback-held")).toBe(true);
    advance(60_000);
    expect(toastsIn(view.container)).toHaveLength(1);
    // Focus moving inside the toast keeps it held.
    act(() => close.focus());
    expect(toast.hasAttribute("data-feedback-held")).toBe(true);
    advance(60_000);
    expect(toastsIn(view.container)).toHaveLength(1);
    act(() => close.blur());
    expect(toast.hasAttribute("data-feedback-held")).toBe(false);
    // Three of its four seconds were left.
    advance(2900);
    expect(toastsIn(view.container)).toHaveLength(1);
    advance(200);
    expect(toastsIn(view.container)).toHaveLength(0);
  });

  test("an error stays past every timeout and leaves on its labelled Close", () => {
    vi.useFakeTimers();
    const { view, feedback } = mount();
    act(() => {
      feedback.report({
        action: "export",
        outcome: "recoverable-failure",
        reason: "the disk is full",
      });
      feedback.report({ action: "save", outcome: "success", prominent: true });
    });
    expect(toastsIn(view.container)).toHaveLength(2);
    advance(10 * 60_000);
    // The success went; the error is still there.
    const left = toastsIn(view.container);
    expect(left).toHaveLength(1);
    expect(left[0]!.getAttribute("data-outcome")).toBe("recoverable-failure");
    const close = left[0]!.querySelector<HTMLButtonElement>(
      "[data-feedback-close]",
    )!;
    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("aria-label")).toBe("Close");
    fireEvent.click(close);
    expect(toastsIn(view.container)).toHaveLength(0);
    expect(announcer(view.container, "assertive").textContent).toBe("");
  });
});
