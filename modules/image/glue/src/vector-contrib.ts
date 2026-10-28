// What VECTORS INSIDE THE IMAGE contribute to the editor (image ADR 476,
// WP5.11): the Pen and Freeform Pen, Path Selection and Direct
// Selection, the five shape tools, their options (the mode — shape,
// path, pixels —, the path operation, the shapes' own), and the commands
// of the Paths panel and the Layer ▸ Vector Mask menu. Registered from
// `activate.ts` in one call; the menu rows are in `menu.ts`.
//
// KEYS. The shortcut registers are full (INV-REG-1), so the tools take
// none: three rail slots of their own (pen, path selection, shape), as
// Photoshop groups them, reached by click.

import type {
  BundleHost,
  CommandContribution,
  Disposable,
  ToolOptionField,
  ToolSettingValue,
} from "@paged-media/plugin-api";
import { contributeTool } from "@paged-media/plugin-sdk";
import { defineMessages, t } from "@paged-media/strings";

import type { ImageSession } from "./session";
import {
  makeDirectSelectGesture,
  makeFreeformPenGesture,
  makePathSelectGesture,
  makePenGesture,
  makeShapeGesture,
} from "./vector-tools";
import { CUSTOM_SHAPES } from "./vector-shapes";
import type { ShapeMode } from "./vector-session";

const T = "media.paged.image.tool";
export const PEN_TOOL_ID = `${T}.pen`;
export const FREEFORM_PEN_TOOL_ID = `${T}.freeformPen`;
export const PATH_SELECT_TOOL_ID = `${T}.pathSelect`;
export const DIRECT_SELECT_TOOL_ID = `${T}.directSelect`;
export const RECT_SHAPE_TOOL_ID = `${T}.rectangleShape`;
export const ELLIPSE_SHAPE_TOOL_ID = `${T}.ellipseShape`;
export const POLYGON_SHAPE_TOOL_ID = `${T}.polygonShape`;
export const LINE_SHAPE_TOOL_ID = `${T}.lineShape`;
export const CUSTOM_SHAPE_TOOL_ID = `${T}.customShape`;

/** Every tool this file contributes, for the edit context's list. */
export const VECTOR_TOOL_IDS = [
  PEN_TOOL_ID,
  FREEFORM_PEN_TOOL_ID,
  PATH_SELECT_TOOL_ID,
  DIRECT_SELECT_TOOL_ID,
  RECT_SHAPE_TOOL_ID,
  ELLIPSE_SHAPE_TOOL_ID,
  POLYGON_SHAPE_TOOL_ID,
  LINE_SHAPE_TOOL_ID,
  CUSTOM_SHAPE_TOOL_ID,
] as const;

const CMD = defineMessages("image.command", {
  fillPath: "Fill path (image)",
  strokePath: "Stroke path (image)",
  saveWorkPath: "Save work path (image)",
  vectorMaskRevealAll: "Add vector mask (reveal all) (image)",
  vectorMaskHideAll: "Add vector mask (hide all) (image)",
  vectorMaskCurrentPath: "Add vector mask (current path) (image)",
  vectorMaskDelete: "Delete vector mask (image)",
  vectorMaskToggle: "Enable / disable vector mask (image)",
  vectorMaskInvert: "Invert vector mask (image)",
  vectorMaskRasterize: "Rasterize vector mask (image)",
});

const TOOL = defineMessages("image.tool", {
  pen: "Pen",
  freeformPen: "Freeform pen",
  pathSelect: "Path selection",
  directSelect: "Direct selection",
  rectangleShape: "Rectangle",
  ellipseShape: "Ellipse",
  polygonShape: "Polygon",
  lineShape: "Line",
  customShape: "Custom shape",
});

const OPT = defineMessages("image.toolOptions", {
  mode: "Mode",
  modeShape: "Shape",
  modePath: "Path",
  modePixels: "Pixels",
  operation: "Path operation",
  opCombine: "Combine shapes",
  opSubtract: "Subtract front shape",
  opIntersect: "Intersect shape areas",
  opExclude: "Exclude overlapping shapes",
  radius: "Radius",
  sides: "Sides",
  starIndent: "Indent sides by",
  weight: "Weight",
  customShape: "Shape",
  shapeArrow: "Arrow",
  shapeHeart: "Heart",
  shapeCheck: "Check mark",
  shapeSpeech: "Speech bubble",
  shapeCross: "Cross",
});

/** The PSD numbering of each operation. */
const OP_CODE: Record<
  "combine" | "subtract" | "intersect" | "exclude",
  number
