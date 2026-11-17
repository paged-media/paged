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

// The documentation's scripting themes (the docs repository's
// data/scripting/themes.ts, at 9f0b3c5): each theme's seed document and the
// showcase script the lab runs on it. A copy, so the editor's stills need no
// docs checkout; when the docs change a theme's script or seed, change it
// here too and capture its poster again (embed.film.ts, `lab-<id>`).

export interface LabTheme {
  readonly id: string;
  readonly title: string;
  /** A seed of src/playground/seeds.ts. */
  readonly seed: string;
  readonly script: string;
  /** What the reader should see once the script ran. */
  readonly lookFor: string;
}

export const LAB_THEMES: readonly LabTheme[] = [
  {
    id: "anchored-textwrap",
    title: "Anchored objects & text wrap",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\nconst pid = JSON.parse(paged.pages())[0].selfId;\n// More text, so there is something to wrap.\nconst story = JSON.parse(paged.stories())[0];\npaged.insertText(story.selfId, story.characterCount, ' Lines that meet a frame with text wrap on break at its edge, keep the offset clear, and carry on past it.'.repeat(3));\n// A tinted box over the text, with a bounding-box wrap 12 pt out.\nconst box = paged.insertFrame(pid, [180, 220, 290, 390]);\npaged.set(box, 'frameFillColor', 'Color/Black');\npaged.set(box, 'frameFillTint', 25);\npaged.set(box, 'frameTextWrapMode', 'BoundingBoxTextWrap');\npaged.set(box, 'frameTextWrapOffsets', [12, 12, 12, 12]);\npaged.setElementSelection([ref]);\nconsole.log(box, 'wraps the text, 12 pt clear');",
    lookFor:
      "More text fills the frame and flows around a grey box, keeping 12 pt clear on every side.",
  },
  {
    id: "tables-cells",
    title: "Tables & cells",
    seed: "a-table",
    script:
      "const story = JSON.parse(paged.stories())[0].selfId;\nconst table = JSON.parse(paged.query('table'))[0];  // \"table:<id>\"\nconst id = table.slice('table:'.length);\n// Room for the cells: three 130 pt columns, 32 pt rows.\nfor (let c = 0; c < 3; c++) paged.setColumnWidth(story, id, c, 130);\nfor (let r = 0; r < 3; r++) paged.setRowHeight(story, id, r, 32);\n// A tinted header row with a heavier rule under it.\nfor (let c = 0; c < 3; c++) {\n  const cell = 'cell:' + id + '/0,' + c;\n  paged.set(cell, 'cellFillColor', 'Color/Black');\n  paged.set(cell, 'cellFillTint', 25);\n  paged.set(cell, 'cellBottomEdgeStrokeWeight', 2);\n}\n// Leave the table and select the frame that holds it, so the stage frames it.\npaged.clearSelection();\npaged.setElementSelection(JSON.parse(paged.query('textFrame')));\nconsole.log(table, 'is 3 × 3');",
    lookFor:
      "The table opens out to three 130 pt columns and 32 pt rows, its header row grey with a heavier rule under it.",
  },
  {
    id: "text-paragraph",
    title: "Text & paragraph",
    seed: "styled-story",
    script:
      "const story = JSON.parse(paged.stories())[0];\n// Address the whole story: storyRange:<storyId>@<start>..<end>\nconst range = 'storyRange:' + story.selfId + '@0..' + story.characterCount;\npaged.set(range, 'characterFontSize', 28);\npaged.set(range, 'paragraphSpaceAfter', 18);\nconsole.log(range, 'at 28 pt');",
    lookFor:
      "The whole story sets at 28 pt, with 18 pt of space after each paragraph.",
  },
  {
    id: "effects",
    title: "Effects",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\n// A shadow falls from what the frame draws: give it a pale fill.\npaged.set(ref, 'frameFillColor', 'Color/Black');\npaged.set(ref, 'frameFillTint', 8);\npaged.set(ref, 'frameDropShadow', true);\npaged.set(ref, 'frameDropShadowSize', 10);\npaged.set(ref, 'frameDropShadowXOffset', 8);\npaged.set(ref, 'frameDropShadowYOffset', 8);\npaged.set(ref, 'frameDropShadowOpacity', 60);\nconsole.log(ref, 'drop shadow: on');",
    lookFor:
      "The frame takes a pale grey fill and casts a soft shadow down and to the right.",
  },
  {
    id: "corners-fitting",
    title: "Corners & fitting",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\n// Corners show on a frame with an edge: give it a rule first.\npaged.set(ref, 'frameStrokeColor', 'Color/Black');\npaged.set(ref, 'frameStrokeWeight', 3);\nfor (const corner of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {\n  paged.set(ref, 'frameCornerOption' + corner, 'RoundedCorner');\n  paged.set(ref, 'frameCornerRadius' + corner, 36);\n}\nconsole.log(ref, 'corners: rounded, 36 pt');",
    lookFor:
      "The frame gains a black rule, and all four corners round to a 36 pt radius.",
  },
  {
    id: "strokes",
    title: "Strokes & dashes",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\npaged.set(ref, 'frameStrokeColor', 'Color/Black');\npaged.set(ref, 'frameStrokeWeight', 4);\npaged.set(ref, 'frameStrokeType', 'Dashed');\nconsole.log(ref, 'stroke: 4 pt, dashed, black');",
    lookFor: "The frame gains a thick dashed black border.",
  },
  {
    id: "fills",
    title: "Fills & gradients",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\n// A new document has only Black: make a red swatch first.\nconst red = paged.createSwatch({ space: 'CMYK', value: [0, 100, 100, 0], name: 'Red' });\npaged.set(ref, 'frameFillColor', red);\npaged.set(ref, 'frameFillTint', 60);\nconsole.log(ref, 'fill:', red, 'at 60%');",
    lookFor:
      "The frame fills with a 60% tint of red, from a swatch the script makes first (a new document has only Black).",
  },
  {
    id: "transform",
    title: "Transform & geometry",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\n// A pale fill, so the frame's own turn shows, not only its text's.\npaged.set(ref, 'frameFillColor', 'Color/Black');\npaged.set(ref, 'frameFillTint', 12);\npaged.set(ref, 'frameRotationAngle', 15);\npaged.set(ref, 'frameScaleX', 1.1);\npaged.set(ref, 'frameScaleY', 1.1);\nconsole.log(ref, 'rotated 15°, scaled to 110%');",
    lookFor: "The frame, filled pale grey, turns 15° and grows by a tenth.",
  },
  {
    id: "blend-opacity",
    title: "Blend & opacity",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\nconst pid = JSON.parse(paged.pages())[0].selfId;\n// A red box over the frame's text...\nconst red = paged.createSwatch({ space: 'CMYK', value: [0, 100, 100, 0], name: 'Red' });\nconst box = paged.insertFrame(pid, [150, 200, 260, 420]);\npaged.set(box, 'frameFillColor', red);\n// ...at 55% opacity, multiplied with what lies under it.\npaged.set(box, 'frameOpacity', 55);\npaged.set(box, 'frameBlendMode', 'Multiply');\npaged.setElementSelection([ref]);\nconsole.log(box, 'opacity 55%, Multiply');",
    lookFor:
      "A red box lies over the frame’s first lines at 55% opacity with a Multiply blend: the text shows through it.",
  },
  {
    id: "styles-layers",
    title: "Styles, layers & visibility",
    seed: "one-text-frame-selected",
    script:
      "const [el] = JSON.parse(paged.selection());\nconst ref = el.kind + ':' + el.id;\n// An object style carries a look: a tinted fill and a black rule.\nconst style = paged.createObjectStyle({ name: 'Callout' });\npaged.setStyleProperty('object', style, 'frameFillColor', 'Color/Black');\npaged.setStyleProperty('object', style, 'frameFillTint', 15);\npaged.setStyleProperty('object', style, 'frameStrokeColor', 'Color/Black');\npaged.setStyleProperty('object', style, 'frameStrokeWeight', 3);\n// Applying it gives the frame that look.\npaged.set(ref, 'appliedObjectStyle', style);\n// Visibility: hide the frame, then show it again.\npaged.set(ref, 'elementVisible', false);\nconsole.log('visible:', JSON.parse(paged.get(ref, 'elementVisible')).value);\npaged.set(ref, 'elementVisible', true);\nconsole.log('visible:', JSON.parse(paged.get(ref, 'elementVisible')).value);",
    lookFor:
      "The frame takes the new object style’s grey fill and black rule; the console shows it hidden, then visible again.",
  },
];
