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

// The SETTING of the automatic recipe update (commands/recipe-auto-update.ts):
// one checkbox, shown in each recipe panel (Pattern, Repeat, Blend, Objects
// on path, Live paint) beside the Update button it makes unnecessary. It is
// the bundle's storage key `recipes.autoUpdate`, a per-user setting, so every
// panel shows the one value. Hidden on a host that cannot amend an undo step:
// there the update is never automatic and the checkbox would change nothing.

import type { BundleHost } from "@paged-media/plugin-api";
import { font } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";
import * as React from "react";

import {
  onRecipeAutoUpdateChange,
  RECIPE_AUTO_UPDATE_FEATURE,
  recipeAutoUpdateSnapshot,
  setRecipeAutoUpdate,
} from "../commands/recipe-auto-update";

const M = defineMessages("draw.recipeAutoUpdate", {
  label: "Update automatically when a source changes",
  hint: "Rebuild the artwork in the same undo step when you edit what it is made from or change its settings. Off: choose Update yourself.",
});

/** The label, exported so a spec pins the wording. */
export const RECIPE_AUTO_UPDATE_LABEL = M.label;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0 6px",
  font: `12px ${font.sans}`,
};

/** The checkbox row; `null` on a host without the feature. */
export function RecipeAutoUpdateToggle(props: {
  host: BundleHost;
  /** Distinguishes the panels' ids (`draw-<panel>-auto-update`). */
  panel: string;
}): React.ReactElement | null {
  const { host, panel } = props;
  const s = useStrings();
  const on = React.useSyncExternalStore(
    (notify) => onRecipeAutoUpdateChange(notify).dispose,
    () => recipeAutoUpdateSnapshot(host),
  );
  // Asked once: the host's feature set does not change while it lives.
  const [able] = React.useState(() =>
    host.supports(RECIPE_AUTO_UPDATE_FEATURE),
  );
  if (!able) return null;
  const id = `draw-${panel}-auto-update`;
  return (
    <div style={rowStyle} title={s.t(M.hint)}>
      <input
        id={id}
        type="checkbox"
        data-draw-recipe-auto-update={panel}
        checked={on}
        onChange={(e) => setRecipeAutoUpdate(host, e.target.checked)}
      />
      <label style={{ flex: 1 }} htmlFor={id}>
        {s.t(M.label)}
      </label>
    </div>
  );
}
