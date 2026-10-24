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

// The template notice (docs/composable-editor.md §12, decision 4 of
// 2026-10-24; ADR 293). Roles stay per session, so opening a template in the
// full editor as an editor does not make anyone its author. The editor shows
// the document as the template it is, says so in a strip under the header,
// and offers "Edit template" explicitly: the switch to the author role, with
// the Template panel opened. It shows only when that switch is the session's
// to make (the host keeps the role and allows it) and the profile offers the
// Template panel; it can be hidden until the next document.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import type { TemplateFieldSummary } from "@paged-media/client";
import { chrome, space, status } from "@paged-media/panel-kit";
import {
  useCanvasClient,
  useCockpitActions,
  useCollection,
  useRegistries,
  useRegistryView,
  useSessionRole,
  useSetSessionRole,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

export const NOTICE = defineMessages("templateNotice", {
  line: "{count, plural, one {This document is a template with # field.} other {This document is a template with # fields.}} You are editing it as a document; its fields and what a filler may do stay as they are.",
  edit: "Edit template",
  hide: "Hide",
});

/** The Template panel's id (built-in-panels.tsx). */
export const TEMPLATE_PANEL = "paged.template";

export function TemplateNotice(): ReactElement | null {
  const strings = useStrings();
  const role = useSessionRole();
  const setRole = useSetSessionRole();
  const client = useCanvasClient();
  const registries = useRegistries();
  const panels = useRegistryView(registries.panels);
  const features = useRegistryView(registries.features);
  const cockpit = useCockpitActions();
  const rows = useCollection<TemplateFieldSummary>("templateFields");
  const [hidden, setHidden] = useState(false);

  // Hidden for this document only: the next one may be a template too.
  useEffect(
    () =>
      client.subscribe((msg) => {
        if (msg.kind === "documentLoaded") setHidden(false);
      }),
    [client],
  );

  const count = rows?.length ?? 0;
  const offered =
    panels.get(TEMPLATE_PANEL) !== undefined &&
    features.allows("panel", TEMPLATE_PANEL);
  if (hidden || role !== "editor" || !setRole || count === 0 || !offered)
    return null;

  const edit = () => {
    setRole("author");
    cockpit.openPanel?.(TEMPLATE_PANEL, { activate: true });
  };

  return (
    <div role="status" data-template-notice="" style={barStyle}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {strings.t(NOTICE.line, { count })}
      </span>
      <button type="button" data-template-notice-edit="" onClick={edit}>
        {strings.t(NOTICE.edit)}
      </button>
      <button
        type="button"
        data-template-notice-hide=""
        onClick={() => setHidden(true)}
      >
        {strings.t(NOTICE.hide)}
      </button>
    </div>
  );
}

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space[2],
  minHeight: 32,
  padding: `${space[1]} ${space[3]}`,
  borderBottom: `1px solid ${chrome.border}`,
  background: `color-mix(in srgb, ${status.info} 10%, transparent)`,
  fontSize: 12,
};
