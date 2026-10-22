// FILTERS — Median, Maximum, Minimum (3×3) and Color Lookup (.cube).

import type { ImageSession } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.rankLookup", {
  title: "Median / Maximum / Minimum",
  median: "Median",
  maximum: "Maximum",
  minimum: "Minimum",
  lookup: "Color Lookup (.cube)",
  note:
    "Median, Maximum and Minimum work on a 3×3 neighbourhood. A lookup table " +
    "is applied at 9×9×9 lattice points (larger tables are resampled to " +
    "that).",
});

export function RankLookupSection({
  session,
  gpu,
  disabled,
  lookupName,
  onLookupFile,
}: {
  session: ImageSession;
  gpu: boolean;
  disabled: boolean;
  /** The last .cube file chosen, for the label. */
  lookupName: string | null;
  onLookupFile: (file: File) => void;
}) {
  const off = disabled || !gpu;
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <button
          type="button"
          data-image-median
          disabled={off}
          onClick={() => void session.applyMedian()}
        >
          {t(M.median)}
        </button>
        <button
          type="button"
          data-image-maximum
          disabled={off}
          onClick={() => void session.applyMorph("max")}
        >
          {t(M.maximum)}
        </button>
        <button
          type="button"
          data-image-minimum
          disabled={off}
          onClick={() => void session.applyMorph("min")}
        >
          {t(M.minimum)}
        </button>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-lookup">{t(M.lookup)}</label>
        <input
          id="pg-image-lookup"
          type="file"
          accept=".cube"
          data-image-lookup
          disabled={off}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLookupFile(f);
          }}
        />
        <span style={mono}>{lookupName ?? ""}</span>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
