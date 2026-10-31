// What SELECTION AND MASKING contributes to the editor (image ADR 470,
// WP5.5): the Select menu's commands, the Magnetic Lasso (in the lasso
// flyout) and the Refine Edge brush (in the quick-selection flyout), and
// the Magnetic Lasso's tool options. Registered from `activate.ts` in one
// call; the menu rows are in `menu.ts`.

import type {
  BundleHost,
  CommandContribution,
  Disposable,
  ToolSettingValue,
} from "@paged-media/plugin-api";
import { contributeTool } from "@paged-media/plugin-sdk";
import { defineMessages, t } from "@paged-media/strings";

import { makeMagneticGesture, makeRefineBrushGesture } from "./magnetic-tool";
import type { ImageSession } from "./session";

export const MAGNETIC_LASSO_TOOL_ID = "media.paged.image.tool.magneticLasso";
export const REFINE_EDGE_TOOL_ID = "media.paged.image.tool.refineEdge";

const CMD = defineMessages("image.command", {
  colorRange: "Color range… (image)",
  selectAndMask: "Select and mask… (image)",
  quickMask: "Quick mask (image)",
  grow: "Grow selection (image)",
  similar: "Similar (image)",
  focusArea: "Focus area… (image)",
  saveSelection: "Save selection as channel (image)",
  loadSelection: "Load selection… (image)",
  makeWorkPath: "Make work path from selection (image)",
});

const TOOL = defineMessages("image.tool", {
  magneticLasso: "Magnetic lasso",
  refineEdge: "Refine edge brush",
});

const OPT = defineMessages("image.toolOptions", {
  width: "Width",
  contrast: "Contrast",
  frequency: "Frequency",
});

/** The Magnetic Lasso's option fields. */
export function magneticOptionFields() {
  return [
    {
      kind: "number" as const,
      key: "width",
      label: t(OPT.width),
      min: 1,
      max: 256,
      step: 1,
      unit: "px",
    },
    {
      kind: "number" as const,
      key: "contrast",
      label: t(OPT.contrast),
      min: 1,
      max: 100,
      step: 1,
      unit: "%",
    },
    {
      kind: "number" as const,
      key: "frequency",
      label: t(OPT.frequency),
      min: 0,
      max: 100,
      step: 1,
    },
  ];
}

/** Apply the Magnetic Lasso's tool settings (unknown keys and wrong types
 *  are ignored). */
export function applyMagneticSettings(
  session: ImageSession,
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const o: Record<string, number> = {};
  for (const k of ["width", "contrast", "frequency"]) {
    if (typeof v[k] === "number") o[k] = v[k] as number;
  }
  if (Object.keys(o).length) session.masking().setMagneticOptions(o);
}

export function contributeMasking(
  host: BundleHost,
  session: ImageSession,
  command: (c: CommandContribution) => Disposable,
  panelId: string,
): Disposable {
  const handles: Disposable[] = [];
  const m = () => session.masking();
  const open = () => host.shell.openPanel(panelId);
  handles.push(
    command({
      id: "media.paged.image.command.colorRange",
      title: t(CMD.colorRange),
      category: "Image",
      handler: () => {
        open();
        void m().openColorRange();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.selectAndMask",
      title: t(CMD.selectAndMask),
      category: "Image",
      handler: () => {
        open();
        void m().openRefine();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.quickMask",
      title: t(CMD.quickMask),
      category: "Image",
      handler: () => {
        void m().toggleQuickMask();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.grow",
      title: t(CMD.grow),
      category: "Image",
      handler: () => {
        m().grow();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.similar",
      title: t(CMD.similar),
      category: "Image",
      handler: () => {
        m().similar();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.focusArea",
      title: t(CMD.focusArea),
      category: "Image",
      handler: () => {
        open();
        m().openFocusArea();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.saveSelection",
      title: t(CMD.saveSelection),
      category: "Image",
      handler: () => {
        m().saveSelection();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.loadSelection",
      title: t(CMD.loadSelection),
      category: "Image",
      handler: () => {
        open();
        m().openLoadSelection();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.makeWorkPath",
      title: t(CMD.makeWorkPath),
      category: "Image",
      handler: () => {
        m().pathFromSelection();
      },
    }),
  );
  handles.push(
    contributeTool(host, {
      id: "media.paged.image.tool.magneticLasso",
      title: t(TOOL.magneticLasso),
      icon: "tool-lasso",
      group: "media.paged.image.tool.lasso",
      section: "selection",
      options: {
        toolId: MAGNETIC_LASSO_TOOL_ID,
        fields: magneticOptionFields(),
      },
      gesture: () => makeMagneticGesture(host, session),
    }),
  );
  handles.push(
    contributeTool(host, {
      id: "media.paged.image.tool.refineEdge",
      title: t(TOOL.refineEdge),
      icon: "tool-magic-wand",
      group: "media.paged.image.tool.magicWand",
      section: "selection",
      gesture: () => makeRefineBrushGesture(host, session),
    }),
  );
  if (host.supports("tools.settings@1")) {
    applyMagneticSettings(session, host.tools.settings(MAGNETIC_LASSO_TOOL_ID));
    handles.push(
      host.tools.onDidChangeSettings(MAGNETIC_LASSO_TOOL_ID, (v) =>
        applyMagneticSettings(session, v),
      ),
    );
  }
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}
