// Sheet ADR 524 — the workbook panel's Document styles section as a
// component (happy-dom, `bun run test:dom`), over a recording session: the
// switch, the mapping table with usage counts, "Create document styles
// from workbook" and the missing references with their remap.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import {
  DocStylesSection,
  type DocStylesSession,
} from "../src/panels/doc-styles-section";
import type { DocStylesInfo } from "../src/session";

afterEach(() => cleanup());

function fake(info: DocStylesInfo | null) {
  const calls: unknown[][] = [];
  const session: DocStylesSession = {
    docStyles: () => info,
    documentStyleRevision: () => 0,
    documentStyleLists: async () => ({
      lists: {
        paragraph: [
          {
            id: "ParagraphStyle/$ID/NormalParagraphStyle",
            name: "[Basic Paragraph]",
          },
          { id: "ParagraphStyle/H1", name: "Heading 1" },
        ],
        character: [{ id: "CharacterStyle/Em", name: "Emphasis" }],
        cell: [],
        swatches: ["Color/Black"],
      },
      missing: [{ kind: "paragraph", id: "ParagraphStyle/Gone", cells: 0 }],
    }),
    setDocStylesEnabled: async (on) => {
      calls.push(["enabled", on]);
      return { ok: true };
    },
    setDocStyleMapping: (style, target) => {
      calls.push(["map", style, target]);
      return { ok: true };
    },
    createDocStylesFromWorkbook: async () => {
      calls.push(["create"]);
      return { ok: true, created: 2 };
    },
    remapDocReference: async (from, to) => {
      calls.push(["remap", from, to]);
      return { ok: true };
    },
  };
  return { session, calls };
}

const INFO: DocStylesInfo = {
  enabled: false,
  entries: { "Heading 1": { para: "ParagraphStyle/Gone" } },
  usage: [
    { name: "Normal", cells: 4, bold: false, italic: false },
    { name: "Heading 1", cells: 2, bold: true, italic: false },
    { name: "Unused", cells: 0, bold: false, italic: false },
  ],
};

const q = (root: HTMLElement, sel: string) =>
  root.querySelector(sel) as HTMLElement | null;

describe("Document styles section [sheet.format.doc-style-map]", () => {
  it("shows the switch, the offer and one row per used or mapped style", async () => {
    const { session } = fake(INFO);
    const { container } = render(createElement(DocStylesSection, { session }));
    await act(async () => {});
    expect(q(container, "[data-sheet-docstyles-offer]")).not.toBeNull();
    const rows = [
      ...container.querySelectorAll("[data-sheet-docstyles-row]"),
    ].map((r) => r.getAttribute("data-sheet-docstyles-row"));
    expect(rows).toEqual(["Normal", "Heading 1"]);
    // The count column.
    expect(
      q(container, '[data-sheet-docstyles-row="Normal"]')?.textContent,
    ).toContain("4");
    // A mapped id the document lost is still shown, marked.
    const sel = q(
      container,
      '[data-sheet-docstyles-select="Heading 1:para"]',
    ) as HTMLSelectElement;
    expect(sel.value).toBe("ParagraphStyle/Gone");
    expect(sel.textContent).toContain("ParagraphStyle/Gone ⚠");
    expect(sel.textContent).toContain("[Basic Paragraph]");
  });

  it("drives the switch, a mapping, create and remap", async () => {
    const { session, calls } = fake(INFO);
    const { container } = render(createElement(DocStylesSection, { session }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(q(container, "[data-sheet-docstyles-enabled]")!);
    });
    expect(calls[0]).toEqual(["enabled", true]);

    fireEvent.change(
      q(container, '[data-sheet-docstyles-select="Normal:char"]')!,
      { target: { value: "CharacterStyle/Em" } },
    );
    expect(calls[1]).toEqual(["map", "Normal", { char: "CharacterStyle/Em" }]);

    await act(async () => {
      fireEvent.click(q(container, "[data-sheet-docstyles-create]")!);
    });
    expect(calls[2]).toEqual(["create"]);
    expect(q(container, "[data-sheet-docstyles-msg]")?.textContent).toContain(
      "2",
    );

    expect(
      q(container, "[data-sheet-docstyles-missing]")?.textContent,
    ).toContain("1");
    fireEvent.click(q(container, "[data-sheet-docstyles-remap]")!);
    fireEvent.change(
      q(
        container,
        '[data-sheet-docstyles-select="remap:ParagraphStyle/Gone"]',
      )!,
      { target: { value: "ParagraphStyle/H1" } },
    );
    await act(async () => {
      fireEvent.click(
        q(
          container,
          '[data-sheet-docstyles-remap-apply="ParagraphStyle/Gone"]',
        )!,
      );
    });
    expect(calls[3]).toEqual([
      "remap",
      "ParagraphStyle/Gone",
      "ParagraphStyle/H1",
    ]);
  });

  it("says to open a workbook first without one", () => {
    const { session } = fake(null);
    const { container } = render(createElement(DocStylesSection, { session }));
    expect(q(container, "[data-sheet-docstyles-empty]")).not.toBeNull();
  });
});
