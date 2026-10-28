// WP5.12 — the WORKSPACE section (image ADR 474): the ruler unit, Show /
// Lock / Snap to Guides, the Ruler tool's measurement and Straighten, the
// Count tool's groups, the Note tool's notes (their text is written here)
// and the Slice tool's slices; and View ▸ New Guide…'s dialog.
//
// The guides themselves are dragged out of the host's rulers and drawn by
// the host (extensions ADR 3XX); this section is where the image's own
// settings and lists live.

import { useState } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t } from "@paged-media/strings";
import { space } from "@paged-media/panel-kit";

import type { ImageSession } from "../../session";
import { RULER_UNITS, type RulerUnit } from "../../workspace";
import { Section } from "./disclosure";
import { mono, note, row, swatch } from "./styles";

const M = defineMessages("image.workspaceSection", {
  title: "Workspace",
  rulers: "Rulers",
  px: "Pixels",
  in: "Inches",
  cm: "Centimetres",
  mm: "Millimetres",
  showGuides: "Show guides",
  lockGuides: "Lock guides",
  snapToGuides: "Snap to guides",
  guides: "{count} guides",
  newGuide: "New guide…",
  clearGuides: "Clear guides",
  ruler: "Ruler",
  noRuler: "Drag with the Ruler tool to measure.",
  straighten: "Straighten",
  clear: "Clear",
  count: "Count",
  group: "Group",
  marks: "{count} marks",
  newGroup: "New group",
  visible: "Visible",
  deleteGroup: "Delete group",
  notes: "Notes",
  noNotes: "Click with the Note tool to pin a note.",
  noteText: "Note {n}",
  delete: "Delete",
  slices: "Slices",
  noSlices: "Drag with the Slice tool, or make slices from the guides.",
  fromGuides: "From guides",
  export: "Export…",
  guidesNote:
    "Drag a guide out of the ruler; drop it back on the ruler to delete it. " +
    "The grid is View ▸ Show grid and follows the image's resolution.",
  newGuideTitle: "New guide",
  orientation: "Orientation",
  horizontal: "Horizontal",
  vertical: "Vertical",
  position: "Position",
  ok: "OK",
  cancel: "Cancel",
});

