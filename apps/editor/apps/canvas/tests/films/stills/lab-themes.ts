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
// data/scripting/themes.ts, at 850a39b): each theme's seed document and the
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
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameTextWrapMode', 'BoundingBoxTextWrap');
paged.set(ref, 'frameTextWrapOffsets', [12, 12, 12, 12]);`,
    lookFor:
      "The frame gains a text-wrap boundary with an offset on all sides.",
  },
  {
    id: "tables-cells",
    title: "Tables & cells",
    seed: "a-table",
    script: `// Find the table id from the story tree, then read its dimensions.
const story = JSON.parse(paged.stories())[0];
console.log('story', story.selfId, '— see paged.inspect for cell paths');`,
    lookFor: "The console reports the table’s row and column counts.",
  },
  {
    id: "text-paragraph",
    title: "Text & paragraph",
    seed: "styled-story",
    script: `const story = JSON.parse(paged.stories())[0].selfId;
// Address a character range: storyRange:<storyId>@<start>..<end>
const range = 'storyRange:' + story + '@0..40';
paged.set(range, 'characterFontSize', 18);
paged.set(range, 'paragraphSpaceAfter', 8);`,
    lookFor: "The story’s type grows and gains space after each paragraph.",
  },
  {
    id: "effects",
    title: "Effects",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameDropShadow', true);
paged.set(ref, 'frameDropShadowSize', 9);
paged.set(ref, 'frameDropShadowOpacity', 60);`,
    lookFor: "A soft drop shadow appears behind the frame.",
  },
  {
    id: "corners-fitting",
    title: "Corners & fitting",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameCornerOptionTopLeft', 'Rounded');
paged.set(ref, 'frameCornerRadiusTopLeft', 18);`,
    lookFor: "The frame’s top-left corner becomes rounded.",
  },
  {
    id: "strokes",
    title: "Strokes & dashes",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameStrokeColor', 'Color/Black');
paged.set(ref, 'frameStrokeWeight', 4);
paged.set(ref, 'frameStrokeType', 'Dashed');`,
    lookFor: "The frame gains a thick dashed black border.",
  },
  {
    id: "fills",
    title: "Fills & gradients",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameFillColor', 'Color/Red');
paged.set(ref, 'frameFillTint', 60);`,
    lookFor: "The frame fills with a 60% tint of red.",
  },
  {
    id: "transform",
    title: "Transform & geometry",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameRotationAngle', 15);
paged.set(ref, 'frameScaleX', 1.1);
paged.set(ref, 'frameScaleY', 1.1);`,
    lookFor: "The frame rotates 15° and scales up slightly.",
  },
  {
    id: "blend-opacity",
    title: "Blend & opacity",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'frameFillColor', 'Color/Black');
paged.set(ref, 'frameOpacity', 55);
paged.set(ref, 'frameBlendMode', 'Multiply');`,
    lookFor: "The frame becomes semi-transparent with a Multiply blend.",
  },
  {
    id: "styles-layers",
    title: "Styles, layers & visibility",
    seed: "one-text-frame-selected",
    script: `const [el] = JSON.parse(paged.selection());
const ref = el.kind + ':' + el.id;
paged.set(ref, 'elementVisible', false);
console.log('hidden');
paged.set(ref, 'elementVisible', true);
console.log('shown');`,
    lookFor: "The frame is hidden, then shown again.",
  },
];
