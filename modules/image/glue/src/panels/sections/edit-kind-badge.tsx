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

// The badges of image ADR 487: a layer row's kind, and the context
// toolbar's "Editing: …" — pixel edits look different from non-destructive
// ones, mask edits from both, and the picture's placement from all three.

import { color, font } from "@paged-media/panel-kit";
import { t } from "@paged-media/strings";

import type { LayerInfo } from "../../engine";
import {
  EDIT_KIND,
  editKindLabel,
  layerBadge,
  type EditKind,
} from "../../edit-kind";

/** A small outlined chip; a non-destructive kind is drawn dashed, the way
 *  the canvas draws a preview, so the difference reads before the word. */
function chip(destructive: boolean) {
  return {
    font: `10px ${font.sans}`,
    lineHeight: "14px",
    padding: "0 5px",
    borderRadius: 3,
    border: `1px ${destructive ? "solid" : "dashed"} ${color.border}`,
    color: destructive ? color.fg : color.mutedFg,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  };
}

/** A layer row's kind. */
export function LayerKindBadge({
  layer,
}: {
  layer: Pick<LayerInfo, "index" | "kind">;
}) {
  const b = layerBadge(layer);
  return (
    <span
      data-image-layer-kind={b.kind}
      data-destructive={b.destructive ? "true" : "false"}
      title={t(b.hint)}
      style={chip(b.destructive)}
    >
      {t(b.label)}
    </span>
  );
}

/** "Editing: Pixels" — what the next edit changes (the context toolbar's
 *  group, and the panel's header). */
export function EditKindBadge({ kind }: { kind: EditKind }) {
  const { label, hint } = editKindLabel(kind);
  const destructive = kind === "pixels";
  return (
    <span
      data-image-edit-kind={kind}
      data-destructive={destructive ? "true" : "false"}
      title={t(hint)}
      style={chip(destructive)}
    >
      {t(EDIT_KIND.editing, {
        what: destructive
          ? t(label)
          : `${t(label)} · ${t(EDIT_KIND.nonDestructive)}`,
      })}
    </span>
  );
}
