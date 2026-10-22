// The calculation model through the facade over the REAL engine (sheet
// ADR 513): manual calculation, the calc settings, a spilling range and an
// unknown function. Same dual gate as engine-real.spec.ts: skipped without
// the artifact, FAILS under REQUIRE_REAL_ENGINE=1.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import { bootEmptyEngine } from "../src/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "bin", "sheet_js_bg.wasm");
const built = existsSync(WASM);

if (process.env.REQUIRE_REAL_ENGINE === "1" && !built) {
  describe("calc model (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

describe.skipIf(!built)(
  "calc model through the facade [sheet.calc.model]",
  () => {
    it("manual calculation waits for Calculate Now", async () => {
      const e = await bootEmptyEngine();
      e.setCell(0, 0, 0, "1");
      e.setCell(0, 0, 1, "=A1*2");
      e.setCalcMode!("manual");
      e.setCell(0, 0, 0, "5");
      expect(e.getCellDisplay(0, 0, 1)).toBe("2");
      expect(e.isCalcPending!()).toBe(true);
      expect(e.calcSettings!().calcMode).toBe("manual");
      e.calculateSheet!(0);
      expect(e.getCellDisplay(0, 0, 1)).toBe("10");
      e.setCell(0, 0, 0, "7");
      e.calculateNow!();
      expect(e.getCellDisplay(0, 0, 1)).toBe("14");
      expect(e.isCalcPending!()).toBe(false);
      e.setCalcMode!("auto");
      e.setFullPrecision!(false);
      expect(e.calcSettings!().fullPrecision).toBe(false);
      e.dispose();
    });

    it("a typed range spills and an unknown function is #NAME?", async () => {
      const e = await bootEmptyEngine();
      e.setCell(0, 0, 0, "1");
      e.setCell(0, 1, 0, "2");
      e.setCell(0, 2, 0, "3");
      e.setCell(0, 0, 1, "=A1:A3*2");
      expect([0, 1, 2].map((r) => e.getCellDisplay(0, r, 1))).toEqual([
        "2",
        "4",
        "6",
      ]);
      e.setCell(0, 0, 2, "=NoSuchFn(1)");
      expect(e.getCellDisplay(0, 0, 2)).toBe("#NAME?");
      expect(e.getCellInput(0, 0, 2)).toBe("=NoSuchFn(1)");
      e.dispose();
    });
  },
);
