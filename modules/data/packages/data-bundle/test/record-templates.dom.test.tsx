// The Record templates and Record flow pagination panels as COMPONENTS
// (happy-dom, `bun run test:dom`): the components the real bundle registered,
// mounted over the real session and the real data-js engine with its query
// store (the recording fake editor stands in for the editor;
// ./conformance/env.ts). The fake editor keeps no stories, so the selected
// text frame's geometry and story are answered here.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { covers, waitFor } from "@paged-media/test-kit";

import { readiness, unitEnv, type DataEnv } from "./conformance/env";
import { PANEL, seed } from "./conformance/scenarios";

const gate = readiness(false);
const TEMPLATES = "media.paged.data.panel.templates";
const PAGINATION = "media.paged.data.panel.pagination";

if (gate.required && !gate.ready) {
  describe("record template panels (engines) — REQUIRED", () => {
    it("FAILS: a REQUIRE_REAL_* lane but an engine is missing", () => {
      throw new Error(`missing: ${gate.missing}`);
    });
  });
}

async function settle(env: DataEnv): Promise<void> {
  await act(async () => {
    await env.settle();
  });
}

function mount(env: DataEnv, id: string): HTMLElement {
  const { container } = render(
    createElement(env.panel(id).component as never, {
      paged: env.host.editor,
      api: {},
    }),
  );
  return container;
}

const q = (root: ParentNode, sel: string): HTMLElement => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`no ${sel} in the panel`);
  return el as HTMLElement;
};

