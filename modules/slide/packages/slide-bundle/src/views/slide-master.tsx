/*
 * This file is part of paged (https://paged.media).
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

// View ▸ Slide Master (slide ADR 712): the deck's slide masters, each with
// its layouts under it, in place of the canvas (a module view). The rail
// on the left lists them with a thumbnail of each (the engine draws a
// master page as a page, over the master it is based on); the selected one
// is shown large, with its placeholders, and the bar edits it: Insert
// Placeholder, Rename, Preserve, Delete (a layout no slide uses), and the
// text style of a placeholder, which the slides made from the layout follow
// where they kept the layout's. Every change is one undo step.

import type {
  BundleHost,
  MutationInput,
  ViewProps,
} from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { color } from "@paged-media/panel-kit";

import {
  deleteLayoutMutation,
  deletePlaceholderMutation,
  insertPlaceholderMutation,
  placeholderStyleMutation,
  PLACEHOLDER_TYPES,
  preserveMutation,
  readMasters,
  renameMutation,
  type MasterSpread,
} from "../masters-model.js";
import { MASTERS } from "../messages.js";

const PH_LABEL: Record<string, keyof typeof MASTERS> = {
  body: "phBody",
  title: "phTitle",
  pic: "phPic",
  chart: "phChart",
  tbl: "phTbl",
  media: "phMedia",
  dt: "phDt",
  ftr: "phFtr",
  sldNum: "phSldNum",
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  padding: "8px 12px",
  borderBottom: `1px solid ${color.border}`,
  background: "var(--pg-bg, #fff)",
};

/** Thumbnails of master pages, kept until the document changes. */
class Thumbs {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Set<string>();
  constructor(
    private readonly host: BundleHost,
    private readonly changed: () => void,
  ) {}
  get(pageId: string, widthPx: number): string | null {
    const key = `${pageId}@${widthPx}`;
    const hit = this.urls.get(key);
    if (hit) return hit;
    if (this.pending.has(key) || !this.host.supports("render.snapshot@1"))
      return null;
    this.pending.add(key);
    void this.host.render
      .snapshot(pageId, { widthPx })
      .then((shot) => {
        if (!shot) return;
        this.urls.set(
          key,
          URL.createObjectURL(
            new Blob([shot.png as Uint8Array<ArrayBuffer>], {
              type: "image/png",
            }),
          ),
        );
        this.changed();
      })
      .catch(() => {})
      .finally(() => this.pending.delete(key));
    return null;
  }
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

export function makeSlideMaster(
  host: BundleHost,
): React.ComponentType<ViewProps> {
  const mutate = (m: MutationInput | null) => {
    if (!m) return;
    void host.document
      .mutate(m)
      .then((out) => {
        if (!out.applied)
          host.log.warn(
            `paged.slide master view: refused (${JSON.stringify(out.error)})`,
          );
      })
      .catch((e) => host.log.warn(`paged.slide master view: ${String(e)}`));
  };

  const View: React.FC<ViewProps> = ({ close }) => {
    const { t } = useStrings();
    const [masters, setMasters] = React.useState<MasterSpread[] | null>(null);
    const [selected, setSelected] = React.useState<string | null>(null);
    const [phType, setPhType] = React.useState<string>("body");
    const [size, setSize] = React.useState<string>("");
    const [fontStyle, setFontStyle] = React.useState<string>("");
    const [styled, setStyled] = React.useState<string | null>(null);
    const [, repaint] = React.useReducer((n: number) => n + 1, 0);
    const [thumbs] = React.useState(() => new Thumbs(host, repaint));

    React.useEffect(() => {
      let live = true;
      const load = () =>
        void readMasters(host).then((m) => {
          if (live) setMasters(m);
        });
      load();
      const sub = host.document.onDidChange(() => {
        thumbs.clear();
        load();
      });
      return () => {
        live = false;
        sub.dispose();
        thumbs.clear();
      };
    }, [thumbs]);

    if (masters === null) return <div data-slide-master="loading" />;
    if (masters.length === 0)
      return (
        <div data-slide-master="empty" style={{ padding: 24, opacity: 0.7 }}>
          {t(MASTERS.empty)}
        </div>
      );
    const current =
      masters.find((m) => m.masterId === selected) ??
      masters.find((m) => m.kind === "layout") ??
      masters[0]!;
    const deletable = deleteLayoutMutation(current, masters);
    const ph =
      current.placeholders.find((p) => p.shape === styled) ??
      current.placeholders[0] ??
      null;
    const [w, h] = current.sizePt;

    return (
      <div
        data-slide-master="ready"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <div style={bar} role="toolbar" aria-label={t(MASTERS.slideMaster)}>
          <button type="button" data-master="close" onClick={close}>
            {t(MASTERS.closeMaster)}
          </button>
          <span style={{ width: 12 }} />
          <label style={{ fontSize: 12 }}>
            {t(MASTERS.insertPlaceholder)}{" "}
            <select
              data-master="placeholder-type"
              value={phType}
              onChange={(e) => setPhType(e.target.value)}
            >
              {PLACEHOLDER_TYPES.map((k) => (
                <option key={k} value={k}>
                  {t(MASTERS[PH_LABEL[k]!])}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-master="insert-placeholder"
            disabled={current.kind !== "layout"}
            onClick={() => mutate(insertPlaceholderMutation(current, phType))}
          >
            {t(MASTERS.insertPlaceholder)}
          </button>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              data-master="preserve"
              checked={current.preserve}
              onChange={(e) =>
                mutate(preserveMutation(current, e.target.checked))
              }
            />{" "}
            {t(MASTERS.preserve)}
          </label>
          <button
            type="button"
            data-master="delete"
            disabled={typeof deletable === "string"}
            title={typeof deletable === "string" ? deletable : undefined}
            onClick={() => typeof deletable !== "string" && mutate(deletable)}
          >
            {t(MASTERS.deleteLayout)}
          </button>
        </div>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div
            role="listbox"
            aria-label={t(MASTERS.slideMaster)}
            style={{
              width: 220,
              overflowY: "auto",
              borderRight: `1px solid ${color.border}`,
              padding: 8,
            }}
          >
            {masters.map((m) => (
              <div
                key={m.masterId}
                role="option"
                aria-selected={m.masterId === current.masterId}
                data-master-row={m.masterId}
                data-master-kind={m.kind}
                onClick={() => setSelected(m.masterId)}
                style={{
                  marginLeft: m.kind === "layout" ? 24 : 0,
                  marginBottom: 8,
                  cursor: "pointer",
                  outline:
                    m.masterId === current.masterId
                      ? "3px solid var(--overlay-selection, #e0218a)"
                      : `1px solid ${color.border}`,
                }}
              >
                <div
                  style={{
                    aspectRatio: `${m.sizePt[0]} / ${m.sizePt[1]}`,
                    background: color.muted,
                  }}
                >
                  {thumbs.get(m.pageId, 240) && (
                    <img
                      src={thumbs.get(m.pageId, 240)!}
                      alt=""
                      style={{ width: "100%", display: "block" }}
                    />
                  )}
                </div>
                <div style={{ fontSize: 11, padding: "2px 4px" }}>
                  {m.name}
                  <span style={{ opacity: 0.6 }}>
                    {" · "}
                    {m.kind === "master"
                      ? t(MASTERS.master)
                      : m.slides > 0
                        ? t(MASTERS.usedBy, { count: m.slides })
                        : t(MASTERS.unused)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            <input
              key={`${current.masterId}:${current.name}`}
              aria-label={t(MASTERS.rename)}
              data-master="name"
              defaultValue={current.name}
              style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                if (e.target.value.trim() !== current.name)
                  mutate(renameMutation(current.masterId, e.target.value));
              }}
            />
            <div
              data-master-preview={current.masterId}
              style={{
                maxWidth: 800,
                aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9",
                background: color.muted,
                border: `1px solid ${color.border}`,
              }}
            >
              {thumbs.get(current.pageId, 960) && (
                <img
                  src={thumbs.get(current.pageId, 960)!}
                  alt=""
                  style={{ width: "100%", display: "block" }}
                />
              )}
            </div>
            <h3 style={{ fontSize: 12, margin: "12px 0 4px" }}>
              {t(MASTERS.placeholders)}
            </h3>
            <ul
              data-master="placeholders"
              style={{ listStyle: "none", padding: 0, margin: 0 }}
            >
              {current.placeholders.map((p) => (
                <li
                  key={p.shape || p.elements[0]!.id}
                  data-placeholder={p.type}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 12,
                    padding: "2px 0",
                    fontWeight: ph === p ? 600 : 400,
                  }}
                >
                  <span
                    style={{ cursor: "pointer", flex: 1 }}
                    onClick={() => setStyled(p.shape)}
                  >
                    {t(MASTERS[PH_LABEL[p.type] ?? "phBody"])} · {p.name}
                  </span>
                  <button
                    type="button"
                    data-placeholder-delete
                    title={t(MASTERS.deletePlaceholder)}
                    onClick={() =>
                      mutate(deletePlaceholderMutation(current, p))
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {ph && (
              <div
                data-master="style"
                style={{ display: "flex", gap: 8, marginTop: 8, fontSize: 12 }}
              >
                <label>
                  {t(MASTERS.textSize)}{" "}
                  <input
                    data-master="style-size"
                    type="number"
                    min={1}
                    style={{ width: 60 }}
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                  />
                </label>
                <label>
                  {t(MASTERS.textStyle)}{" "}
                  <select
                    data-master="style-font"
                    value={fontStyle}
                    onChange={(e) => setFontStyle(e.target.value)}
                  >
                    <option value="">—</option>
                    {["Regular", "Bold", "Italic", "Bold Italic"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  data-master="style-apply"
                  disabled={size === "" && fontStyle === ""}
                  onClick={() =>
                    void placeholderStyleMutation(host, current, ph, {
                      ...(size !== "" && Number(size) > 0
                        ? { size: Number(size) }
                        : {}),
                      ...(fontStyle !== "" ? { fontStyle } : {}),
                    }).then(mutate)
                  }
                >
                  {t(MASTERS.apply)}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };
  return View;
}
