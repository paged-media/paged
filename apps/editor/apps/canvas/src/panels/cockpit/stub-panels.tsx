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

// Cockpit — the styled-shell panels for product surfaces whose
// backends don't exist yet. Each is the kit's composition with the
// brand's honest empty-state language — a stub is visibly a stub
// (no fake data, no dead interactive chrome).

import { CockpitPanelHeader, ComingSoon } from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.cockpitStubPanels", {
  comments: "Comments",
  noComments: "No comments yet",
  commentsBody:
    "Threaded review comments, approvals and version compare land with the " +
    "collaboration backend.",
  library: "Library",
  librarySoon: "Component library coming soon",
  libraryBody:
    "Browse, drag and configure reusable components — slots bound to data, " +
    "variants, and usage rules.",
});

// StoriesPanel moved to `./stories-panel` (W2.12 — now a real story
// list off `paged.stories()`). DataMappingPanel deleted (U8 — the
// live paged.data bindings panel superseded the stub).

/** Review mode — threaded comments. Needs the collaboration
 * backend. */
export function CommentsPanel() {
  const strings = useStrings();
  return (
    <div data-comments-panel style={{ overflowY: "auto", height: "100%" }}>
      <CockpitPanelHeader title={strings.t(M.comments)} />
      <ComingSoon icon="ui-comment" title={strings.t(M.noComments)}>
        {strings.t(M.commentsBody)}
      </ComingSoon>
    </div>
  );
}

/** Component library — reusable layout components. */
export function ComponentLibraryPanel() {
  const strings = useStrings();
  return (
    <div
      data-component-library-panel
      style={{ overflowY: "auto", height: "100%" }}
    >
      <CockpitPanelHeader title={strings.t(M.library)} />
      <ComingSoon icon="ui-component" title={strings.t(M.librarySoon)}>
        {strings.t(M.libraryBody)}
      </ComingSoon>
    </div>
  );
}
