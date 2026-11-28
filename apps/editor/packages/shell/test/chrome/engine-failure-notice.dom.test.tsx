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

// The engine-failure notice (UXI-ASY-005) and whose page it is: an editor
// that is the page offers Reload; an embedded one never reloads its host's
// page: it offers the host's restart when the host gave one, and no
// button otherwise.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { CanvasClient } from "@paged-media/client";

import {
  EngineFailureNotice,
  engineRecovery,
  setEngineRestart,
} from "../../src/chrome/EngineFailureNotice";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import { EditorRoot } from "../../src/state/editor-root";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";

afterEach(() => cleanup());

/** A client whose engine can be made to stop. */
function failingClient() {
  let failure: Error | null = null;
  const listeners = new Set<(e: Error) => void>();
  return {
    client: {
      get failure() {
        return failure;
      },
      onFatal(l: (e: Error) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as CanvasClient,
    stop() {
      failure = new Error("the worker stopped");
      for (const l of [...listeners]) l(failure);
    },
  };
}

function mount(ownsPage: boolean, scope: EditorScope = createEditorScope()) {
  const engine = failingClient();
  const view = render(
    <EditorScopeProvider scope={scope}>
      <EditorRoot ownsPage={ownsPage}>
        <CanvasClientProvider client={engine.client}>
          <EngineFailureNotice />
        </CanvasClientProvider>
      </EditorRoot>
    </EditorScopeProvider>,
  );
  const notice = () =>
    view.container.querySelector<HTMLElement>("[data-engine-failure]");
  return { scope, engine, notice };
}

describe("the engine-failure notice", () => {
  test("an editor that is the page offers Reload, which reloads the page", () => {
    const { scope, engine, notice } = mount(true);
    expect(notice()).toBeNull();
    act(() => engine.stop());
    const button = notice()!.querySelector("button")!;
    expect(button.getAttribute("data-engine-recovery")).toBe("reload");
    expect(button.textContent).toBe("Reload");
    expect(notice()!.textContent).toContain("reload to get it back");
    let reloaded = 0;
    engineRecovery(scope, () => void reloaded++)!.run();
    expect(reloaded).toBe(1);
  });

  test("an embedded editor offers the host's restart and never a reload", () => {
    const scope = createEditorScope();
    let restarted = 0;
    setEngineRestart(scope, () => void restarted++);
    const { engine, notice } = mount(false, scope);
    act(() => engine.stop());
    const button = notice()!.querySelector("button")!;
    expect(button.getAttribute("data-engine-recovery")).toBe("restart");
    expect(button.textContent).toBe("Restart");
    expect(notice()!.textContent).toContain("Restart the editor to go on.");
    let reloaded = 0;
    expect(engineRecovery(scope, () => void reloaded++)!.kind).toBe("restart");
    act(() => {
      fireEvent.click(button);
    });
    expect(restarted).toBe(1);
    expect(reloaded).toBe(0);
  });

  test("an embedded editor whose host gave no restart has no button", () => {
    const { scope, engine, notice } = mount(false);
    act(() => engine.stop());
    expect(notice()).not.toBeNull();
    expect(notice()!.querySelector("button")).toBeNull();
    expect(notice()!.textContent).toContain(
      "Close the editor and open it again to go on.",
    );
    expect(engineRecovery(scope, () => undefined)).toBeNull();
    // A restart handed over later shows.
    act(() => setEngineRestart(scope, () => undefined));
    expect(
      notice()!.querySelector("button")!.getAttribute("data-engine-recovery"),
    ).toBe("restart");
  });
});
