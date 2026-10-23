/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// ADR 323 — Object Options: the page-item paths no other panel lays out
// (corner options, arrowheads and dashes, gradient angle / length /
// feather, the raw item and image transforms, flip V, the item's name,
// layer, image link and labels), as `PropertyField`s on the element
// selection. A commit over several selected items is ONE batch = one
// undo step; every field offers "Bind to data…". The gradient tools and
// object commands keep writing their own gestures — this is where the
// same paths are visible, typed and bindable.

import {
  CockpitPanelHeader,
  CockpitSection,
  ObjectPropertyField,
} from "@paged-media/shell";

import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import { SchemaSections, type SectionSpec } from "./schema-sections";
import { sectionsIn } from "./section-strings";

const M = defineMessages("app.objectOptionsPanel", {
  item: "Item",
  name: "Name",
  layer: "Layer",
  objectStyle: "Object style",
  cornerOptions: "Corner Options",
  topLeft: "Top left",
  tlSize: "TL size",
  topRight: "Top right",
  trSize: "TR size",
  bottomLeft: "Bottom left",
  blSize: "BL size",
  bottomRight: "Bottom right",
  brSize: "BR size",
  strokeEndsAndDashes: "Stroke Ends and Dashes",
  start: "Start",
  end: "End",
  dashes: "Dashes",
  gradient: "Gradient",
  fillAngle: "Fill angle",
  fillLength: "Fill length",
  feather: "Feather",
  strokeAngle: "Stroke angle",
  strokeLength: "Stroke length",
  transform: "Transform",
  matrix: "Matrix",
  flipV: "Flip V",
  image: "Image",
  link: "Link",
  content: "Content",
  advanced: "Advanced",
  path: "Path",
  label: "Label",
  objectOptions: "Object Options",
  colour: "Colour",
  opacity: "Opacity",
  blend: "Blend",
  appearance: "Appearance",
  fills: "Fills",
  strokes: "Strokes",
  tint: "Tint",
  weight: "Weight",
});

// Section titles and field labels are message keys (`sectionsIn`).

const OBJECT_OPTION_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.item,
    fields: [
      { path: "itemName", label: M.name },
      { path: "itemLayer", label: M.layer, collection: "layers" },
      {
        path: "appliedObjectStyle",
        label: M.objectStyle,
        collection: "objectStyles",
      },
    ],
  },
  {
    title: M.cornerOptions,
    fields: [
      { path: "frameCornerOptionTopLeft", label: M.topLeft },
      { path: "frameCornerRadiusTopLeft", label: M.tlSize },
      { path: "frameCornerOptionTopRight", label: M.topRight },
      { path: "frameCornerRadiusTopRight", label: M.trSize },
      { path: "frameCornerOptionBottomLeft", label: M.bottomLeft },
      { path: "frameCornerRadiusBottomLeft", label: M.blSize },
      { path: "frameCornerOptionBottomRight", label: M.bottomRight },
      { path: "frameCornerRadiusBottomRight", label: M.brSize },
    ],
  },
  {
    title: M.strokeEndsAndDashes,
    fields: [
      { path: "frameStrokeStartArrowhead", label: M.start },
      { path: "frameStrokeEndArrowhead", label: M.end },
      { path: "frameStrokeDashArray", label: M.dashes },
    ],
  },
  {
    title: M.gradient,
    fields: [
      { path: "frameGradientFillAngle", label: M.fillAngle },
      { path: "frameGradientFillLength", label: M.fillLength },
      { path: "frameGradientFeather", label: M.feather },
      { path: "frameGradientStrokeAngle", label: M.strokeAngle },
      { path: "frameGradientStrokeLength", label: M.strokeLength },
    ],
  },
  {
    title: M.transform,
    fields: [
      { path: "frameTransform", label: M.matrix },
      { path: "frameFlipV", label: M.flipV },
    ],
  },
  {
    title: M.image,
    fields: [
      { path: "imageUri", label: M.link },
      { path: "imageContentTransform", label: M.content },
    ],
  },
  {
    title: M.advanced,
    fields: [
      { path: "framePath", label: M.path },
      { path: "pluginMetadata", label: M.label },
    ],
  },
];

export function ObjectOptionsPanel() {
  const strings = useStrings();
  return (
    <div data-object-options-panel="ready">
      <CockpitPanelHeader title={strings.t(M.objectOptions)} />
      <SchemaSections
        schemaKind="frame"
        sections={sectionsIn(strings, OBJECT_OPTION_SECTIONS)}
        testId="frame"
      />
      <AppearanceStacks />
    </div>
  );
}

/** paged.draw's appearance kind (ADR 323): the extra fill and stroke
 *  layers on the selected path. */
const DRAW_APPEARANCE = "plugin:media.paged.draw/appearance";

/** One appearance layer as the stack lists it (painted bottom → top, so
 *  the list reads top-first like a layers panel; edits still name value
 *  indices). */
const STACK_FIELDS = (strings: Strings, weight: boolean) => [
  {
    field: "color",
    label: strings.t(M.colour),
    style: "collection" as const,
    props: { collectionName: "swatches" },
  },
  ...(weight
    ? [{ field: "weight", label: strings.t(M.weight) }]
    : [{ field: "tint", label: strings.t(M.tint) }]),
  { field: "opacity", label: strings.t(M.opacity) },
  { field: "blendMode", label: strings.t(M.blend) },
];

/** The selected path's appearance stacks — LIST rows over paged.draw's
 *  object model, through the host's one PropertyField (§12.8): add,
 *  remove, reorder and edit a layer, each ONE batch = one undo step. */
function AppearanceStacks() {
  const strings = useStrings();
  return (
    <CockpitSection title={strings.t(M.appearance)} defaultOpen={false}>
      <div
        className="flex flex-col gap-1.5 pb-2"
        data-options-section="Appearance"
      >
        <ObjectPropertyField
          address="selection"
          kind={DRAW_APPEARANCE}
          path="fills"
          label={strings.t(M.fills)}
          items={{
            reversed: true,
            itemLabel: "color",
            fields: STACK_FIELDS(strings, false),
            newItem: {
              color: "Color/Black",
              tint: 100,
              opacity: 100,
              blendMode: "Normal",
            },
          }}
        />
        <ObjectPropertyField
          address="selection"
          kind={DRAW_APPEARANCE}
          path="strokes"
          label={strings.t(M.strokes)}
          items={{
            reversed: true,
            itemLabel: "color",
            fields: STACK_FIELDS(strings, true),
            newItem: {
              color: "Color/Black",
              weight: 1,
              opacity: 100,
              blendMode: "Normal",
            },
          }}
        />
      </div>
    </CockpitSection>
  );
}
