// CURVES ▸ the tools beside the curve (I-55): Auto (each channel's own
// contrast, Photoshop's "Enhance Per Channel Contrast" at 0.1 % clipping)
// and the black / grey / white point eyedroppers. An armed eyedropper
// takes the next click on the image with any image tool; black and white
// move the channel curves' ends to the sampled colour, grey bends them so
// that colour comes out neutral.

import type { CurvesPick } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { row } from "./styles";

const M = defineMessages("image.curvesTools", {
  group: "Curves tools",
  auto: "Auto",
  autoTitle:
    "Stretch each channel to its own range, 0.1 % of the pixels clipped at each end",
  black: "Black point",
  grey: "Grey point",
  white: "White point",
  pickTitle: "Then click the image: {what}",
  blackTitle: "the colour that should become black",
  greyTitle: "a colour that should be neutral grey",
  whiteTitle: "the colour that should become white",
});

const PICKS: Array<[CurvesPick, string, string, string]> = [
  ["black", M.black, M.blackTitle, "◐"],
  ["grey", M.grey, M.greyTitle, "◑"],
  ["white", M.white, M.whiteTitle, "○"],
];

export function CurvesTools({
  armed,
  disabled,
  onAuto,
  onArm,
}: {
  armed: CurvesPick | null;
  disabled: boolean;
  onAuto: () => void;
  onArm: (kind: CurvesPick | null) => void;
}) {
  return (
    <div style={row} role="group" aria-label={t(M.group)}>
      <button
        type="button"
        data-image-curves-auto
        disabled={disabled}
        title={t(M.autoTitle)}
        onClick={onAuto}
      >
        {t(M.auto)}
      </button>
      {PICKS.map(([kind, label, what, glyph]) => (
        <button
          key={kind}
          type="button"
          data-image-curves-pick={kind}
          aria-pressed={armed === kind}
          aria-label={t(label)}
          disabled={disabled}
          title={`${t(label)} — ${t(M.pickTitle, { what: t(what) })}`}
          onClick={() => onArm(armed === kind ? null : kind)}
        >
          {glyph} {t(label)}
        </button>
      ))}
    </div>
  );
}
