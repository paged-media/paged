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

// ORACLE PROBE -- 9-SLICE SCALING of a symbol instance.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/nine-slice.jsx \
//     packages/draw-bundle/test/fixtures/oracle/nine-slice.illustrator.json
//
// The thing under test on our side is draw-geometry's `nineSlicePoint`
// (`src/nine-slice.ts`), the mapping the engine's renderer applies to a
// scaled instance with guides (engine ADR 1039): corners keep their size,
// edges stretch along their axis, the centre in both. Replayed by
// `packages/draw-bundle/test/oracle/nine-slice.spec.ts`.
//
// HOW ILLUSTRATOR IS ASKED. `Symbols.addWith9SliceScaling(art)` makes a
// symbol with guides enabled; `Document.setSymbol9SliceGrid(index, left,
// top, right, bottom)` places the CENTRE slice. Measured (2026-10-29,
// 30.1): `getSymbol9SliceGrid` answers [0, 0, 0, 0] for a new symbol, and
// the rectangle is read with its ORIGIN AT THE ART'S BOTTOM-LEFT, Y UP --
// so insets [l, t, r, b] of a w x h box are (l, h - t, w - r, b). A grid
// whose rectangle misses the art leaves the instance unsliced, silently. A
// `SymbolItem` is placed, `resize(sx %, sy %)` about its centre, and
// `breakLink()` expands it WITH the slicing applied; the expanded art lands
// in a SUBLAYER named after the symbol, which the probe moves back onto
// the layer (the library's walk reads one layer level).
//
// The art is a chamfered box (10 pt chamfers) of 100 x 60 pt, so a corner
// that keeps its size shows as a chamfer that stays 10 pt.

(function () {
  var X0 = 200, Y0 = 200, W = 100, H = 60, K = 10;
  var oct = PagedProbe.polygon(
    [
      [X0 + K, Y0], [X0 + W - K, Y0], [X0 + W, Y0 + K], [X0 + W, Y0 + H - K],
      [X0 + W - K, Y0 + H], [X0 + K, Y0 + H], [X0, Y0 + H - K], [X0, Y0 + K]
    ],
    true
  );
  // [insets [l, t, r, b], sx, sy]
  var RUNS = [
    [[20, 15, 20, 15], 2, 1],
    [[20, 15, 20, 15], 1, 2],
    [[20, 15, 20, 15], 2.5, 1.5],
    [[20, 15, 20, 15], 0.8, 0.8],
    [[10, 10, 30, 20], 2, 2],
    [[10, 10, 30, 20], 3, 1.25]
  ];
  var cases = [];
  var i, r;
  for (i = 0; i < RUNS.length; i++) {
    r = RUNS[i];
    cases.push({
      id: "slice-" + i,
      input: { paths: [oct] },
      parameters: {
        box: [X0, Y0, X0 + W, Y0 + H],
        insets: r[0],
        sx: r[1],
        sy: r[2]
      }
    });
  }

  return PagedProbe.run({
    probe: "nine-slice",
    operation:
      "Symbols.addWith9SliceScaling(art); Document.setSymbol9SliceGrid(i, l, h - t, w - r, b); " +
      "SymbolItems.add(symbol).resize(sx %, sy %); SymbolItem.breakLink()",
    cases: cases,
    apply: function (doc, items, p) {
      var sym = doc.symbols.addWith9SliceScaling(items[0]);
      var idx = doc.symbols.length - 1;
      var n = p.insets;
      doc.setSymbol9SliceGrid(idx, n[0], H - n[1], W - n[2], n[3]);
      var g = doc.getSymbol9SliceGrid(idx);
      p.grid_read_back = [g[0], g[1], g[2], g[3]];
      items[0].remove();
      var inst = doc.symbolItems.add(sym);
      inst.resize(p.sx * 100, p.sy * 100);
      inst.breakLink();
      if (doc.pathItems.length !== 1) {
        throw new Error("expected 1 path after breakLink, found " + doc.pathItems.length);
      }
      var path = doc.pathItems[0];
      var sub = path.parent;
      if (sub.typename === "Layer" && sub !== doc.layers[0]) {
        while (sub.pageItems.length > 0) sub.pageItems[0].move(doc.layers[0], ElementPlacement.PLACEATEND);
        sub.remove();
      }
      sym.remove();
    }
  });
})();
