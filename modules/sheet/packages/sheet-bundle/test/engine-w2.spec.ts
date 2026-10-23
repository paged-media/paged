// The W2 engine doors through the camelCase facade over the REAL wasm
// (sheet ADR 517): outline and visibility, protection, tables, sort and
// filter, data validation, what-if. Skips when the artifact is not built
// (REQUIRE_REAL_ENGINE=1 in CI makes engine-real.spec fail instead).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { wrapEngine, type SheetEngine } from "../src/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin");
const WASM = join(BIN, "sheet_js_bg.wasm");
const built = existsSync(WASM);

async function engine(): Promise<SheetEngine> {
  const glue = await import(/* @vite-ignore */ join(BIN, "sheet_js.js"));
  glue.initSync({ module: readFileSync(WASM) });
  return wrapEngine(new glue.SheetEngine());
}

describe.skipIf(!built)("W2 engine doors (real wasm)", () => {
  it("groups, collapses and hides through the facade", async () => {
    const e = await engine();
    for (let r = 0; r < 6; r++) e.setCell(0, r, 0, String(r + 1));
    e.group!(0, "rows", 1, 3);
    e.setGroupCollapsed!(0, "rows", 2, true);
    const o = e.outline!(0);
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]!.collapsed).toBe(true);
    expect(o.hiddenRows).toEqual([1, 2, 3]);
    e.setHidden!(0, "cols", 4, 4, true);
    expect(e.outline!(0).hiddenCols).toEqual([4]);
    e.dispose();
  });

  it("enforces sheet protection and verifies the password", async () => {
    const e = await engine();
    e.setStyle!(0, "B1", { locked: false });
    e.protectSheet!(0, { password: "pw" });
    expect(e.sheetProtection!(0).protected).toBe(true);
    expect(() => e.setCell(0, 0, 0, "x")).toThrow(/protected/);
    expect(e.setCell(0, 0, 1, "ok").changed.length).toBeGreaterThanOrEqual(0);
    expect(e.cellProtection!(0, 0, 1).locked).toBe(false);
    expect(() => e.unprotectSheet!(0, "nope")).toThrow();
    e.unprotectSheet!(0, "pw");
    e.setCell(0, 0, 0, "x");
    e.protectWorkbook!("", true, false);
    expect(() => e.addSheet!("New")).toThrow(/protected/);
    e.dispose();
  });

  it("validates entries and lists dropdown items", async () => {
    const e = await engine();
    e.setValidation!(0, "A1:A3", { type: "list", listItems: ["Yes", "No"] });
    expect(e.validationAt!(0, 1, 0)?.listItems).toEqual(["Yes", "No"]);
    const bad = e.enterCell!(0, 0, 0, "Maybe");
    expect(bad.applied).toBe(false);
    expect(bad.alert?.style).toBe("stop");
    expect(e.enterCell!(0, 0, 0, "no").applied).toBe(true);
    e.setValidation!(0, "B1", {
      type: "whole",
      operator: "lessThan",
      formula1: "10",
      errorStyle: "warning",
    });
    expect(e.checkEntry!(0, 0, 1, "12").valid).toBe(false);
    expect(e.enterCell!(0, 0, 1, "12", true).applied).toBe(true);
    expect(e.invalidCells!(0)).toEqual([{ row: 0, col: 1, rule: 1 }]);
    expect(e.listValidationRules!(0)).toHaveLength(2);
    e.dispose();
  });
});