/** Select one text frame whose story holds `text`. */
function selectFrameWithText(
  env: DataEnv & { fake: { setSelection(ids: readonly ElementId[]): void } },
  text: string,
): void {
  const frame = { kind: "textFrame", id: "tf1" } as ElementId;
  env.fake.setSelection([frame]);
  const doc = env.host.document as BundleHost["document"] & {
    elementGeometry: unknown;
    storyContent: unknown;
  };
  doc.elementGeometry = async (ids: ElementId[]) =>
    ids.map((id) => ({ id, storyId: "story1" }));
  doc.storyContent = async (storyId: string) =>
    storyId === "story1"
      ? {
          paragraphs: text
            .split("\n")
            .map((line) => ({ runs: [{ text: line }] })),
        }
      : null;
}

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data record templates${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Awaited<ReturnType<typeof unitEnv>>;
    beforeEach(async () => {
      env = await unitEnv();
    });
    afterEach(() => {
      cleanup();
      env.dispose();
    });

    it("Record templates: made from the selected frame, previewed with record N, renamed and deleted [data.lower.record-templates]", async () => {
      covers("panel:media.paged.data.panel.templates");
      let root = mount(env, TEMPLATES);
      // No source: the engine is not running, and the panel says where to start.
      fireEvent.click(q(root, "[data-data-tmpl-open-sources]"));
      expect(env.opened).toEqual([PANEL.sources]);
      cleanup();

      await seed(env);
      root = mount(env, TEMPLATES);
      await settle(env);
      expect(q(root, "[data-data-tmpl-empty]").textContent).toContain(
        "No record templates yet.",
      );

      // Without a name nothing is made.
      await act(async () => {
        fireEvent.click(q(root, "[data-data-tmpl-create]"));
      });
      expect(q(root, "[data-data-tmpl-error]").textContent).toContain(
        "Give the template a name.",
      );

      selectFrameWithText(env, "<<name>>\nSKU: <<sku>>\n<<weight_mm>> mm");
      fireEvent.change(q(root, "[data-data-tmpl-name]"), {
        target: { value: "card" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-data-tmpl-create]"));
      });
      await settle(env);
      expect(q(root, "[data-data-tmpl-made]").textContent).toContain(
        'Made "card" with 3 line(s).',
      );
      const item = q(root, '[data-data-tmpl="card"]');
      expect(item.textContent).toContain("3 line(s) · 12 pt per line");
      expect(q(item, "[data-data-tmpl-users]").textContent).toBe("not used");

      // The preview fills it with record 1 of the query, then record 2.
      await waitFor(
        () =>
          expect(q(root, "[data-data-tmpl-preview]").textContent).toContain(
            "Alpha",
          ),
        { timeout: 10_000 },
      );
      const preview = () => q(root, "[data-data-tmpl-preview]");
      expect(preview().textContent).toContain("SKU: A-1");
      expect(preview().textContent).toContain("2 mm");
      expect(root.textContent).toContain("of 3");
      await act(async () => {
        fireEvent.click(q(root, "[data-data-tmpl-next]"));
      });
      await settle(env);
      await waitFor(() => expect(preview().textContent).toContain("Beta"));
      expect(q(root, "[data-data-tmpl-record]").textContent).toBe("2");

      // Rename.
      fireEvent.click(q(item, "[data-data-tmpl-rename]"));
      fireEvent.change(q(root, "[data-data-tmpl-rename-input]"), {
        target: { value: "Product card" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-data-tmpl-rename-save]"));
      });
      await settle(env);
      expect(root.querySelector('[data-data-tmpl="card"]')).toBeNull();
      const renamed = q(root, '[data-data-tmpl="Product card"]');
      expect(env.session.templateLibrary()!.map((e) => e.template.id)).toEqual([
        "Product card",
      ]);

      // A flow using it keeps it from being deleted.
      env.session.defineRecordFlow("rf", "q", [{ expr: "name" }]);
      const flowTemplate = "rf.template";
      expect(
        await env.session.setRecordFlow("rf", "Product card", {
          groupBy: [],
          repeatHeader: true,
          continuedMarker: true,
        }),
      ).toBeNull();
      await settle(env);
      expect(
        q(q(root, '[data-data-tmpl="Product card"]'), "[data-data-tmpl-users]")
          .textContent,
      ).toBe("used by rf");
      expect(
        (
          q(
            q(root, '[data-data-tmpl="Product card"]'),
            "[data-data-tmpl-delete]",
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);

      // An unused one goes on the confirming second click.
      const unused = q(root, `[data-data-tmpl="${flowTemplate}"]`);
      const del = q(unused, "[data-data-tmpl-delete]");
      fireEvent.click(del);
      expect(del.getAttribute("data-armed")).toBe("true");
      await act(async () => {
        fireEvent.click(del);
      });
      await settle(env);
      expect(
        root.querySelector(`[data-data-tmpl="${flowTemplate}"]`),
      ).toBeNull();
      expect(renamed.isConnected).toBe(true);
    });

    it("Pagination: the flow's options as inline controls, the summary following each change [data.lower.pagination]", async () => {
      covers("panel:media.paged.data.panel.pagination");
      await seed(env);
      let root = mount(env, PAGINATION);
      await settle(env);
      fireEvent.click(q(root, "[data-data-flow-open-bindings]"));
      expect(env.opened).toEqual([PANEL.bindings]);
      cleanup();

      env.session.defineRecordFlow("rf", "q", [
        { expr: "name" },
        { label: "SKU ", expr: "sku" },
      ]);
      root = mount(env, PAGINATION);
      await settle(env);
      const placed = () => q(root, "[data-data-flow-placed]").textContent;
      const perPage = () => q(root, "[data-data-flow-per-page]").textContent;
      await waitFor(() =>
        expect(placed()).toBe("3 of 3 record(s) on 1 page(s)"),
      );
      expect(perPage()).toBe("Records per page: 3");

      // Taller lines: two lines of 300 pt are a 600 pt record, one per page.
      fireEvent.change(q(root, "[data-data-flow-line-height]"), {
        target: { value: "300" },
      });
      await act(async () => {
        fireEvent.blur(q(root, "[data-data-flow-line-height]"));
      });
      await settle(env);
      await waitFor(() => expect(perPage()).toBe("Records per page: 1, 1, 1"));
      expect(
        env.session
          .templateLibrary()!
          .find((e) => e.template.id === "rf.template")!.template.lineHeightPt,
      ).toBe(300);

      // Grouping by `shown` (yes: Alpha, Gamma; no: Beta) opens the header
      // options; the footer counts each group.
      const repeat = () =>
        q(root, "[data-data-flow-repeat]") as HTMLInputElement;
      fireEvent.change(q(root, "[data-data-flow-group]"), {
        target: { value: "shown" },
      });
      await act(async () => {
        fireEvent.blur(q(root, "[data-data-flow-group]"));
      });
      await settle(env);
      expect(env.session.recordFlow("rf")!.options.groupBy).toEqual(["shown"]);
      expect(repeat().disabled).toBe(false);
      await act(async () => {
        fireEvent.click(q(root, "[data-data-flow-footer]"));
      });
      await settle(env);
      const footer = env.session.recordFlow("rf")!.options.footer!;
      expect(footer.label).toBe("{count}");
      expect(footer.sumField ?? null).toBeNull();
      expect(footer.agg).toBe("sum");
      // The Alpha/Gamma group spills: its header comes back continued.
      await waitFor(() =>
        expect(
          q(root, "[data-data-flow-continued-count]").textContent,
        ).toContain("repeated as continued"),
      );

      // Repeated headers off: none comes back, and continued goes with it.
      await act(async () => {
        fireEvent.click(repeat());
      });
      await settle(env);
      const opts = env.session.recordFlow("rf")!.options;
      expect(opts.repeatHeader).toBe(false);
      expect(opts.continuedMarker).toBe(false);
      await waitFor(() =>
        expect(
          root.querySelector("[data-data-flow-continued-count]"),
        ).toBeNull(),
      );
      expect(
        (q(root, "[data-data-flow-continued]") as HTMLInputElement).disabled,
      ).toBe(true);
    });
  },
);
