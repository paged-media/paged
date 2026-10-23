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

// Cockpit — Data-layout mode's surfaces (kit: left Data Source nav,
// canvas-area generated grid). Both are honest seams until the
// data-publishing engine lands. U8: the LIVE paged.data plugin panels
// own the mode surface; this suite is titled "Data suite (preview)"
// so it can't be mistaken for them (the old DataMappingPanel stub is
// retired).

import {
  CockpitPanelHeader,
  CockpitSection,
  ComingSoon,
  StatusPill,
  type PanelProps,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.cockpitDataViews", {
  title: "Data suite (preview)",
  source: "Source",
  notConnected: "not connected",
  sourceBody:
    "Connect a structured source (PIM, CSV, API). Records and their fields " +
    "list here, ready to map onto layout slots.",
  recordsSoon: "Records & fields coming soon",
  recordsBody:
    "The record list and field chips land with the data-publishing engine.",
  previewSoon: "Generated layout preview coming soon",
  previewBody:
    "Connect a source and map fields — generated, repeatable pages preview " +
    "here with per-record status.",
});

/** Data mode — LEFT panel: source + records + fields (kit
 *  DataSourcePanel). */
export function DataSourcePanel(_props: PanelProps) {
  const strings = useStrings();
  return (
    <div
      data-data-source-panel
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        fontFamily: "var(--font-sans)",
      }}
    >
      <CockpitPanelHeader title={strings.t(M.title)} />
      <CockpitSection
        title={strings.t(M.source)}
        right={
          <StatusPill tone="draft">{strings.t(M.notConnected)}</StatusPill>
        }
      >
        <span className="pg-ui-xs" style={{ lineHeight: 1.45 }}>
          {strings.t(M.sourceBody)}
        </span>
      </CockpitSection>
      <ComingSoon icon="ui-database" title={strings.t(M.recordsSoon)}>
        {strings.t(M.recordsBody)}
      </ComingSoon>
    </div>
  );
}

/** Data mode — CANVAS main: the generated product-card grid (kit
 *  DataGrid). */
export function DataGridPanel(_props: PanelProps) {
  const strings = useStrings();
  return (
    <div
      data-data-grid-panel
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        overflowY: "auto",
      }}
    >
      <ComingSoon icon="ui-bolt" title={strings.t(M.previewSoon)}>
        {strings.t(M.previewBody)}
      </ComingSoon>
    </div>
  );
}