const UNIT_WORD: Record<RulerUnit, () => string> = {
  px: () => t(M.px),
  in: () => t(M.in),
  cm: () => t(M.cm),
  mm: () => t(M.mm),
};

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function WorkspaceSection({
  session,
  disabled,
}: {
  session: ImageSession;
  disabled: boolean;
}) {
  const live = useLive(session, onDidChangeOf);
  const st = live.state();
  const ws = live.workspace().state();
  const w = session.workspace();
  const off = disabled || !st.source;
  const info = ws.info;
  const ruler = ws.ruler ? w.rulerReadout() : null;
  const group = info.counts[info.activeCount];
  return (
    <Section title={t(M.title)} data-image-workspace-section>
      <div style={row}>
        <label htmlFor="pg-image-ruler-unit">{t(M.rulers)}</label>
        <select
          id="pg-image-ruler-unit"
          data-image-ruler-unit
          value={ws.view.rulerUnit}
          disabled={off}
          onChange={(e) => w.setRulerUnit(e.target.value as RulerUnit)}
        >
          {RULER_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_WORD[u]()}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-image-show-guides
            checked={ws.view.guidesVisible}
            disabled={off}
            onChange={(e) => w.setGuidesVisible(e.target.checked)}
          />
          {t(M.showGuides)}
        </label>
        <label>
          <input
            type="checkbox"
            data-image-lock-guides
            checked={ws.view.guidesLocked}
            disabled={off}
            onChange={(e) => w.setGuidesLocked(e.target.checked)}
          />
          {t(M.lockGuides)}
        </label>
        <label>
          <input
            type="checkbox"
            data-image-snap-guides
            checked={ws.view.snapToGuides}
            disabled={off}
            onChange={(e) => w.setSnapToGuides(e.target.checked)}
          />
          {t(M.snapToGuides)}
        </label>
      </div>
      <div style={row}>
        <span data-image-guide-count style={mono}>
          {t(M.guides, { count: info.guides.length })}
        </span>
        <span style={{ display: "flex", gap: space[1] }}>
          <button
            type="button"
            data-image-new-guide
            disabled={off}
            onClick={() => session.openDialog("newGuide")}
          >
            {t(M.newGuide)}
          </button>
          <button
            type="button"
            data-image-clear-guides
            disabled={off || info.guides.length === 0}
            onClick={() => w.clearGuides()}
          >
            {t(M.clearGuides)}
          </button>
        </span>
      </div>
      <div style={note}>{t(M.guidesNote)}</div>

      <div style={{ ...row, marginTop: space[2] }}>
        <span style={{ fontWeight: 600 }}>{t(M.ruler)}</span>
        {ruler ? (
          <span data-image-ruler-readout style={mono}>
            {`${Number(ruler.distance.toFixed(2))} px · ${Number(ruler.angle.toFixed(1))}°`}
          </span>
        ) : (
          <span style={note}>{t(M.noRuler)}</span>
        )}
      </div>
      <div style={row}>
        <span />
        <span style={{ display: "flex", gap: space[1] }}>
          <button
            type="button"
            data-image-straighten
            disabled={off || !ruler}
            onClick={() => void w.straighten()}
          >
            {t(M.straighten)}
          </button>
          <button
            type="button"
            data-image-clear-ruler
            disabled={off || !ruler}
            onClick={() => w.setRuler(null)}
          >
            {t(M.clear)}
          </button>
        </span>
      </div>

      <div style={{ ...row, marginTop: space[2] }}>
        <span style={{ fontWeight: 600 }}>{t(M.count)}</span>
        <span data-image-count-total style={mono}>
          {t(M.marks, { count: group?.marks.length ?? 0 })}
        </span>
      </div>
      {info.counts.length > 0 && group && (
        <div style={row}>
          <label htmlFor="pg-image-count-group">{t(M.group)}</label>
          <span style={swatch(rgb(group.color))} />
          <select
            id="pg-image-count-group"
            data-image-count-group
            value={info.activeCount}
            disabled={off}
            onChange={(e) => w.setActiveCountGroup(Number(e.target.value))}
          >
            {info.counts.map((g, i) => (
              <option key={i} value={i}>
                {g.name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              data-image-count-visible
              checked={group.visible}
              disabled={off}
              onChange={(e) =>
                w.setCountGroup(info.activeCount, { visible: e.target.checked })
              }
            />
            {t(M.visible)}
          </label>
        </div>
      )}
      <div style={row}>
        <span />
        <span style={{ display: "flex", gap: space[1] }}>
          <button
            type="button"
            data-image-count-new-group
            disabled={off}
            onClick={() => w.newCountGroup()}
          >
            {t(M.newGroup)}
          </button>
          <button
            type="button"
            data-image-count-clear
            disabled={off || !group || group.marks.length === 0}
            onClick={() => w.clearCount()}
          >
            {t(M.clear)}
          </button>
          <button
            type="button"
            data-image-count-delete-group
            disabled={off || !group}
            onClick={() => w.deleteCountGroup(info.activeCount)}
          >
            {t(M.deleteGroup)}
          </button>
        </span>
      </div>

      <div style={{ ...row, marginTop: space[2] }}>
        <span style={{ fontWeight: 600 }}>{t(M.notes)}</span>
      </div>
      {info.notes.length === 0 ? (
        <div style={note}>{t(M.noNotes)}</div>
      ) : (
        info.notes.map((n, i) => (
          <div key={i} style={{ ...row, alignItems: "flex-start" }}>
            <textarea
              aria-label={t(M.noteText, { n: i + 1 })}
              data-image-note-text={i}
              defaultValue={n.text}
              rows={2}
              disabled={off}
              style={{ flex: 1 }}
              onBlur={(e) => {
                if (e.target.value !== n.text) w.editNote(i, e.target.value);
              }}
            />
            <button
              type="button"
              data-image-note-delete={i}
              disabled={off}
              onClick={() => w.deleteNote(i)}
            >
              {t(M.delete)}
            </button>
          </div>
        ))
      )}

      <div style={{ ...row, marginTop: space[2] }}>
        <span style={{ fontWeight: 600 }}>{t(M.slices)}</span>
        <span style={{ display: "flex", gap: space[1] }}>
          <button
            type="button"
            data-image-slices-from-guides
            disabled={off || info.guides.length === 0}
            onClick={() => w.slicesFromGuides()}
          >
            {t(M.fromGuides)}
          </button>
          <button
            type="button"
            data-image-slices-export
            disabled={off || info.slices.length === 0}
            onClick={() => void w.exportSlices()}
          >
            {t(M.export)}
          </button>
        </span>
      </div>
      {info.slices.length === 0 ? (
        <div style={note}>{t(M.noSlices)}</div>
      ) : (
        info.slices.map((s, i) => (
          <div key={`${i}:${s.name}`} style={row} data-image-slice={s.name}>
            <input
              aria-label={s.name}
              data-image-slice-name={i}
              defaultValue={s.name}
              disabled={off}
              style={{ width: 96 }}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== s.name) w.setSlice(i, s, name);
              }}
            />
            <span style={mono}>{`${s.x},${s.y} ${s.w}×${s.h}`}</span>
            <button
              type="button"
              data-image-slice-delete={i}
              disabled={off}
              onClick={() => w.deleteSlice(i)}
            >
              {t(M.delete)}
            </button>
          </div>
        ))
      )}
    </Section>
  );
}

/** View ▸ New Guide…: an orientation and a position in the ruler unit. */
export function NewGuideDialog({
  unit,
  pxPerUnit,
  onAdd,
  onCancel,
}: {
  unit: RulerUnit;
  pxPerUnit: number;
  onAdd: (orientation: "horizontal" | "vertical", px: number) => void;
  onCancel: () => void;
}) {
  const [vertical, setVertical] = useState(true);
  const [value, setValue] = useState(0);
  return (
    <section
      role="dialog"
      aria-label={t(M.newGuideTitle)}
      data-image-new-guide-dialog
      style={{
        border: "1px solid var(--pg-border)",
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: space[1] }}>
        {t(M.newGuideTitle)}
      </div>
      <div style={row}>
        <span>{t(M.orientation)}</span>
        <label>
          <input
            type="radio"
            name="pg-image-guide-dir"
            data-image-guide-dir="horizontal"
            checked={!vertical}
            onChange={() => setVertical(false)}
          />
          {t(M.horizontal)}
        </label>
        <label>
          <input
            type="radio"
            name="pg-image-guide-dir"
            data-image-guide-dir="vertical"
            checked={vertical}
            onChange={() => setVertical(true)}
          />
          {t(M.vertical)}
        </label>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-guide-position">{t(M.position)}</label>
        <span>
          <input
            id="pg-image-guide-position"
            type="number"
            step={unit === "px" ? 1 : 0.01}
            data-image-guide-position
            value={value}
            style={{ width: 80 }}
            onChange={(e) => setValue(Number(e.target.value))}
          />{" "}
          {unit}
        </span>
      </div>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button type="button" data-dialog-cancel onClick={onCancel}>
          {t(M.cancel)}
        </button>
        <button
          type="button"
          data-image-guide-add
          disabled={!Number.isFinite(value)}
          onClick={() =>
            onAdd(vertical ? "vertical" : "horizontal", value * pxPerUnit)
          }
        >
          {t(M.ok)}
        </button>
      </div>
    </section>
  );
}
