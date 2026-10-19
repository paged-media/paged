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

// Cell Styles (paged.cell-styles): the document's cell styles, managed through the
// typed core commands (support/table-style-suite.tsx).

import { afterEach } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CellStylesPanel } from "../../src/panels/cell-styles-panel";
import { unmountAll } from "./harness";
import { tableStyleSuite } from "./support/table-style-suite";

afterEach(unmountAll);

tableStyleSuite({
  panel: CellStylesPanel,
  id: "paged.cell-styles",
  family: "cell",
  collection: "cellStyles",
  createOp: "createCellStyle",
  deleteOp: "deleteCellStyle",
  newName: "New cell style",
  emptyHook: "data-empty-cell-styles",
  styleOf: (s) => s.cellStyle,
  tag: () => covers("panel:paged.cell-styles"),
  tagCreate: () => covers("command:paged.core.createCellStyle"),
  tagDelete: () => covers("command:paged.core.deleteCellStyle"),
});
