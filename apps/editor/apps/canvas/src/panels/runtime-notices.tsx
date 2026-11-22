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

// What the editor runs on, said where it is seen: two notices in the strip
// under the header (the shell's `notices`, beside the template notice), each
// hidden by its Hide button for the rest of the session and rendering
// nothing when it has nothing to say.
//
//   · The CPU. Without a WebGPU adapter the worker draws every page with
//     `vello_cpu`, one tile 256 px across the page (`worker/render.ts`), and
//     said so only on the console (`worker.ts`, `webgpuAdapterAvailable`).
//     The worker's `attachReady.gpuActive` is the fact this reads.
//   · A phone. The full and focused editors are desktop editors at every
//     width; the Fill in and Form layouts are the ones made for a phone
//     (editor ADR 294). Below the same breakpoint, measured on the editor's
//     root, a desktop editor says so.
//
// Neither shows under automation (`navigator.webdriver`). The test browsers'
// Chromium has no WebGPU adapter, so every run would carry a strip that moves
// the layout under test, and no one reads a notice there. The DOM tests
// render both with automation turned off.

import { useState, type CSSProperties, type ReactElement } from "react";

import { chrome, space, status } from "@paged-media/panel-kit";
import {
  isCompactWidth,
  useChromeRegions,
  useEditorWidth,
  useInstrumentation,
  useSessionRole,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

export const RUNTIME_NOTICE = defineMessages("app.runtimeNotice", {
  cpu: "WebGPU is not available in this browser, so pages are drawn on the CPU at lower resolution.",
  desktop:
    "This editor is made for desktop screens. On a phone, the Fill in and Form layouts work for filling in a template; for everything else, use a larger screen.",
  hide: "Hide",
});

/** Whether a browser driven by automation (Playwright, WebDriver) runs the
 *  editor. */
function underAutomation(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as { webdriver?: boolean }).webdriver === true
  );
}

/** The canvas draws on the CPU: say so, and what it costs. */
export function CpuRenderingNotice(): ReactElement | null {
  const strings = useStrings();
  const { gpuActive } = useInstrumentation();
  const [hidden, setHidden] = useState(false);
  // `null` is not known yet: the worker has not attached a canvas.
  if (hidden || gpuActive !== false || underAutomation()) return null;
  return (
    <div role="status" data-runtime-notice="cpu" style={barStyle}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {strings.t(RUNTIME_NOTICE.cpu)}
      </span>
      <button
        type="button"
        data-runtime-notice-hide=""
        onClick={() => setHidden(true)}
      >
        {strings.t(RUNTIME_NOTICE.hide)}
      </button>
    </div>
  );
}

/** A desktop editor on a phone-sized editor root: say what works there. */
export function DesktopScreenNotice(): ReactElement | null {
  const strings = useStrings();
  const { compact } = useChromeRegions();
  const role = useSessionRole();
  const width = useEditorWidth();
  const [hidden, setHidden] = useState(false);
  // A profile with a compact layout (the fill shapes) is made for the
  // width; a viewer or a filler only looks and fills.
  const desktopEditor =
    compact === null && (role === "author" || role === "editor");
  if (hidden || !desktopEditor || !isCompactWidth(width) || underAutomation())
    return null;
  return (
    <div role="status" data-runtime-notice="desktop" style={barStyle}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {strings.t(RUNTIME_NOTICE.desktop)}
      </span>
      <button
        type="button"
        data-runtime-notice-hide=""
        onClick={() => setHidden(true)}
      >
        {strings.t(RUNTIME_NOTICE.hide)}
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
