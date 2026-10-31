// THE FILTER GALLERY WORKSPACE (WP5.2): Photoshop's Filter Gallery — the
// effects by category on one side, the stack of EFFECT LAYERS below, the
// active layer's settings. The stack applies bottom to top as one filter
// (one undo step); each layer has an eye, and layers can be added (a copy
// of the active one, as Photoshop's New Effect Layer does), removed and
// reordered. Choosing an effect sets the ACTIVE layer's effect.
//
// The workspace edits the dialog's flat values (`filters-gallery.ts`:
// `stack` and `"<layer>.<key>"`), so the preview, OK and Cancel are the
// Filter dialog's own.

import { useState, type ReactNode } from "react";
import { defineMessages, t } from "@paged-media/strings";
import { color, space } from "@paged-media/panel-kit";

import type { FilterDef, FilterValue } from "../../filters";
import {
  FG,
  GALLERY_CATEGORIES,
  GALLERY_CATEGORY,
  galleryLayers,
  galleryValues,
  type GalleryLayer,
} from "../../filters-gallery";
import { kicker, row } from "./styles";

const M = defineMessages("image.filterGallery", {
  hidden: "Hidden",
  visible: "Visible",
});

const defaultsOf = (def: FilterDef): Record<string, FilterValue> =>
  Object.fromEntries(def.params.map((p) => [p.key, p.default]));

export function GalleryWorkspace({
  effects,
  values,
  onValues,
  renderParams,
}: {
  effects: readonly FilterDef[];
  values: Readonly<Record<string, FilterValue>>;
  onValues: (patch: Record<string, FilterValue>) => void;
  renderParams: (
    def: FilterDef,
    values: Record<string, FilterValue>,
    onChange: (patch: Record<string, FilterValue>) => void,
  ) => ReactNode;
}) {
  const layers = galleryLayers(values, effects);
  const [picked, setActive] = useState(Math.max(0, layers.length - 1));
  const active = Math.min(picked, Math.max(0, layers.length - 1));
  const layer = layers[active];
  const def = layer ? effects.find((d) => d.id === layer.effect) : undefined;
  // The stack's keys are positional, so a change rewrites them all (keys
  // past a shorter stack stay behind unread: `stack` says how many count).
  const commit = (next: GalleryLayer[]) =>
    onValues(galleryValues(next, effects));
  const setLayer = (i: number, l: GalleryLayer) =>
    commit(layers.map((x, j) => (j === i ? l : x)));

  return (
    <div data-filter-gallery>
      <div style={{ display: "flex", flexWrap: "wrap", gap: space[2] }}>
        {GALLERY_CATEGORIES.map((cat) => (
          <div key={cat} style={{ minWidth: "9em" }}>
            <div style={kicker}>{t(cat)}</div>
            {effects
              .filter((d) => GALLERY_CATEGORY[d.id] === cat)
              .map((d) => (
                <button
                  key={d.id}
                  type="button"
                  data-filter-gallery-effect={d.id}
                  aria-pressed={layer?.effect === d.id}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    fontWeight: layer?.effect === d.id ? 600 : 400,
                  }}
                  onClick={() => {
                    if (!layer) {
                      commit([
                        { effect: d.id, visible: true, values: defaultsOf(d) },
                      ]);
                      return;
                    }
                    setLayer(active, {
                      effect: d.id,
                      visible: layer.visible,
                      values: defaultsOf(d),
                    });
                  }}
                >
                  {t(d.label)}
                </button>
              ))}
          </div>
        ))}
      </div>
      {def && layer && (
        <div style={{ marginTop: space[2] }}>
          <div style={{ fontWeight: 600 }}>{t(def.label)}</div>
          {renderParams(def, layer.values, (patch) =>
            setLayer(active, {
              ...layer,
              values: { ...layer.values, ...patch },
            }),
          )}
        </div>
      )}
      <div style={{ ...kicker, marginTop: space[2] }}>{t(FG.effectLayers)}</div>
      <ol
        data-filter-gallery-layers
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          border: `1px solid ${color.border}`,
        }}
      >
        {/* Top of the stack first, as Photoshop lists them. */}
        {layers
          .map((l, i) => ({ l, i }))
          .reverse()
          .map(({ l, i }) => {
            const d = effects.find((x) => x.id === l.effect);
            return (
              <li
                key={i}
                data-filter-gallery-layer={i}
                aria-current={i === active}
                style={{
                  ...row,
                  background: i === active ? color.primarySoft : undefined,
                }}
              >
                <input
                  type="checkbox"
                  aria-label={t(l.visible ? M.visible : M.hidden)}
                  data-filter-gallery-eye={i}
                  checked={l.visible}
                  onChange={(e) =>
                    setLayer(i, { ...l, visible: e.target.checked })
                  }
                />
                <button
                  type="button"
                  data-filter-gallery-select={i}
                  style={{ flex: 1, textAlign: "left" }}
                  onClick={() => setActive(i)}
                >
                  {d ? t(d.label) : l.effect}
                </button>
              </li>
            );
          })}
      </ol>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button
          type="button"
          data-filter-gallery-new
          title={t(FG.newEffectLayer)}
          disabled={!layer}
          onClick={() => {
            if (!layer) return;
            const next = [...layers];
            next.splice(active + 1, 0, {
              ...layer,
              values: { ...layer.values },
            });
            commit(next);
            setActive(active + 1);
          }}
        >
          {t(FG.newEffectLayer)}
        </button>
        <button
          type="button"
          data-filter-gallery-delete
          disabled={layers.length <= 1}
          onClick={() => {
            commit(layers.filter((_, j) => j !== active));
            setActive(Math.max(0, active - 1));
          }}
        >
          {t(FG.deleteEffectLayer)}
        </button>
        <button
          type="button"
          data-filter-gallery-up
          disabled={active >= layers.length - 1}
          onClick={() => {
            const next = [...layers];
            [next[active], next[active + 1]] = [
              next[active + 1]!,
              next[active]!,
            ];
            commit(next);
            setActive(active + 1);
          }}
        >
          {t(FG.moveUp)}
        </button>
        <button
          type="button"
          data-filter-gallery-down
          disabled={active <= 0}
          onClick={() => {
            const next = [...layers];
            [next[active - 1], next[active]] = [
              next[active]!,
              next[active - 1]!,
            ];
            commit(next);
            setActive(active - 1);
          }}
        >
          {t(FG.moveDown)}
        </button>
      </div>
    </div>
  );
}
