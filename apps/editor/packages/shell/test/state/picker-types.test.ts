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

// File ▸ Open's native picker (UX audit F-10, editor ADR 1205): the
// entry it shows first is everything the editor opens; a save writes back
// only over the formats it can.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { pickerTypes, writesBackTo } from "../../src/state/picker-types";

const labels = { everything: "All", documents: "Paged and IDML" };

describe("pickerTypes", () => {
  test("F-10: the first entry holds every importer's extensions beside .paged and .idml", () => {
    covers("command:paged.file.openIdml");
    const types = pickerTypes(
      [
        {
          title: "Word",
          extensions: [".docx"],
          mimeTypes: [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ],
        },
        { title: "Spreadsheet", extensions: [".XLSX", ".csv"] },
        { title: "Photoshop", extensions: [".psd"] },
      ],
      labels,
    );
    const [all, documents, ...own] = types;
    expect(all?.description).toBe("All");
    expect(Object.values(all!.accept).flat().sort()).toEqual(
      [".csv", ".docx", ".idml", ".paged", ".psd", ".xlsx"].sort(),
    );
    expect(documents?.accept).toEqual({
      "application/x-paged+zip": [".paged"],
      "application/vnd.adobe.indesign-idml-package": [".idml"],
    });
    expect(own.map((t) => t.description)).toEqual([
      "Word",
      "Spreadsheet",
      "Photoshop",
    ]);
    // An importer with no MIME type is listed under a generic one.
    expect(own[1]?.accept).toEqual({
      "application/octet-stream": [".xlsx", ".csv"],
    });
  });

  test("a malformed extension is left out rather than failing the picker", () => {
    const types = pickerTypes(
      [{ title: "Odd", extensions: ["noDot", ".a/b"] }],
      labels,
    );
    expect(types.map((t) => t.description)).toEqual(["All", "Paged and IDML"]);
  });
});

describe("writesBackTo", () => {
  test("a save writes back over .paged and .idml only", () => {
    expect(writesBackTo("Annual.paged")).toBe(true);
    expect(writesBackTo("Annual.IDML")).toBe(true);
    expect(writesBackTo("Letter.docx")).toBe(false);
    expect(writesBackTo("Budget.xlsx")).toBe(false);
  });
});
