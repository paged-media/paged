/*
 * This file is part of paged (https://paged.media).
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

// The pieces of this folder's React panels that are draw's own:
//   · PanelIntro — one plain sentence on what the panel is for (the
//     longer explanation sits in the shared kit's collapsed `About`);
//   · human labels for the kinds of selected objects.
//
// The confirm step of a destructive button, the refusal line and the
// action feedback, `About` and `humanize` are @paged-media/panel-kit's,
// shared with the editor and the other modules.

import type { ElementId } from "@paged-media/plugin-api";
import { color, font } from "@paged-media/panel-kit";
import type * as React from "react";

const introStyle: React.CSSProperties = {
  margin: "0 0 8px",
  font: `12px/1.45 ${font.sans}`,
  color: color.mutedFg,
};

/** The one-sentence intro at the top of a panel. */
export function PanelIntro(props: {
  /** One plain sentence: what the panel is for. */
  summary: string;
  /** `data-*` attribute name the intro carries (for tests). */
  attr: string;
}): React.ReactElement {
  return (
    <p style={introStyle} {...{ [props.attr]: "" }}>
      {props.summary}
    </p>
  );
}

// ------------------------------------------------------------ labels

const KIND_LABELS: Readonly<Record<string, string>> = {
  polygon: "path",
  graphicLine: "line",
  rectangle: "rectangle",
  oval: "ellipse",
  textFrame: "text frame",
  group: "group",
};

/** "path", "line", "text frame"… for a selected element's kind. */
export function elementKindLabel(id: ElementId): string {
  return KIND_LABELS[id.kind] ?? "object";
}
