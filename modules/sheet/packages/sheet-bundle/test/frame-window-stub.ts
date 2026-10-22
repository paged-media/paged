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

// A frame-window answer for engine fakes: every column 44.2575 pt and every
// row 15 pt (the xlsx defaults), whole tracks only, nothing hidden or frozen.
// The real windowing is Rust's (`sheet_grid::frame_window`), tested there.

import type { FrameWindow, FrameWindowSpec } from "../../sheet-host-model/src";

const COL_PT = 44.2575;
const ROW_PT = 15;

export function stubFrameWindow(
  _sheet: number,
  spec: FrameWindowSpec,
): FrameWindow {
  const nCols = Math.max(1, Math.floor(spec.widthPt / COL_PT));
  const nRows = Math.max(1, Math.floor(spec.heightPt / ROW_PT));
  const cols = Array.from({ length: nCols }, (_, i) => spec.leftCol + i);
  const rows = Array.from({ length: nRows }, (_, i) => spec.topRow + i);
  return {
    rows,
    cols,
    rowHeightsPt: rows.map(() => ROW_PT),
    colWidthsPt: cols.map(() => COL_PT),
    frozenRows: 0,
    frozenCols: 0,
    widthPt: nCols * COL_PT,
    heightPt: nRows * ROW_PT,
    partialRow: spec.heightPt > nRows * ROW_PT ? spec.topRow + nRows : null,
    partialCol: spec.widthPt > nCols * COL_PT ? spec.leftCol + nCols : null,
  };
}
