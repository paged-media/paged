// paged.image's two PANELS as components, in the DOM lane (happy-dom,
// `bun run test:dom`; the plain `bun run test` skips this file).
//
// The Image panel (`panel.adjustments`) is the bundle's React panel: the
// test mounts the component the bundle REGISTERED, over the fake editor
// and the real session, and drives it with clicks — state on screen,
// buttons that edit the image, the honest no-GPU note.
//
// The Image properties panel (`panel.properties`) is a SCHEMA panel: the
// bundle ships rows and gates, the HOST renders them. The test renders
// the registered schema with a minimal stand-in renderer (`SchemaProbe`,
// which evaluates the gates with the SDK's `resolveGate`, the function the
// editor's renderer uses) over the headless host, so what is asserted is
// the bundle's part: the layer list it publishes, the sections its gates
// show and hide as the picked layer changes, and the rows' addresses.
//
// THE ENGINE BOOT. image-js picks its loader by `typeof window`; under
// happy-dom it would take the browser path (a bundler `?url` import Bun
// cannot serve). `withNodeEngine` hides `window` while the session (or
// the object model's codec) boots its engine; booted once, it is cached,
// and everything after runs with the DOM in place.

import { afterEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import type {
  PanelContribution,
  PanelSchemaPropertyRow,
  PanelSchemaWidgetRow,
  SchemaPanelContribution,
  SchemaPanelRendererProps,
} from "@paged-media/plugin-api";
import { createHeadlessHost, resolveGate } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect, useReducer } from "react";

import { imageBundle, PANEL_ID } from "../src";
import { PROPERTIES_PANEL_ID } from "../src/panels/properties-panel";
import { lastSession } from "./bundle-session";
import { bundleOnFake, FRAME, quiesce, twoColourPng } from "./command-kit";
import { minimalIdml } from "./fixtures/minimal-idml";
import { silentConsole } from "./helpers";

afterEach(() => cleanup());

/** Run `fn` with `window` hidden, so the image engine boots its Node
 *  loader (see the header). */
async function withNodeEngine<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { window?: unknown };
  const w = g.window;
  g.window = undefined;
  try {
    return await fn();
  } finally {
    g.window = w;
  }
}

const q = (root: HTMLElement, attr: string) =>
  root.querySelector(`[${attr}]`) as HTMLElement | null;
const qa = (root: HTMLElement, attr: string) =>
  Array.from(root.querySelectorAll(`[${attr}]`)) as HTMLElement[];

describe("the Image panel (React)", () => {
  async function mounted() {
    const k = await withNodeEngine(async () => {
      const b = await bundleOnFake();
      await b.ingest();
      return b;
    });
    const panel = k.fake.panels.get(PANEL_ID) as unknown as PanelContribution;
    const Panel = panel.component;
    const view = render(
      <Panel paged={k.fake.editor} api={undefined as never} />,
    );
    return { k, root: view.container as HTMLElement };
  }

  it("shows the ingested image, its one layer, and says the adjustments need a GPU", async () => {
    covers("panel:media.paged.image.panel.adjustments");
    const { k, root } = await mounted();
    expect(q(root, "data-image-status")?.textContent).toContain("4×2 decoded");
    // No WebGPU in this lane: the panel says so instead of offering
    // sliders that would do nothing.
    expect(q(root, "data-image-no-gpu")).not.toBeNull();
    expect(qa(root, "data-image-layer-row")).toHaveLength(1);
    expect(q(root, "data-image-layers-section")?.textContent).toContain(
      "Background",
    );
    // Bake needs the GPU: the button is there and disabled.
    expect(
      (q(root, "data-image-layer-bake") as HTMLButtonElement).disabled,
    ).toBe(true);
    k.dispose();
  });

  it("Add layer adds a row; the panel's Undo names the step and takes it back", async () => {
    covers("panel:media.paged.image.panel.adjustments");
    const { k, root } = await mounted();
    const undo = () => q(root, "data-image-undo") as HTMLButtonElement;
    expect(undo().disabled).toBe(true);
    fireEvent.click(q(root, "data-image-layer-add")!);
    await waitFor(() =>
      expect(qa(root, "data-image-layer-row")).toHaveLength(2),
    );
    expect(k.session.state().layers.layers.map((l) => l.name)).toEqual([
      "Background",
      "Layer 2",
    ]);
    expect(undo().disabled).toBe(false);
    expect(undo().textContent).toMatch(/^Undo .+/);
    fireEvent.click(undo());
    await waitFor(() =>
      expect(qa(root, "data-image-layer-row")).toHaveLength(1),
    );
    // Nothing reached the document: the image is the plugin's until
    // Commit.
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("a canvas button rotates the image, and the status reports the new size", async () => {
    covers("panel:media.paged.image.panel.adjustments");
    const { k, root } = await mounted();
    const rotate = qa(root, "data-image-canvas-op").find(
      (b) => b.getAttribute("data-image-canvas-op") === "rotate-cw",
    )!;
    fireEvent.click(rotate);
    await waitFor(() =>
      expect(q(root, "data-image-status")?.textContent).toContain(
        "Canvas → 2×4",
      ),
    );
    expect(k.session.state().source?.width).toBe(2);
    k.dispose();
  });

  it("Use selected frame loads the frame now selected", async () => {
    covers("panel:media.paged.image.panel.adjustments");
    const { k, root } = await mounted();
    // A second, larger frame, selected on the page.
    k.fake.placed.set("u2", await withNodeEngine(() => twoColourPng(8, 4)));
    k.fake.geometry.set("u2", {
      id: { kind: "rectangle", id: "u2" } as never,
      pageId: "pg1",
      bounds: [0, 300, 100, 500],
    });
    k.fake.emitSelection([{ kind: "rectangle", id: "u2" }]);
    const use = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Use selected frame",
    )!;
    fireEvent.click(use);
    await waitFor(() =>
      expect(q(root, "data-image-status")?.textContent).toContain(
        "8×4 decoded",
      ),
    );
    expect(k.session.state().source?.elementId).toBe("u2");
    k.dispose();
  });
});

// ── the schema panel ────────────────────────────────────────────────

interface ListRow {
  selfId: string;
  name: string;
  secondary?: string;
}

/** The stand-in host renderer: visible sections (the SDK's own gate
 *  semantics), each list row's published items, each property row's
 *  path and the address it is bound to. */
function SchemaProbe({ schema, bindings }: SchemaPanelRendererProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = bindings.onDidChange(() => bump());
    return () => sub.dispose();
  }, [bindings]);
  const lookup = (name: string) => bindings.get(name);
  return (
    <div data-probe={schema.id}>
      {schema.sections
        .filter((s) => resolveGate(s.visible, lookup))
        .map((s) => (
          <section key={s.title} data-probe-section={s.title}>
            {s.rows.map((r, i) => {
              const w = r as PanelSchemaWidgetRow;
              if (w.list) {
                const items =
                  (bindings.get((w.list.items as { bind: string }).bind) as
                    ListRow[] | undefined) ?? [];
                return (
                  <ul key={i} data-probe-list>
                    {items.map((it) => (
                      <li key={it.selfId} data-probe-item={it.selfId}>
                        {it.name}
                      </li>
                    ))}
                  </ul>
                );
              }
              const p = r as PanelSchemaPropertyRow;
              const bind = (p.address as { bind?: string }).bind;
              return (
                <div
                  key={i}
                  data-probe-row={p.path}
                  data-probe-address={String(bind ? lookup(bind) : "")}
                />
              );
            })}
          </section>
        ))}
    </div>
  );
}