> = {
  exclude: 0,
  combine: 1,
  subtract: 2,
  intersect: 3,
};

/** The mode and path-operation fields every drawing tool shows (the Pen
 *  offers no Pixels mode, as in Photoshop). */
const modeFields = (modes: readonly ShapeMode[]): ToolOptionField[] => [
  {
    kind: "select",
    key: "mode",
    label: t(OPT.mode),
    options: modes.map((m) => ({
      value: m,
      label: t(
        m === "shape"
          ? OPT.modeShape
          : m === "path"
            ? OPT.modePath
            : OPT.modePixels,
      ),
    })),
  },
  {
    kind: "select",
    key: "operation",
    label: t(OPT.operation),
    options: [
      { value: "combine", label: t(OPT.opCombine) },
      { value: "subtract", label: t(OPT.opSubtract) },
      { value: "intersect", label: t(OPT.opIntersect) },
      { value: "exclude", label: t(OPT.opExclude) },
    ],
  },
];

const ALL_MODES: readonly ShapeMode[] = ["shape", "path", "pixels"];

/** The Pen's and the Freeform Pen's fields. */
export const penOptionFields = (): ToolOptionField[] => [
  ...modeFields(["shape", "path"]),
];

export const rectangleOptionFields = (): ToolOptionField[] => [
  ...modeFields(ALL_MODES),
  {
    kind: "number",
    key: "radius",
    label: t(OPT.radius),
    min: 0,
    max: 1000,
    step: 1,
    unit: "px",
  },
];

export const ellipseOptionFields = (): ToolOptionField[] => [
  ...modeFields(ALL_MODES),
];

export const polygonOptionFields = (): ToolOptionField[] => [
  ...modeFields(ALL_MODES),
  {
    kind: "number",
    key: "sides",
    label: t(OPT.sides),
    min: 3,
    max: 100,
    step: 1,
  },
  {
    kind: "number",
    key: "starIndent",
    label: t(OPT.starIndent),
    min: 0,
    max: 99,
    step: 1,
    unit: "%",
  },
];

export const lineOptionFields = (): ToolOptionField[] => [
  ...modeFields(ALL_MODES),
  {
    kind: "number",
    key: "weight",
    label: t(OPT.weight),
    min: 1,
    max: 1000,
    step: 1,
    unit: "px",
  },
];

export const customShapeOptionFields = (): ToolOptionField[] => [
  ...modeFields(ALL_MODES),
  {
    kind: "select",
    key: "shape",
    label: t(OPT.customShape),
    options: [
      { value: "arrow", label: t(OPT.shapeArrow) },
      { value: "heart", label: t(OPT.shapeHeart) },
      { value: "check", label: t(OPT.shapeCheck) },
      { value: "speech", label: t(OPT.shapeSpeech) },
      { value: "cross", label: t(OPT.shapeCross) },
    ],
  },
];

/** Apply a vector tool's settings to the session (unknown keys and wrong
 *  types are ignored). */
export function applyVectorSettings(
  session: ImageSession,
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const vec = session.vectors();
  const mode = v.mode;
  if (mode === "shape" || mode === "path" || mode === "pixels")
    vec.setMode(mode);
  const op = v.operation;
  if (typeof op === "string" && op in OP_CODE)
    vec.setOp(OP_CODE[op as keyof typeof OP_CODE]);
  const patch: Record<string, number | string> = {};
  for (const k of ["radius", "sides", "starIndent", "weight"]) {
    if (typeof v[k] === "number" && Number.isFinite(v[k]))
      patch[k] = v[k] as number;
  }
  if (typeof v.shape === "string" && v.shape in CUSTOM_SHAPES)
    patch.custom = v.shape;
  if (Object.keys(patch).length) vec.setShapeOptions(patch);
}

