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

// Engine ADR 1011 — the Artboards panel. Every page is an artboard placed
// on the canvas; this lists them in page order and edits them:
//
//   - a row selects its board (the Artboard tool's selection) and takes
//     the camera there;
//   - New / Duplicate / Delete, Move earlier / later (the page order,
//     `movePage`);
//   - Artboard options for the selected board: its name (page metadata,
//     `x-paged:paged.artboard`), its size (presets, width / height,
//     orientation — `resizePage`, the board's top-left staying put);
//   - Rearrange all: a grid of N columns with a spacing, one batch of
//     `placePage`s (one undo step);
//   - Export per artboard: each board one PNG or PDF file named after it.
//
// Every write is one undo step.

import { useState, useSyncExternalStore } from "react";

import {
  ListRows,
  PanelToolbar,
  ToolbarBtn,
  useCamera,
  useCanvasClient,
  useCollection,
  useDocument,
} from "@paged-media/shell";
import {
  ARTBOARD_PRESETS,
  artboardFileName,
  artboardSelectionOf,
  artboardsOf,
  rearrangeMutation,
  renameArtboardMutation,
  resizeArtboardMutation,
  type Artboard,
  type PageSummaryLike,
} from "@paged-media/tools";
import {
  formatLengthPair,
  KitSelect,
  LengthInput,
  NumberInput,
  useDocumentUnit,
} from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

import { downloadBytes } from "../shell-file-saver";
import { fitCamera, layoutPages } from "../ui/layout";
import { useAnimatedCamera } from "../ui/useAnimatedCamera";
import { runImageExport } from "./cockpit/export-targets";

export const M = defineMessages("app.artboardsPanel", {
  loading: "Loading artboards…",
  empty: "No artboards.",
  defaultName: "Artboard {n}",
  newArtboard: "New artboard",
  duplicate: "Duplicate artboard",
  delete: "Delete artboard",
  selectFirst: "{action} (select one first)",
  moveEarlier: "Move artboard earlier",
  moveLater: "Move artboard later",
  options: "Artboard options",
  name: "Name",
  preset: "Size",
  custom: "Custom",
  width: "Width",
  height: "Height",
  orientation: "Orientation",
  portrait: "Portrait",
  landscape: "Landscape",
  rearrange: "Rearrange all",
  columns: "Columns",
  spacing: "Spacing",
  rearrangeApply: "Rearrange",
  export: "Export artboards",
  format: "Format",
  exportSelected: "Export selected",
  exportAll: "Export all",
  exported: "{n} file(s) exported",
  exportFailed: "Export failed: {message}",
});

/** The board list, the selection and the camera helpers the panel uses. */
function useArtboards() {
  const strings = useStrings();
  const items = useCollection<PageSummaryLike>("pages");
  const boards =
    items === null
      ? null
      : artboardsOf(items, (n) => strings.t(M.defaultName, { n }));
  return boards;
}

