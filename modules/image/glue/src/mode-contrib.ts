// What IMAGE ▸ MODE contributes to the editor (image ADR 479, WP5.13):
// the depth (8 / 16 bits per channel) and colour-mode commands (Greyscale,
// RGB, CMYK, Lab) and the proof view (Proof colours, Gamut warning and the
// proof setup). Registered from `activate.ts` in one call; the menu rows
// are in `menu.ts`.

import type {
  BundleHost,
  CommandContribution,
  Disposable,
} from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import type { ColorModeName } from "./mode-engine";
import type { ImageSession } from "./session";

const CMD = defineMessages("image.command", {
  modeBits8: "Mode: 8 bits per channel (image)",
  modeBits16: "Mode: 16 bits per channel (image)",
  modeGray: "Mode: greyscale (image)",
  modeRgb: "Mode: RGB colour (image)",
  modeCmyk: "Mode: CMYK colour (image)",
  modeLab: "Mode: Lab colour (image)",
  proofColors: "Proof colours (image)",
  gamutWarning: "Gamut warning (image)",
  proofSetupCmyk: "Proof setup: working CMYK (image)",
  proofSetupGray: "Proof setup: working grey (image)",
});

/** The command id of each colour mode. */
export const MODE_COMMANDS: Record<ColorModeName, string> = {
  gray: "media.paged.image.command.modeGray",
  rgb: "media.paged.image.command.modeRgb",
  cmyk: "media.paged.image.command.modeCmyk",
  lab: "media.paged.image.command.modeLab",
};

export function contributeMode(
  host: BundleHost,
  session: ImageSession,
  command: (c: CommandContribution) => Disposable,
  panelId: string,
): Disposable {
  const handles: Disposable[] = [];
  const open = () => host.shell.openPanel(panelId);
  const add = (id: string, title: string, run: () => Promise<unknown>) =>
    handles.push(
      command({
        id,
        title,
        category: "Image",
        handler: () => {
          open();
          void run();
        },
      }),
    );

  add("media.paged.image.command.modeBits8", t(CMD.modeBits8), () =>
    session.setBits(8),
  );
  add("media.paged.image.command.modeBits16", t(CMD.modeBits16), () =>
    session.setBits(16),
  );
  add(MODE_COMMANDS.gray, t(CMD.modeGray), () => session.setColorMode("gray"));
  add(MODE_COMMANDS.rgb, t(CMD.modeRgb), () => session.setColorMode("rgb"));
  add(MODE_COMMANDS.cmyk, t(CMD.modeCmyk), () => session.setColorMode("cmyk"));
  add(MODE_COMMANDS.lab, t(CMD.modeLab), () => session.setColorMode("lab"));

  // The proof view. Proof colours and Gamut warning toggle; with no
  // target chosen yet they simulate CMYK when the document is CMYK and
  // grey otherwise (Photoshop's View ▸ Proof Setup defaults to the working
  // CMYK; a session without a CMYK profile has no press to simulate).
  const target = () => {
    const p = session.state().mode.proof;
    if (p.target !== "off") return p.target;
    return session.state().mode.color === "cmyk" ? "cmyk" : "gray";
  };
  add("media.paged.image.command.proofColors", t(CMD.proofColors), () =>
    session.setProof({
      target: target(),
      colors: !session.state().mode.proof.colors,
    }),
  );
  add("media.paged.image.command.gamutWarning", t(CMD.gamutWarning), () =>
    session.setProof({
      target: target(),
      gamut: !session.state().mode.proof.gamut,
    }),
  );
  add("media.paged.image.command.proofSetupCmyk", t(CMD.proofSetupCmyk), () =>
    session.setProof({ target: "cmyk" }),
  );
  add("media.paged.image.command.proofSetupGray", t(CMD.proofSetupGray), () =>
    session.setProof({ target: "gray" }),
  );

  return {
    dispose() {
      for (const h of handles) h.dispose();
    },
  };
}
