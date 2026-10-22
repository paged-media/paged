// sheet ADR 510, P2 — through the real engine: the live grid scene a frame
// shows carries the workbook's styles (the SAME table the page lowering
// builds), merges with their anchor text, and the frozen band pinned while
// the body scrolls.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { bootEngine } from "../src/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "bin", "sheet_js_bg.wasm"));

describe.skipIf(!built)(
  "grid scene over the real engine [sheet.grid.inframe]",
  () => {
    it("styles equal the page lowering; merges and the frozen band ride the scene", async () => {
      const e = await bootEngine();
      e.setCell(0, 0, 0, "Region");
      e.setCell(0, 0, 1, "Total");
      for (let r = 1; r < 60; r += 1) {
        e.setCell(0, r, 0, `R${r}`);
        e.setCell(0, r, 1, String(r * 10));
      }
      e.setCell(0, 2, 2, "merged title");
      e.setStyle!(0, "A1:B1", { bold: true, fill: "#FFCC00" });
      e.setStyle!(0, "B3", { italic: true, wrap: true, vAlign: "top" });
      e.merge!(0, "C3:D4");
      e.setFreeze!(0, 1, 0);

      // The window from the sheet's top: rows 0.. and columns 0.., whole tracks.
      const top = e.getGridScene(0, 0, 0, 200, 90, {});
      const vp = top.viewport;
      expect(vp.frozenRows).toBe(1);
      expect(vp.rowIndices?.[0]).toBe(0);
      const page = e.getRangePage!(0, "A1:D6", { includeGridRules: true });
      expect(top.styles).toEqual(page.styles);
      for (const cell of top.cells) {
        const pc = page.rows[cell.row].cells[cell.col];
        expect(cell.styleKey).toBe(pc.styleKey);
        expect(cell.text).toBe(pc.text);
      }
      const b3 = top.cells.find((c) => c.row === 2 && c.col === 1);
      expect(b3?.wrap).toBe(true);
      expect(b3?.vAlign).toBe("top");
      const m = top.merges?.find((g) => g.row === 2 && g.col === 2);
      expect(m?.text).toBe("merged title");
      expect(m?.colSpan).toBe(2);
      expect(top.cells.some((c) => c.row === 2 && c.col === 2)).toBe(false);

      // Scrolled to row 40: the header row stays pinned above the body.
      const scrolled = e.getGridScene(0, 40, 0, 200, 90, {});
      expect(scrolled.viewport.rowIndices?.slice(0, 3)).toEqual([0, 40, 41]);
      expect(scrolled.viewport.firstRow).toBe(40);
      expect(scrolled.freeze?.frozenHeightPt).toBe(
        scrolled.viewport.yOffsets[1],
      );
      const header = scrolled.cells.find((c) => c.row === 0 && c.col === 0);
      expect(header?.text).toBe("Region");
      expect(scrolled.styles[header!.styleKey ?? 0].bold).toBe(true);
      e.dispose();
    });
  },
);
