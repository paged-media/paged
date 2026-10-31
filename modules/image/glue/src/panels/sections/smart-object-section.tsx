// SMART OBJECT (image ADR 482) — convert the active layer; the source
// (Edit Contents, Replace, Relink, Embed, Export); the placement (scale,
// and Layer ▸ Smart objects ▸ Transform…); the SMART FILTERS with their
// switches, opacity, order and filter mask; and, while a smart object's
// contents are open, the banner that saves or discards them.

import { useState } from "react";

import type { ImageSession } from "../../session";
import type { SmartInfo, TransformFields } from "../../smart-engine";
import { IDENTITY_FIELDS } from "../../smart-engine";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.smartObject", {
  title: "Smart object",
  convert: "Convert active layer",
  smart: "smart",
  pixels: "pixels",
  scale: "Scale",
  render: "Render",
  note:
    "A smart object keeps its original pixels. Scaling re-renders from them, " +
    "so shrinking and then enlarging again loses nothing.",
  source: "Source",
  linked: "linked",
  missing: "missing",
  embeddedFile: "embedded",
  pixelsSource: "its own pixels",
  vectorSource: "page items",
  editContents: "Edit contents",
  replace: "Replace…",
  relink: "Relink…",
  embed: "Embed",
  export: "Export…",
  transform: "Transform…",
  warped:
    "Its warp is Photoshop's: paged keeps the stored render until the object is transformed again.",
  filters: "Smart filters",
  filtersOn: "Smart filters on",
  opacity: "Opacity",
  up: "Move up",
  down: "Move down",
  remove: "Delete",
  unknown: "no counterpart in paged",
  pending: "The filters run when WebGPU is available.",
  mask: "Filter mask",
  maskOn: "Filter mask on",
  maskFromSelection: "From selection",
  maskInvert: "Invert",
  maskClear: "Clear",
  nested: "Editing the contents of “{name}”.",
  saveClose: "Save and close",
  discard: "Close without saving",
  noFilters: "Any filter applied to a smart object becomes a smart filter.",
});

const D = defineMessages("image.smartTransform", {
  title: "Transform smart object",
  scaleX: "Width %",
  scaleY: "Height %",
  rotate: "Rotate °",
  skewX: "Skew horizontal °",
  skewY: "Skew vertical °",
  moveX: "Move x px",
  moveY: "Move y px",
  flipH: "Flip horizontal",
  flipV: "Flip vertical",
  ok: "OK",
  cancel: "Cancel",
  note: "The object is re-rendered from its source: no quality is lost, whatever you do.",
});

const box = {
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: space[2],
  margin: `${space[2]} 0`,
} as const;
const numberStyle = { width: 64, font: `11px ${font.mono}` } as const;

function sourceText(info: SmartInfo): string {
  if (info.vector) return t(M.vectorSource);
  if (!info.file) return t(M.pixelsSource);
  const f = info.file;
  const kind = f.linked ? t(M.linked) : t(M.embeddedFile);
  return `${f.name} · ${kind}${f.available ? "" : ` · ${t(M.missing)}`}`;
}

