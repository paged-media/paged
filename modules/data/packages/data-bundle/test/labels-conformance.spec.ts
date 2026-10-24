// The bundle's label reader against the shared cases (core ADR 1014): the
// engine's reader (paged-data-session/src/labels.rs) replays the same file,
// so a document's bindings read the same in the editor and on the CLI.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CASES_PATH, restoreCase, type LabelCase } from "./labels-case";

const { cases } = JSON.parse(
  readFileSync(fileURLToPath(CASES_PATH), "utf8"),
) as { cases: LabelCase[] };

describe("restoreFromLabels replays the shared label cases [data.bind.labels-native]", () => {
  it("every case has a recorded answer", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.expect, c.name).toBeDefined();
  });
  for (const c of cases) {
    it(c.name, () => {
      expect(restoreCase(c)).toEqual(c.expect);
    });
  }
});
