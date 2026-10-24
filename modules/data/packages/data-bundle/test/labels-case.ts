// The label cases shared by the bundle and the engine (core ADR 1014):
// `conformance/labels/cases.json` holds labels written by hand, and the recipe
// `restoreFromLabels` rebuilds from each. `conformance/labels/record.ts`
// records the answers from this file; test/labels-conformance.spec.ts and
// paged-data-session's `labels` test (Rust) replay them.
import { labelData } from "../../data-host-model/src";
import { restoreFromLabels, type LabelledElement } from "../src/labels";

export interface LabelCase {
  name: string;
  elements: {
    element: { kind: string; id: string };
    label: string | null;
  }[];
  documentLabel: string | null;
  expect?: unknown;
}

export const CASES_PATH = new URL(
  "../../../conformance/labels/cases.json",
  import.meta.url,
);

/** The recipe of one case, as plain JSON (the facts' maps as objects). */
export function restoreCase(c: LabelCase): unknown {
  const elements: LabelledElement[] = c.elements.map((e) => ({
    element: e.element as LabelledElement["element"],
    data: labelData(e.label),
  }));
  const recipe = labelData(c.documentLabel)?.recipe ?? null;
  const restored = restoreFromLabels(
    elements,
    recipe && typeof recipe === "object" ? recipe : null,
  );
  const facts = Object.fromEntries(
    Object.entries(restored.facts).map(([k, m]) => [
      k,
      Object.fromEntries(m as Map<string, unknown>),
    ]),
  );
  // JSON drops what is undefined, as the Rust reader never writes it.
  return JSON.parse(
    JSON.stringify({
      payload: restored.payload,
      facts,
      fromElements: restored.fromElements,
    }),
  );
}