describe("the Image properties panel (schema)", () => {
  it("lists the selected frame's layers, shows the Mask section only for a layer with a mask, and binds its rows to the picked layer", async () => {
    covers("panel:media.paged.image.panel.properties");
    const h = await createHeadlessHost({
      resolveFrom: fileURLToPath(new URL(".", import.meta.url)),
      console: silentConsole,
    });
    await h.load(minimalIdml());
    h.loadBundle(imageBundle);
    const session = lastSession();
    const png = await withNodeEngine(() => twoColourPng());
    const placed = await h.host.document.mutate({
      op: "replaceImageBytes",
      args: { elementId: FRAME, bytes: Array.from(png) },
    } as never);
    expect(placed.applied).toBe(true);
    const IMAGE = `plugin:media.paged.image/image/${FRAME}`;
    const L1 = `plugin:media.paged.image/layer/${FRAME}/1`;
    // The object model's codec boots on its first read.
    await withNodeEngine(() => h.objects.get(IMAGE, "width"));

    const contribution = h.contributions.find(
      (c) => c.kind === "schemaPanel" && c.id === PROPERTIES_PANEL_ID,
    )!.value as SchemaPanelContribution;
    const view = render(
      <SchemaProbe schema={contribution.schema} bindings={h.host.bindings} />,
    );
    const root = view.container as HTMLElement;
    const sections = () =>
      qa(root, "data-probe-section").map((s) =>
        s.getAttribute("data-probe-section"),
      );

    // Nothing selected: the layer list is empty; only the Layers
    // section shows.
    expect(sections()).toEqual(["Layers"]);
    expect(qa(root, "data-probe-item")).toHaveLength(0);

    await act(async () => {
      await h.host.selection.set([{ kind: "rectangle", id: FRAME } as never]);
    });
    await waitFor(() =>
      expect(qa(root, "data-probe-item").map((li) => li.textContent)).toEqual([
        "Background",
      ]),
    );
    // The list picks its one layer, and the layer rows address it.
    act(() => h.host.bindings.publish("image.properties.layer", L1));
    await waitFor(() =>
      expect(
        q(root, 'data-probe-row="name"')?.getAttribute("data-probe-address"),
      ).toBe(L1),
    );
    expect(sections()).toEqual(["Layers"]);

    // A mask on the picked layer opens the Mask section.
    await act(async () => {
      await h.objects.invoke("media.paged.image.command.addLayerMask", {
        layer: L1,
      });
    });
    await waitFor(() => expect(sections()).toEqual(["Layers", "Mask"]));
    expect(
      q(root, 'data-probe-row="enabled"')?.getAttribute("data-probe-address"),
    ).toBe(`plugin:media.paged.image/mask/${FRAME}/1`);

    // A rename written through the row's address re-lists the layer.
    await act(async () => {
      await h.objects.set(L1, "name", "Photo");
    });
    await waitFor(() =>
      expect(qa(root, "data-probe-item").map((li) => li.textContent)).toEqual([
        "Photo",
      ]),
    );
    await quiesce(session);
    h.dispose();
  });
});
