// SELECT ▸ Modify, and the magic wand / paint bucket options.

import type { SelectionModifyOp } from "../../engine";
import type { ImageSession } from "../../session";
import type { WandOptions } from "../../selection-machine";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.selectModify", {
  title: "Selection",
  modifyBy: "Modify by",
  expand: "Expand",
  contract: "Contract",
  border: "Border",
  smooth: "Smooth",
  tolerance: "Wand / bucket tolerance",
  contiguous: "Contiguous",
  note:
    "Expand, contract and border make a hard-edged selection; smooth rounds " +
    "corners and drops specks smaller than about the radius.",
});

/** The operations and their message keys (read through `t` at render). */
const OPS: Array<[SelectionModifyOp, string]> = [
  ["expand", M.expand],
  ["contract", M.contract],
  ["border", M.border],
  ["smooth", M.smooth],
];

export function SelectModifySection({
  session,
  hasSelection,
  radius,
  onRadius,
  wand,
}: {
  session: ImageSession;
  hasSelection: boolean;
  radius: number;
  onRadius: (r: number) => void;
  wand: WandOptions;
}) {
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <label htmlFor="pg-image-modify-radius">{t(M.modifyBy)}</label>
        <input
          id="pg-image-modify-radius"
          type="range"
          min={1}
          max={50}
          step={1}
          value={radius}
          onChange={(e) => onRadius(Number(e.target.value))}
        />
        <span style={mono}>{radius} px</span>
      </div>
      <div style={row}>
        {OPS.map(([op, label]) => (
          <button
            key={op}
            type="button"
            data-image-modify={op}
            disabled={!hasSelection}
            onClick={() => session.modifySelection(op, radius)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div style={row}>
        <label htmlFor="pg-image-wand-tolerance">{t(M.tolerance)}</label>
        <input
          id="pg-image-wand-tolerance"
          type="range"
          min={0}
          max={255}
          step={1}
          value={wand.tolerance}
          onChange={(e) =>
            session.setWandOptions({ tolerance: Number(e.target.value) })
          }
        />
        <span style={mono}>{wand.tolerance}</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-wand-contiguous">{t(M.contiguous)}</label>
        <input
          id="pg-image-wand-contiguous"
          type="checkbox"
          checked={wand.contiguous}
          onChange={(e) =>
            session.setWandOptions({ contiguous: e.target.checked })
          }
        />
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
