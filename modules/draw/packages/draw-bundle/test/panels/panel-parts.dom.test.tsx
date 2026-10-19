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

// The pieces of the draw panels that are draw's own: the intro line and
// the labels. The shared ones (the confirm step, the refusal line, the
// action feedback, `humanize`) are tested in @paged-media/panel-kit.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "bun:test";

import { PanelIntro, elementKindLabel } from "../../src/panels/panel-parts";

afterEach(cleanup);

describe("PanelIntro", () => {
  it("is one sentence carrying the panel's test attribute", () => {
    const view = render(
      <PanelIntro summary="Blend two objects." attr="data-draw-x-intro" />,
    );
    const intro = view.container.querySelector("[data-draw-x-intro]")!;
    expect(intro.tagName).toBe("P");
    expect(intro.textContent).toBe("Blend two objects.");
  });
});

describe("labels", () => {
  it("elementKindLabel names a selected element's kind", () => {
    expect(elementKindLabel({ kind: "polygon", id: "a" })).toBe("path");
    expect(elementKindLabel({ kind: "graphicLine", id: "b" })).toBe("line");
    expect(elementKindLabel({ kind: "textFrame", id: "c" })).toBe("text frame");
  });
});
