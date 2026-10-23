// MOVE — the selected pixels, or the whole active layer, by whole pixels
// (bit-exact, no resampling). The Move tool's drag uses the same doors.

import { EdgePolicy, VacateMode, type ImageSession } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { note, row, sectionTitle } from "./styles";

const M = defineMessages("image.move", {
  title: "Move",
  selectedPixels: "Selected pixels",
  activeLayer: "Active layer",
  nudge: "Click: 1 px · Shift-click: 10 px",
  offsetWrap: "Offset (wrap around)",
  halfImage: "Half the image",
  note:
    "Whole-pixel moves are exact. With a selection the selected pixels move " +
    "and leave transparency behind; without one the active layer moves. " +
    "“Half the image” is Filter ▸ Other ▸ Offset with wrap — the seam " +
    "check for a repeating tile.",
});

const STEPS: Array<[label: string, dx: number, dy: number]> = [
  ["←", -1, 0],
  ["→", 1, 0],
  ["↑", 0, -1],
  ["↓", 0, 1],
];

export function MoveSection({
  session,
  hasSelection,
  size,
  gpu,
  disabled,
}: {
  session: ImageSession;
  hasSelection: boolean;
  /** The image's pixel size (null before ingest). */
  size: { width: number; height: number } | null;
  gpu: boolean;
  disabled: boolean;
}) {
  const nudge = (dx: number, dy: number, big: boolean) => {
    const k = big ? 10 : 1;
    return hasSelection
      ? session.moveSelection(dx * k, dy * k, VacateMode.Transparent)
      : session.offsetLayer(dx * k, dy * k, EdgePolicy.Transparent);
  };
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <span>{t(hasSelection ? M.selectedPixels : M.activeLayer)}</span>
        <span>
          {STEPS.map(([label, dx, dy]) => (
            <button
              key={label}
              type="button"
              data-image-nudge={label}
              title={t(M.nudge)}
              disabled={disabled || !gpu}
              onClick={(e) => void nudge(dx, dy, e.shiftKey)}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div style={row}>
        <span>{t(M.offsetWrap)}</span>
        <button
          type="button"
          data-image-offset-wrap
          disabled={disabled || !gpu || !size}
          onClick={() =>
            size &&
            void session.offsetFilter(
              Math.round(size.width / 2),
              Math.round(size.height / 2),
            )
          }
        >
          {t(M.halfImage)}
        </button>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
