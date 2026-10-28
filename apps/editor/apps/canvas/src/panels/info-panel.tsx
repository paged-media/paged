/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The Info panel: cursor, selection, colour under the cursor, document.
//
// SDK Phase 5 shipped the document section over the singleton
// `DocumentMeta` (label · mono tabular value rows with hairline
// separators; the spec hooks key off the row names). WP4.5 adds what
// InDesign's and Illustrator's Info panels lead with:
//   · the cursor's X/Y on the page under it (the viewport publishes the
//     pointer, `CANVAS_POINTER`), in the document's ruler units;
//   · the selection's X/Y/W/H and angle (several items: their box);
//   · the colour under the cursor, read from a snapshot of the page the
//     canvas draws (`info-sampler.ts`): hex, RGB and L*a*b*. CMYK is NOT
//     shown: the engine converts CMYK values to the display, not sampled
//     display RGB back to the document's CMYK, and the panel says so
//     rather than inventing a naive conversion.
//
// Extensions ADR 3XX: while an edit context adds READOUTS (a raster
// image: the pixel under the cursor, its selection, the Ruler tool's
// measurement), they lead the panel as their own sections. The panel
// shows the provider's rows as given and knows nothing of who sent them.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  CANVAS_POINTER,
  useCanvasClient,
  useCollection,
  useDocument,
  useDocumentMeta,
  useProvidedReadouts,
  useScoped,
  useSelection,
} from "@paged-media/shell";
import type { PageId } from "@paged-media/client";
import { DOCUMENT_UNITS, formatLength, useDocumentUnit } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import {
  rgbHex,
  samplePixel,
  selectionReadout,
  srgbToLab,
} from "./info-readouts";
import { createPageSampler, type PageSampler } from "./info-sampler";

const M = defineMessages("app.infoPanel", {
  page: "Page {number}",
  loading: "Loading document info…",
  document: "Document",
  pages: "Pages",
  activePage: "Active page",
  units: "Units",
  colorMode: "Color mode",
  dirty: "Dirty",
  yes: "yes",
  no: "no",
  cursor: "Cursor",
  selection: "Selection",
  colour: "Colour under cursor",
  noSelection: "Nothing selected",
  offCanvas: "Move the pointer over a page",
  items: "Items",
  angle: "Angle",
  width: "W",
  height: "H",
  hex: "Hex",
  rgb: "RGB",
  lab: "Lab",
  cmyk: "CMYK",
  cmykUnavailable:
    "CMYK is not shown: the engine has no conversion from a sampled display colour to the document's CMYK yet.",
  sampleUnavailable: "The page could not be sampled",
});

/** "Page 3", not the page's IDML id. */
function pageLabel(
  strings: Strings,
  id: unknown,
  pages: ReadonlyArray<{ selfId?: string }> | null,
): string {
  if (!id) return "—";
  const i = pages?.findIndex((p) => p.selfId === String(id)) ?? -1;
  return i >= 0 ? strings.t(M.page, { number: i + 1 }) : String(id);
}

