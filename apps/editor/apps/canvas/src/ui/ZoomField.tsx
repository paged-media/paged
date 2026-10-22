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

// Header zoom indicator + scrub control. First consumer of
// @paged-media/ui's `NumberInput` — establishes the round-trip for the
// new gesture-pipeline primitive in a low-stakes corner of the
// shell (changing zoom is non-destructive). Drag the leading "%"
// chip horizontally to scrub; native keyboard editing still works.

import { useCamera, ZOOM_MAX_SCALE, ZOOM_MIN_SCALE } from "@paged-media/shell";
import { NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.uiZoomField", {
  zoomPercent: "zoom percent",
});

// The one zoom range (ADR 246), in percent.
const MIN_ZOOM_PERCENT = ZOOM_MIN_SCALE * 100;
const MAX_ZOOM_PERCENT = ZOOM_MAX_SCALE * 100;
/** Horizontal pixels per percent of zoom change when dragging. */
const ZOOM_STEP = 0.5;

export function ZoomField() {
  const { camera, setCamera } = useCamera();
  const strings = useStrings();
  const percent = Math.round(camera.scale * 100);

  const apply = (nextPercent: number) => {
    const clamped = Math.max(
      MIN_ZOOM_PERCENT,
      Math.min(MAX_ZOOM_PERCENT, nextPercent),
    );
    setCamera({ ...camera, scale: clamped / 100 });
  };

  return (
    <NumberInput
      value={percent}
      label="%"
      step={ZOOM_STEP}
      min={MIN_ZOOM_PERCENT}
      max={MAX_ZOOM_PERCENT}
      precision={0}
      aria-label={strings.t(M.zoomPercent)}
      onChange={apply}
      className="w-20"
    />
  );
}