export function ArtboardsPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const boards = useArtboards();
  const unit = useDocumentUnit();
  const { handle } = useDocument();
  const { camera, setCamera, viewportSize } = useCamera();
  const animateCamera = useAnimatedCamera(camera, setCamera);
  const selection = artboardSelectionOf(client);
  const selectedId = useSyncExternalStore(
    selection.subscribe,
    selection.get,
    selection.get,
  );
  const [columns, setColumns] = useState(3);
  const [spacingPt, setSpacingPt] = useState(72);
  const [format, setFormat] = useState<"png" | "pdf">("png");
  const [status, setStatus] = useState<string | null>(null);

  if (boards === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-artboards-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }

  const selected = boards.find((b) => b.pageId === selectedId) ?? null;
  const at = selected ? boards.indexOf(selected) : -1;

  const write = (mutation: unknown) =>
    client.mutate(mutation as never).catch(() => null);

  const select = (b: Artboard) => {
    selection.set(b.pageId);
    const [vw, vh] = viewportSize;
    if (vw < 10 || vh < 10 || !handle) return;
    const idx = handle.pageIds.indexOf(b.pageId as never);
    const rect = layoutPages(handle.pageSizesPt, handle.pageOriginsPt)[idx];
    if (rect) animateCamera(fitCamera(vw, vh, rect));
  };

  const selectCreated = (reply: unknown) => {
    const r = reply as {
      kind?: string;
      payload?: { createdPages?: string[] };
    } | null;
    const created =
      r?.kind === "mutationApplied" && r.payload?.createdPages?.[0];
    if (created) selection.set(created);
  };

  const onNew = () =>
    void write({
      op: "insertPage",
      args: {
        afterPageId: (selected ?? boards[boards.length - 1])?.pageId ?? null,
        masterId: null,
      },
    }).then(selectCreated);
  const onDuplicate = selected
    ? () =>
        void write({
          op: "duplicatePage",
          args: { page: selected.pageId },
        }).then(selectCreated)
    : undefined;
  const onDelete = selected
    ? () => {
        selection.set(null);
        void write({ op: "deletePage", args: { pageId: selected.pageId } });
      }
    : undefined;
  const move = (after: Artboard | null) =>
    selected &&
    void write({
      op: "movePage",
      args: {
        page: selected.pageId,
        ...(after ? { after: after.pageId } : {}),
      },
    });
  const onMoveUp =
    at > 0 ? () => move(at >= 2 ? boards[at - 2] : null) : undefined;
  const onMoveDown =
    at >= 0 && at < boards.length - 1 ? () => move(boards[at + 1]) : undefined;

  const resizeTo = (b: Artboard, w: number, h: number) => {
    const m = resizeArtboardMutation(b, { x: b.x, y: b.y, w, h });
    if (m) void write(m);
  };

  const exportBoards = async (list: readonly Artboard[]) => {
    setStatus(null);
    const taken = new Set<string>();
    let files = 0;
    try {
      if (format === "png") {
        const ids = boards.map((b) => b.pageId);
        const r = await runImageExport(client, {
          pageIds: ids,
          pageSizesPt: boards.map((b): [number, number] => [b.w, b.h]),
          settings: {
            format: "png",
            dpi: 150,
            quality: 0.92,
            scope: "range",
            range: list.map((b) => String(boards.indexOf(b) + 1)).join(","),
          },
          pageNames: boards.map((b) => b.name),
        });
        files = r.files;
      } else {
        for (const b of list) {
          const i = boards.indexOf(b);
          const { bytes } = await client.exportPdf({
            pageFrom: i,
            pageTo: i,
            title: b.name,
          });
          downloadBytes(
            bytes,
            artboardFileName(b.name, "pdf", taken),
            "application/pdf",
          );
          files += 1;
        }
      }
      setStatus(strings.t(M.exported, { n: files }));
    } catch (err) {
      setStatus(
        strings.t(M.exportFailed, {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const label = (action: string, enabled: boolean) =>
    enabled ? action : strings.t(M.selectFirst, { action });

  const preset = selected
    ? (ARTBOARD_PRESETS.find(
        (p) =>
          (near(p.w, selected.w) && near(p.h, selected.h)) ||
          (near(p.h, selected.w) && near(p.w, selected.h)),
      )?.id ?? "custom")
    : "custom";
  const landscape = selected ? selected.w > selected.h : false;

  return (
    <div data-artboards-panel="ready">
      <PanelToolbar>
        <ToolbarBtn
          icon="ui-plus"
          testId="artboard-new"
          label={strings.t(M.newArtboard)}
          onClick={onNew}
        />
        <ToolbarBtn
          icon="ui-component"
          testId="artboard-duplicate"
          label={label(strings.t(M.duplicate), Boolean(onDuplicate))}
          onClick={onDuplicate}
        />
        <ToolbarBtn
          icon="ui-x"
          testId="artboard-delete"
          label={label(strings.t(M.delete), Boolean(onDelete))}
          onClick={onDelete}
        />
        <ToolbarBtn
          icon="ui-chevron-left"
          testId="artboard-earlier"
          label={label(strings.t(M.moveEarlier), Boolean(onMoveUp))}
          onClick={onMoveUp}
        />
        <ToolbarBtn
          icon="ui-chevron-right"
          testId="artboard-later"
          label={label(strings.t(M.moveLater), Boolean(onMoveDown))}
          onClick={onMoveDown}
        />
      </PanelToolbar>
      {boards.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-empty-artboards>
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-artboard-list>
          <ListRows
            rows={boards.map((b) => ({
              key: b.pageId,
              icon: "tool-artboard",
              primary: b.name,
              secondary: formatLengthPair(b.w, b.h, unit),
              selected: b.pageId === selectedId,
              onClick: () => select(b),
            }))}
          />
        </div>
      )}
      {selected ? (
        <section
          className="flex flex-col gap-2 px-[14px] py-2"
          data-artboard-options={selected.pageId}
          aria-label={strings.t(M.options)}
        >
          <div className="pg-ui-xs font-medium">{strings.t(M.options)}</div>
          <label className="flex items-center gap-2 pg-ui-xs">
            <span className="w-20">{strings.t(M.name)}</span>
            <input
              key={`${selected.pageId}:${selected.name}`}
              data-artboard-name
              className="h-[26px] flex-1 rounded-[6px] border border-input bg-background px-2"
              defaultValue={selected.named ? selected.name : ""}
              placeholder={selected.name}
              aria-label={strings.t(M.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={(e) => {
                const next = e.currentTarget.value.trim();
                const was = selected.named ? selected.name : "";
                if (next !== was) {
                  void write(renameArtboardMutation(selected.pageId, next));
                }
              }}
            />
          </label>
          <label className="flex items-center gap-2 pg-ui-xs">
            <span className="w-20">{strings.t(M.preset)}</span>
            <KitSelect
              aria-label={strings.t(M.preset)}
              data-artboard-preset
              value={preset}
              onChange={(e) => {
                const p = ARTBOARD_PRESETS.find((x) => x.id === e.target.value);
                if (!p) return;
                const [w, h] =
                  landscape === p.w > p.h || p.w === p.h
                    ? [p.w, p.h]
                    : [p.h, p.w];
                resizeTo(selected, w, h);
              }}
            >
              <option value="custom">{strings.t(M.custom)}</option>
              {ARTBOARD_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </KitSelect>
          </label>
          <div className="flex items-center gap-2 pg-ui-xs">
            <span className="w-20">{strings.t(M.width)}</span>
            <span data-artboard-width className="flex-1">
              <LengthInput
                aria-label={strings.t(M.width)}
                valuePt={selected.w}
                min={1}
                onChangePt={() => {}}
                onCommitPt={(w) => resizeTo(selected, w, selected.h)}
              />
            </span>
          </div>
          <div className="flex items-center gap-2 pg-ui-xs">
            <span className="w-20">{strings.t(M.height)}</span>
            <span data-artboard-height className="flex-1">
              <LengthInput
                aria-label={strings.t(M.height)}
                valuePt={selected.h}
                min={1}
                onChangePt={() => {}}
                onCommitPt={(h) => resizeTo(selected, selected.w, h)}
              />
            </span>
          </div>
          <div
            className="flex items-center gap-2 pg-ui-xs"
            role="group"
            aria-label={strings.t(M.orientation)}
          >
            <span className="w-20">{strings.t(M.orientation)}</span>
            {(["portrait", "landscape"] as const).map((o) => {
              const on = (o === "landscape") === landscape;
              return (
                <button
                  key={o}
                  type="button"
                  data-artboard-orientation={o}
                  aria-pressed={on}
                  className="h-[26px] rounded-[6px] border border-input px-2 hover:bg-muted/60"
                  style={{ background: on ? "var(--hover)" : undefined }}
                  onClick={() => {
                    if (!on) resizeTo(selected, selected.h, selected.w);
                  }}
                >
                  {strings.t(o === "portrait" ? M.portrait : M.landscape)}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      <section
        className="flex flex-col gap-2 px-[14px] py-2"
        data-artboard-rearrange
        aria-label={strings.t(M.rearrange)}
      >
        <div className="pg-ui-xs font-medium">{strings.t(M.rearrange)}</div>
        <div className="flex items-center gap-2 pg-ui-xs">
          <span className="w-20">{strings.t(M.columns)}</span>
          <span data-artboard-columns className="flex-1">
            <NumberInput
              aria-label={strings.t(M.columns)}
              value={columns}
              min={1}
              max={50}
              precision={0}
              onChange={(v) => setColumns(Math.max(1, Math.round(v)))}
            />
          </span>
        </div>
        <div className="flex items-center gap-2 pg-ui-xs">
          <span className="w-20">{strings.t(M.spacing)}</span>
          <span data-artboard-spacing className="flex-1">
            <LengthInput
              aria-label={strings.t(M.spacing)}
              valuePt={spacingPt}
              min={0}
              onChangePt={setSpacingPt}
            />
          </span>
        </div>
        <button
          type="button"
          data-artboard-rearrange-apply
          disabled={boards.length === 0}
          className="h-[28px] rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs"
          onClick={() =>
            void write(rearrangeMutation(boards, columns, spacingPt))
          }
        >
          {strings.t(M.rearrangeApply)}
        </button>
      </section>
      <section
        className="flex flex-col gap-2 px-[14px] py-2"
        data-artboard-export
        aria-label={strings.t(M.export)}
      >
        <div className="pg-ui-xs font-medium">{strings.t(M.export)}</div>
        <label className="flex items-center gap-2 pg-ui-xs">
          <span className="w-20">{strings.t(M.format)}</span>
          <KitSelect
            aria-label={strings.t(M.format)}
            data-artboard-export-format
            value={format}
            onChange={(e) =>
              setFormat(e.target.value === "pdf" ? "pdf" : "png")
            }
          >
            <option value="png">PNG</option>
            <option value="pdf">PDF</option>
          </KitSelect>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            data-artboard-export-selected
            disabled={!selected}
            className="h-[28px] flex-1 rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs disabled:opacity-50"
            onClick={() => selected && void exportBoards([selected])}
          >
            {strings.t(M.exportSelected)}
          </button>
          <button
            type="button"
            data-artboard-export-all
            disabled={boards.length === 0}
            className="h-[28px] flex-1 rounded-[6px] border border-input bg-background hover:bg-muted/60 pg-ui-xs"
            onClick={() => void exportBoards(boards)}
          >
            {strings.t(M.exportAll)}
          </button>
        </div>
        {status ? (
          <div
            className="pg-ui-xs text-muted-foreground"
            data-artboard-export-status
          >
            {status}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}
