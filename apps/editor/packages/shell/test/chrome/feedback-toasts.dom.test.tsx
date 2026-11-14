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
// only behind Details (UXI-ASY-011), and Close.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { FeedbackToasts } from "../../src/chrome/FeedbackToasts";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";
import { operationFeedbackOf } from "../../src/state/operation-feedback";

afterEach(() => cleanup());

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
    expect(toast.getAttribute("role")).toBe("alert");
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
    expect(toast.getAttribute("role")).toBe("status");
    fireEvent.click(toast.querySelector("[data-feedback-close]")!);
    expect(view.container.querySelector("[data-feedback-toast]")).toBeNull();
  });
});