export function contributeVectors(
  host: BundleHost,
  session: ImageSession,
  command: (c: CommandContribution) => Disposable,
  panelId: string,
): Disposable {
  const handles: Disposable[] = [];
  const v = () => session.vectors();
  const open = () => host.shell.openPanel(panelId);
  const cmd = (id: string, title: string, run: () => unknown) =>
    handles.push(
      command({
        id: `media.paged.image.command.${id}`,
        title: t(title),
        category: "Image",
        handler: () => {
          void run();
        },
      }),
    );
  cmd("fillPath", CMD.fillPath, () => v().fillPath());
  cmd("strokePath", CMD.strokePath, () => v().strokePath());
  cmd("saveWorkPath", CMD.saveWorkPath, () => {
    open();
    return v().saveWorkPath();
  });
  cmd("vectorMaskRevealAll", CMD.vectorMaskRevealAll, () =>
    v().addVectorMask("revealAll"),
  );
  cmd("vectorMaskHideAll", CMD.vectorMaskHideAll, () =>
    v().addVectorMask("hideAll"),
  );
  cmd("vectorMaskCurrentPath", CMD.vectorMaskCurrentPath, () =>
    v().addVectorMask("currentPath"),
  );
  cmd("vectorMaskDelete", CMD.vectorMaskDelete, () => v().deleteVectorMask());
  cmd("vectorMaskToggle", CMD.vectorMaskToggle, () => v().toggleVectorMask());
  cmd("vectorMaskInvert", CMD.vectorMaskInvert, () => v().invertVectorMask());
  cmd("vectorMaskRasterize", CMD.vectorMaskRasterize, () =>
    v().rasterizeVectorMask(),
  );

  const settingsFor = (toolId: string) => () => {
    if (host.supports("tools.settings@1"))
      applyVectorSettings(session, host.tools.settings(toolId));
  };
  /** A gesture that first takes its tool's settings (the mode and the
   *  operation are shared by the vector tools, as Photoshop's options
   *  bar shows the active tool's). */
  const withSettings =
    (toolId: string, make: () => ReturnType<typeof makePenGesture>) => () => {
      const g = make();
      const apply = settingsFor(toolId);
      return {
        ...g,
        onActivate(p: Parameters<typeof g.onActivate>[0]) {
          apply();
          g.onActivate(p);
        },
      };
    };
  const tool = (
    id: string,
    title: string,
    icon: string,
    group: string,
    make: () => ReturnType<typeof makePenGesture>,
    fields?: ToolOptionField[],
  ) =>
    handles.push(
      contributeTool(host, {
        id,
        title: t(title),
        icon,
        group,
        section: "drawType",
        ...(fields ? { options: { toolId: id, fields } } : {}),
        gesture: withSettings(id, make),
      }),
    );
  tool(
    PEN_TOOL_ID,
    TOOL.pen,
    "tool-pen",
    PEN_TOOL_ID,
    () => makePenGesture(host, session),
    penOptionFields(),
  );
  tool(
    FREEFORM_PEN_TOOL_ID,
    TOOL.freeformPen,
    "tool-pencil",
    PEN_TOOL_ID,
    () => makeFreeformPenGesture(host, session),
    penOptionFields(),
  );
  tool(
    PATH_SELECT_TOOL_ID,
    TOOL.pathSelect,
    "tool-select",
    PATH_SELECT_TOOL_ID,
    () => makePathSelectGesture(host, session),
  );
  tool(
    DIRECT_SELECT_TOOL_ID,
    TOOL.directSelect,
    "tool-directSelect",
    PATH_SELECT_TOOL_ID,
    () => makeDirectSelectGesture(host, session),
  );
  tool(
    RECT_SHAPE_TOOL_ID,
    TOOL.rectangleShape,
    "tool-rectangle",
    RECT_SHAPE_TOOL_ID,
    () => makeShapeGesture(host, session, "rectangle"),
    rectangleOptionFields(),
  );
  tool(
    ELLIPSE_SHAPE_TOOL_ID,
    TOOL.ellipseShape,
    "tool-ellipse",
    RECT_SHAPE_TOOL_ID,
    () => makeShapeGesture(host, session, "ellipse"),
    ellipseOptionFields(),
  );
  tool(
    POLYGON_SHAPE_TOOL_ID,
    TOOL.polygonShape,
    "tool-polygon",
    RECT_SHAPE_TOOL_ID,
    () => makeShapeGesture(host, session, "polygon"),
    polygonOptionFields(),
  );
  tool(
    LINE_SHAPE_TOOL_ID,
    TOOL.lineShape,
    "tool-line",
    RECT_SHAPE_TOOL_ID,
    () => makeShapeGesture(host, session, "line"),
    lineOptionFields(),
  );
  tool(
    CUSTOM_SHAPE_TOOL_ID,
    TOOL.customShape,
    "tool-shapeBuilder",
    RECT_SHAPE_TOOL_ID,
    () => makeShapeGesture(host, session, "custom"),
    customShapeOptionFields(),
  );

  if (host.supports("tools.settings@1")) {
    for (const id of VECTOR_TOOL_IDS)
      handles.push(
        host.tools.onDidChangeSettings(id, (values) =>
          applyVectorSettings(session, values),
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