/** `row` names the row for tests (English); `label` is what it shows. */
function Row({
  row,
  label,
  value,
}: {
  row: string;
  label: string;
  value: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-1.5 border-b border-input last:border-b-0"
      data-info-row={row}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="pg-value text-xs" data-info-value>
        {value}
      </span>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col pb-2" data-info-section={id}>
      <h3 className="pg-ui-xs pb-0.5 pt-1 text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Note({ id, text }: { id: string; text: string }) {
  return (
    <p className="py-1 text-xs text-muted-foreground" data-info-note={id}>
      {text}
    </p>
  );
}

type Sample =
  | { state: "ok"; rgba: readonly [number, number, number, number] }
  | { state: "outside" }
  | { state: "unavailable" };

const fmtAngle = (deg: number) => {
  const n = Math.round(deg * 100) / 100;
  return `${Object.is(n, -0) ? 0 : n}°`;
};

export function InfoPanel() {
  const strings = useStrings();
  const meta = useDocumentMeta();
  const pages = useCollection<{ selfId?: string }>("pages");
  const { handle } = useDocument();
  const client = useCanvasClient();
  const { placedGeometry } = useSelection();
  const provided = useProvidedReadouts("info");
  // The unit lengths are shown in (ADR 245), once there is a document.
  const unit = useDocumentUnit();
  const unitName = DOCUMENT_UNITS.find(([u]) => u === unit)?.[1] ?? unit;
  const pointerStore = useScoped(CANVAS_POINTER);
  const pointer = useSyncExternalStore(
    pointerStore.subscribe,
    pointerStore.get,
    pointerStore.get,
  );

  // One sampler while the panel is open: its snapshots die with it.
  const samplerRef = useRef<PageSampler | null>(null);
  useEffect(() => {
    const sampler = createPageSampler(client);
    samplerRef.current = sampler;
    return () => {
      sampler.dispose();
      samplerRef.current = null;
    };
  }, [client]);

  const pageIds = handle?.pageIds;
  const pageSizes = handle?.pageSizesPt;
  const [sample, setSample] = useState<Sample>({ state: "outside" });
  useEffect(() => {
    const sampler = samplerRef.current;
    const pageId = pointer?.pageId ?? null;
    const at = pointer?.pagePoint ?? null;
    const index = pageId && pageIds ? pageIds.indexOf(pageId as PageId) : -1;
    const size = index >= 0 ? pageSizes?.[index] : undefined;
    if (!sampler || !pageId || !at || !size) {
      setSample({ state: "outside" });
      return;
    }
    let live = true;
    void sampler.raster(pageId as PageId).then((raster) => {
      if (!live) return;
      const rgba = raster ? samplePixel(raster, size, at) : null;
      setSample(
        rgba
          ? { state: "ok", rgba }
          : raster
            ? { state: "outside" }
            : { state: "unavailable" },
      );
    });
    return () => {
      live = false;
    };
  }, [pointer, pageIds, pageSizes]);

  if (!meta) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-info-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  const len = (pt: number) => formatLength(pt, unit);
  const sel = selectionReadout(placedGeometry);
  const at = pointer?.pagePoint ?? null;
  const rgb = sample.state === "ok" ? sample.rgba : null;
  const lab = rgb ? srgbToLab(rgb[0], rgb[1], rgb[2]) : null;
  const hex = rgb ? rgbHex(rgb[0], rgb[1], rgb[2]) : null;

  return (
    <div className="p-3 flex flex-col" data-info-panel="ready">
      {provided.map((section) => (
        <Section
          key={section.id}
          id={`provided:${section.id}`}
          title={section.title}
        >
          {section.rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 py-1.5 border-b border-input last:border-b-0"
              data-info-row={row.id}
            >
              <span className="text-xs text-muted-foreground">{row.label}</span>
              <span className="flex items-center gap-2">
                {row.swatch && (
                  <span
                    className="inline-block h-3 w-5 rounded-[2px] border border-input"
                    style={{ background: row.swatch }}
                    data-info-swatch={row.swatch}
                  />
                )}
                <span className="pg-value text-xs" data-info-value>
                  {row.value}
                </span>
              </span>
            </div>
          ))}
        </Section>
      ))}
      <Section id="cursor" title={strings.t(M.cursor)}>
        <Row row="Cursor X" label="X" value={at ? len(at[0]) : "—"} />
        <Row row="Cursor Y" label="Y" value={at ? len(at[1]) : "—"} />
        <Row
          row="Cursor page"
          label={strings.t(M.activePage)}
          value={at ? pageLabel(strings, pointer?.pageId, pages) : "—"}
        />
      </Section>
      <Section id="selection" title={strings.t(M.selection)}>
        {sel ? (
          <>
            <Row row="Selection X" label="X" value={len(sel.x)} />
            <Row row="Selection Y" label="Y" value={len(sel.y)} />
            <Row
              row="Selection W"
              label={strings.t(M.width)}
              value={len(sel.w)}
            />
            <Row
              row="Selection H"
              label={strings.t(M.height)}
              value={len(sel.h)}
            />
            <Row
              row="Selection angle"
              label={strings.t(M.angle)}
              value={sel.angle === null ? "—" : fmtAngle(sel.angle)}
            />
            {sel.count > 1 && (
              <Row
                row="Selection items"
                label={strings.t(M.items)}
                value={String(sel.count)}
              />
            )}
          </>
        ) : (
          <Note id="no-selection" text={strings.t(M.noSelection)} />
        )}
      </Section>
      <Section id="colour" title={strings.t(M.colour)}>
        {rgb && hex && lab ? (
          <>
            <div
              className="flex items-center justify-between gap-3 py-1.5 border-b border-input"
              data-info-row="Colour swatch"
            >
              <span
                className="inline-block h-4 w-8 rounded-[3px] border border-input"
                style={{ background: hex }}
                data-info-swatch={hex}
              />
            </div>
            <Row row="Hex" label={strings.t(M.hex)} value={hex} />
            <Row
              row="RGB"
              label={strings.t(M.rgb)}
              value={`${rgb[0]} ${rgb[1]} ${rgb[2]}`}
            />
            <Row
              row="Lab"
              label={strings.t(M.lab)}
              value={`${lab[0]} ${lab[1]} ${lab[2]}`}
            />
            <Row row="CMYK" label={strings.t(M.cmyk)} value="—" />
            <Note id="cmyk" text={strings.t(M.cmykUnavailable)} />
          </>
        ) : (
          <Note
            id={sample.state === "unavailable" ? "unavailable" : "outside"}
            text={strings.t(
              sample.state === "unavailable"
                ? M.sampleUnavailable
                : M.offCanvas,
            )}
          />
        )}
      </Section>
      <Section id="document" title={strings.t(M.document)}>
        <Row
          row="Document"
          label={strings.t(M.document)}
          value={meta.documentName || "—"}
        />
        <Row
          row="Pages"
          label={strings.t(M.pages)}
          value={String(meta.pageCount)}
        />
        <Row
          row="Active page"
          label={strings.t(M.activePage)}
          value={pageLabel(strings, meta.activePage, pages)}
        />
        <Row
          row="Units"
          label={strings.t(M.units)}
          value={meta.pageCount > 0 ? unitName : "—"}
        />
        <Row
          row="Color mode"
          label={strings.t(M.colorMode)}
          value={meta.colorMode || "—"}
        />
        <Row
          row="Dirty"
          label={strings.t(M.dirty)}
          value={meta.dirty ? strings.t(M.yes) : strings.t(M.no)}
        />
      </Section>
    </div>
  );
}
