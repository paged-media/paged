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

// Contained errors (chrome/ContainedError.tsx): a panel that throws shows
// the failure in its own place with "Try again", a dialog that throws
// closes and says so through the feedback channel, and in both cases what
// stands beside them keeps working.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useState } from "react";

import {
  DialogErrorBoundary,
  PanelErrorBoundary,
} from "../../src/chrome/ContainedError";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";
import { operationFeedbackOf } from "../../src/state/operation-feedback";

let quiet: ReturnType<typeof spyOn>;
beforeEach(() => {
  // React and the boundary both log the caught error.
  quiet = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  quiet.mockRestore();
  cleanup();
});

/** A panel that throws while `broken.now` holds. */
const broken = { now: true };
function ThrowingPanel() {
  if (broken.now) throw new Error("swatch 7 has no colour space");
  return <div data-testid="panel-body">Swatches</div>;
}

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button data-testid="neighbour" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

describe("a panel that throws", () => {
  test("shows a contained error with a retry; its neighbours keep working", () => {
    broken.now = true;
    const scope = createEditorScope();
    const view = render(
      <EditorScopeProvider scope={scope}>
        <PanelErrorBoundary id="paged.swatches" name="Swatches">
          <ThrowingPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary id="paged.layers" name="Layers">
          <Counter />
        </PanelErrorBoundary>
      </EditorScopeProvider>,
    );
    const error = view.container.querySelector<HTMLElement>(
      '[data-panel-error="paged.swatches"]',
    )!;
    expect(error).not.toBeNull();
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Swatches stopped working.");
    expect(error.textContent).toContain(
      "The rest of the editor keeps working.",
    );
    // The error's own words are there, behind Details.
    expect(error.querySelector("details pre")!.textContent).toBe(
      "swatch 7 has no colour space",
    );
    expect(
      view.container.querySelector("[data-panel-error='paged.layers']"),
    ).toBeNull();

    // The neighbour panel is alive.
    const neighbour = view.getByTestId("neighbour");
    act(() => {
      fireEvent.click(neighbour);
    });
    expect(neighbour.textContent).toBe("1");

    // Try again while it still throws: the error stays, contained.
    act(() => {
      fireEvent.click(error.querySelector("[data-panel-error-retry]")!);
    });
    expect(
      view.container.querySelector('[data-panel-error="paged.swatches"]'),
    ).not.toBeNull();

    // Try again once the cause is gone: the panel is back.
    broken.now = false;
    act(() => {
      fireEvent.click(
        view.container.querySelector("[data-panel-error-retry]")!,
      );
    });
    expect(view.container.querySelector("[data-panel-error]")).toBeNull();
    expect(view.getByTestId("panel-body").textContent).toBe("Swatches");
    expect(view.getByTestId("neighbour").textContent).toBe("1");
  });
});

describe("a dialog that throws", () => {
  test("closes, reports through the feedback channel, and Try again shows it anew", () => {
    broken.now = true;
    const scope = createEditorScope();
    const feedback = operationFeedbackOf(scope);
    const view = render(
      <EditorScopeProvider scope={scope}>
        <DialogErrorBoundary id="export-pdf" name="the export dialog">
          <ThrowingPanel />
        </DialogErrorBoundary>
        <Counter />
      </EditorScopeProvider>,
    );
    // Nothing of the dialog is left, and the rest renders.
    expect(view.queryByTestId("panel-body")).toBeNull();
    expect(view.getByTestId("neighbour").textContent).toBe("0");
    const snap = feedback.snapshot();
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0]!.text.headline).toBe(
      "Could not show the export dialog: an error occurred in it. The rest of the editor keeps working.",
    );
    expect(snap.toasts[0]!.report.detail).toBe("swatch 7 has no colour space");
    expect(snap.problems).toHaveLength(1);

    broken.now = false;
    act(() => {
      feedback.runAction(snap.toasts[0]!.report.remedy!);
    });
    expect(view.getByTestId("panel-body").textContent).toBe("Swatches");
    expect(feedback.snapshot().problems).toHaveLength(0);
  });
});
