// MORE FILTERS (WP5.2) — the panel's reach to the families the Filter
// menu gained: one choice per group (Distort, Render, Stylize, Pixelate,
// the Filter Gallery's effects, Adjust), the two workspaces, and the
// filters Photoshop runs without a dialog (Solarize, Facet, Desaturate,
// Equalize). Each choice opens the same Filter dialog the menu does.

import { defineMessages, t } from "@paged-media/strings";

import type { FilterDef, FilterGroup, FilterId } from "../../filters";
import { BLUR_KINDS, BG, type BlurKind } from "../../filters-blur-gallery";
import type { OneShotFilter } from "../../session";
import { row, sectionTitle } from "./styles";

const M = defineMessages("image.moreFilters", {
  title: "More filters",
  choose: "Choose…",
  filterGallery: "Filter gallery…",
  blurGallery: "Blur gallery",
  solarize: "Solarize",
  facet: "Facet",
  desaturate: "Desaturate",
  equalize: "Equalize",
  distort: "Distort",
  render: "Render",
  stylize: "Stylize",
  pixelate: "Pixelate",
  gallery: "Filter gallery",
  adjust: "Adjust",
});

const GROUPS: ReadonlyArray<readonly [FilterGroup, string]> = [
  ["Distort", M.distort],
  ["Render", M.render],
  ["Stylize", M.stylize],
  ["Pixelate", M.pixelate],
  ["Filter Gallery", M.gallery],
  ["Adjust", M.adjust],
];

const BLUR_LABEL: Record<BlurKind, string> = {
  field: BG.field,
  iris: BG.iris,
  tilt: BG.tiltShift,
  path: BG.path,
  spin: BG.spin,
};

const ONE_SHOTS: ReadonlyArray<readonly [OneShotFilter, string]> = [
  ["solarize", M.solarize],
  ["facet", M.facet],
  ["desaturate", M.desaturate],
  ["equalize", M.equalize],
];

export function MoreFilters({
  filters,
  disabled,
  onOpen,
  onOneShot,
  onBlurGallery,
}: {
  filters: readonly FilterDef[];
  disabled: boolean;
  onOpen: (id: FilterId) => void;
  onOneShot: (kind: OneShotFilter) => void;
  onBlurGallery: (kind: BlurKind) => void;
}) {
  return (
    <section data-image-more-filters>
      <div style={sectionTitle}>{t(M.title)}</div>
      {GROUPS.map(([group, label]) => {
        const items = filters.filter(
          (f) => f.group === group && f.id !== "filterGallery",
        );
        if (items.length === 0) return null;
        const id = `pg-more-filters-${group.replace(/\s/g, "-")}`;
        return (
          <div key={group} style={row}>
            <label htmlFor={id}>{t(label)}</label>
            <select
              id={id}
              data-image-more-filters-group={group}
              disabled={disabled}
              value=""
              onChange={(e) => {
                if (e.target.value) onOpen(e.target.value as FilterId);
              }}
            >
              <option value="">{t(M.choose)}</option>
              {items.map((f) => (
                <option key={f.id} value={f.id}>
                  {t(f.label)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <div style={row}>
        <span>{t(M.blurGallery)}</span>
        <span>
          {BLUR_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              data-image-blur-gallery={k}
              disabled={disabled}
              onClick={() => onBlurGallery(k)}
            >
              {t(BLUR_LABEL[k])}…
            </button>
          ))}
        </span>
      </div>
      <div style={{ ...row, flexWrap: "wrap" }}>
        <button
          type="button"
          data-image-filter-gallery
          disabled={disabled}
          onClick={() => onOpen("filterGallery")}
        >
          {t(M.filterGallery)}
        </button>
        {ONE_SHOTS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            data-image-one-shot={k}
            disabled={disabled}
            onClick={() => onOneShot(k)}
          >
            {t(label)}
          </button>
        ))}
      </div>
    </section>
  );
}
