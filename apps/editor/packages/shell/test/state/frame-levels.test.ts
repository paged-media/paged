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

// Editor ADR 1215 with extensions ADR 1108 — the Frame / Content / Edit
// levels a frame offers, and what the Edit level is called: the module's
// verb when it gives one ("Edit cells"), else its context's name.

import { describe, expect, test } from "bun:test";

import { frameLevels } from "../../src/state/frame-content";

describe("frame levels", () => {
  test("a module that names its Edit level reads as its verb", () => {
    const levels = frameLevels({
      hasImage: false,
      imageEditor: null,
      owner: { type: "sheet", label: "Spreadsheet", editLabel: "Edit cells" },
    });
    expect(levels.map((l) => [l.id, l.label, l.contextType])).toEqual([
      ["frame", "Frame", null],
      ["edit", "Edit cells", "sheet"],
    ]);
  });

  test("without a verb the Edit level reads as the context's name, then as its type", () => {
    expect(
      frameLevels({
        hasImage: false,
        imageEditor: null,
        owner: { type: "webFrame", label: "Web frame", editLabel: "  " },
      })[1]?.label,
    ).toBe("Web frame");
    expect(
      frameLevels({
        hasImage: false,
        imageEditor: null,
        owner: { type: "vectorGraphic" },
      })[1]?.label,
    ).toBe("Vector graphic");
  });

  test("a picture frame offers Content, then Edit image", () => {
    const levels = frameLevels({
      hasImage: true,
      imageEditor: { type: "rasterImage", label: "Image" },
      owner: null,
    });
    expect(levels.map((l) => l.label)).toEqual([
      "Frame",
      "Content",
      "Edit image",
    ]);
  });
});
