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

// The drop's ghost label (editor ADR 1205, UXI-DND-002, UX audit F-40):
// what releasing will do, beside the pointer; the frame that takes the
// picture outlined; a refusal with its reason.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  DropIntentOverlay,
  dropIntentDrag,
} from "../../src/overlays/drop-intent-overlay";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";

afterEach(() => cleanup());

function mount() {
  const scope = createEditorScope();
  render(
    <EditorScopeProvider scope={scope}>
      <DropIntentOverlay />
    </EditorScopeProvider>,
  );
  return dropIntentDrag(scope);
}

const label = () =>
  document.body.querySelector<HTMLElement>("[data-drop-intent]");

describe("the drop intent overlay", () => {
  test("nothing while nothing is dragged", () => {
    mount();
    expect(label()).toBeNull();
  });

  test("the label at the pointer, and the frame that takes the picture", () => {
    const drag = mount();
    act(() =>
      drag.set({
        intent: {
          intent: "place-in-frame",
          frame: { kind: "rectangle", id: "r1" },
          label: "Place photo.png in this frame",
          reason: null,
          provisional: false,
        },
        clientX: 100,
        clientY: 50,
        frame: { left: 80, top: 30, width: 60, height: 40 },
      }),
    );
    expect(label()?.dataset.dropIntent).toBe("place-in-frame");
    expect(label()?.textContent).toBe("Place photo.png in this frame");
    expect(label()?.style.left).toBe("116px");
    const frame = document.body.querySelector<HTMLElement>(
      "[data-drop-target-frame]",
    );
    expect(frame?.style.width).toBe("60px");
    act(() => drag.set(null));
    expect(label()).toBeNull();
  });

  test("a refusal says why, and outlines nothing", () => {
    const drag = mount();
    act(() =>
      drag.set({
        intent: {
          intent: "reject",
          label: "Paged cannot open .txt files",
          reason: "It opens Paged and InDesign (IDML) documents.",
          provisional: false,
        },
        clientX: 10,
        clientY: 10,
        frame: { left: 0, top: 0, width: 5, height: 5 },
      }),
    );
    expect(label()?.dataset.dropIntent).toBe("reject");
    expect(document.body.querySelector("[data-drop-reason]")?.textContent).toBe(
      "It opens Paged and InDesign (IDML) documents.",
    );
    expect(document.body.querySelector("[data-drop-target-frame]")).toBeNull();
  });
});