export function SmartObjectSection({
  session,
  active,
  isSmart,
  gpu,
  disabled,
  scale,
  onScale,
  info,
  nested,
}: {
  session: ImageSession;
  active: number;
  isSmart: boolean;
  gpu: boolean;
  disabled: boolean;
  scale: number;
  onScale: (v: number) => void;
  /** The active smart object's state (null for any other layer). */
  info?: SmartInfo | null;
  /** The smart object whose contents are open, or null. */
  nested?: string | null;
}) {
  // The controller is reached in the handlers, not during render.
  const smart = () => session.smart();
  const filters = info?.filters ?? null;
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      {nested ? (
        <div style={box} data-image-smart-nested>
          <div style={note}>{t(M.nested, { name: nested })}</div>
          <div style={row}>
            <button
              type="button"
              data-image-smart-save-close
              disabled={disabled}
              onClick={() => void smart().closeContents(true)}
            >
              {t(M.saveClose)}
            </button>
            <button
              type="button"
              data-image-smart-discard
              disabled={disabled}
              onClick={() => void smart().closeContents(false)}
            >
              {t(M.discard)}
            </button>
          </div>
        </div>
      ) : null}
      <div style={row}>
        <button
          type="button"
          data-image-make-smart
          disabled={disabled || active < 0 || isSmart}
          onClick={() => void session.makeLayerSmart(active)}
        >
          {t(M.convert)}
        </button>
        <span style={mono}>{t(isSmart ? M.smart : M.pixels)}</span>
      </div>
      {info ? (
        <div style={row} data-image-smart-source>
          <span>{t(M.source)}</span>
          <span style={mono}>{sourceText(info)}</span>
        </div>
      ) : null}
      {info ? (
        <div style={row}>
          <button
            type="button"
            data-image-smart-edit-contents
            disabled={disabled || !!info.vector}
            onClick={() => void smart().openContents(active)}
          >
            {t(M.editContents)}
          </button>
          <button
            type="button"
            data-image-smart-replace
            disabled={disabled}
            onClick={() => void smart().replaceContents(active)}
          >
            {t(M.replace)}
          </button>
          <button
            type="button"
            data-image-smart-relink
            disabled={disabled}
            onClick={() => void smart().relink(active)}
          >
            {t(M.relink)}
          </button>
          <button
            type="button"
            data-image-smart-embed
            disabled={disabled || !info.file?.linked}
            onClick={() => void smart().embed(active)}
          >
            {t(M.embed)}
          </button>
          <button
            type="button"
            data-image-smart-export
            disabled={disabled}
            onClick={() => void smart().exportContents(active)}
          >
            {t(M.export)}
          </button>
        </div>
      ) : null}
      <div style={row}>
        <label htmlFor="pg-image-smart-scale">{t(M.scale)}</label>
        <input
          id="pg-image-smart-scale"
          type="range"
          min={0.1}
          max={2}
          step={0.05}
          value={scale}
          disabled={!isSmart}
          onChange={(e) => onScale(Number(e.target.value))}
        />
        <span style={mono}>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          data-image-render-smart
          disabled={disabled || !isSmart}
          onClick={() => void session.renderLayerSmart(active, scale)}
        >
          {t(M.render)}
        </button>
        <button
          type="button"
          data-image-smart-transform
          disabled={disabled || !isSmart}
          onClick={() => session.openDialog("smartTransform")}
        >
          {t(M.transform)}
        </button>
      </div>
      {info?.warped ? <div style={note}>{t(M.warped)}</div> : null}
      {info ? (
        <div data-image-smart-filters>
          <div style={row}>
            <label>
              <input
                type="checkbox"
                data-image-smart-filters-on
                checked={filters?.enabled ?? true}
                disabled={disabled || !filters}
                onChange={(e) =>
                  void smart().setFiltersEnabled(active, e.target.checked)
                }
              />
              {t(M.filters)}
            </label>
          </div>
          {(filters?.filters ?? []).map((f, i) => (
            <div style={row} key={`${i}-${f.id}`} data-image-smart-filter={i}>
              <input
                type="checkbox"
                aria-label={f.name}
                data-image-smart-filter-toggle={i}
                checked={f.enabled}
                disabled={disabled}
                onChange={(e) =>
                  void smart().setFilter(active, i, {
                    enabled: e.target.checked,
                  })
                }
              />
              <span>{f.name}</span>
              {f.known ? null : <span style={mono}>{t(M.unknown)}</span>}
              <input
                type="number"
                aria-label={t(M.opacity)}
                data-image-smart-filter-opacity={i}
                min={0}
                max={100}
                step={1}
                style={numberStyle}
                value={Math.round(f.opacity * 100)}
                disabled={disabled}
                onChange={(e) =>
                  void smart().setFilter(active, i, {
                    opacity: Number(e.target.value) / 100,
                  })
                }
              />
              <button
                type="button"
                aria-label={t(M.up)}
                data-image-smart-filter-up={i}
                disabled={disabled || i === 0}
                onClick={() => void smart().moveFilter(active, i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={t(M.down)}
                data-image-smart-filter-down={i}
                disabled={disabled || i + 1 >= (filters?.filters.length ?? 0)}
                onClick={() => void smart().moveFilter(active, i, i + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                data-image-smart-filter-delete={i}
                disabled={disabled}
                onClick={() => void smart().removeFilter(active, i)}
              >
                {t(M.remove)}
              </button>
            </div>
          ))}
          {filters ? (
            <div style={row} data-image-smart-filter-mask>
              <label>
                <input
                  type="checkbox"
                  data-image-smart-mask-on
                  checked={filters.maskEnabled}
                  disabled={disabled}
                  onChange={(e) =>
                    void smart().setFilterMaskEnabled(active, e.target.checked)
                  }
                />
                {t(M.mask)}
              </label>
              <button
                type="button"
                data-image-smart-mask-selection
                disabled={disabled}
                onClick={() => void smart().filterMask(active, "selection")}
              >
                {t(M.maskFromSelection)}
              </button>
              <button
                type="button"
                data-image-smart-mask-invert
                disabled={disabled}
                onClick={() => void smart().filterMask(active, "invert")}
              >
                {t(M.maskInvert)}
              </button>
              <button
                type="button"
                data-image-smart-mask-clear
                disabled={disabled || !filters.hasMask}
                onClick={() => void smart().filterMask(active, "clear")}
              >
                {t(M.maskClear)}
              </button>
            </div>
          ) : (
            <div style={note}>{t(M.noFilters)}</div>
          )}
          {info.pendingFilters && !gpu ? (
            <div style={note}>{t(M.pending)}</div>
          ) : null}
        </div>
      ) : null}
      <div style={note}>{t(M.note)}</div>
    </>
  );
}

/** Layer ▸ Smart objects ▸ Transform… — Free Transform's numeric fields
 *  about the object's centre. OK is one undo step. */
export function SmartTransformDialog({
  busy,
  onApply,
  onCancel,
}: {
  busy: boolean;
  onApply: (f: TransformFields) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<TransformFields>({ ...IDENTITY_FIELDS });
  const field = (k: keyof TransformFields, label: string) => (
    <div style={row} key={k}>
      <label htmlFor={`pg-image-smart-tx-${k}`}>{t(label)}</label>
      <input
        id={`pg-image-smart-tx-${k}`}
        type="number"
        step={k.startsWith("scale") ? 1 : 0.1}
        style={numberStyle}
        data-image-smart-tx={k}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
      />
    </div>
  );
  const ok =
    Object.values(f).every(Number.isFinite) && f.scaleX !== 0 && f.scaleY !== 0;
  return (
    <section
      role="dialog"
      aria-label={t(D.title)}
      data-image-smart-transform-dialog
      style={box}
    >
      <div style={{ fontWeight: 600, marginBottom: space[1] }}>
        {t(D.title)}
      </div>
      {field("scaleX", D.scaleX)}
      {field("scaleY", D.scaleY)}
      {field("rotate", D.rotate)}
      {field("skewX", D.skewX)}
      {field("skewY", D.skewY)}
      {field("moveX", D.moveX)}
      {field("moveY", D.moveY)}
      <div style={row}>
        <button
          type="button"
          data-image-smart-tx-flip-h
          onClick={() => setF({ ...f, scaleX: -f.scaleX })}
        >
          {t(D.flipH)}
        </button>
        <button
          type="button"
          data-image-smart-tx-flip-v
          onClick={() => setF({ ...f, scaleY: -f.scaleY })}
        >
          {t(D.flipV)}
        </button>
      </div>
      <div style={note}>{t(D.note)}</div>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button type="button" data-dialog-cancel onClick={onCancel}>
          {t(D.cancel)}
        </button>
        <button
          type="button"
          data-image-smart-tx-apply
          disabled={busy || !ok}
          onClick={() => onApply(f)}
        >
          {t(D.ok)}
        </button>
      </div>
    </section>
  );
}
