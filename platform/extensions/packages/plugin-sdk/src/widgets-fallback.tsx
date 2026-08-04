/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The plain-textarea CodeEditor fallback — what `host.widgets`
// resolves to when the host APP injects no real widget catalog
// (headless hosts, tests, an editor that hasn't wired the UI package).
// Honest, not fake-interactive: no line numbers, no highlighting, no
// gutter — exactly the W-04 starting point — but the SAME PROPS
// contract, so a bundle authors against `host.widgets.CodeEditor`
// once and transparently gains the rich editor where the host
// provides it.
//
// React is an OPTIONAL peer of plugin-sdk (`peerDependenciesMeta`), and it
// has to be optional at RUNTIME too, not just in the manifest: host-impl
// imports this module for the fallback widget and index re-exports
// host-impl, so anything React-shaped here is on the React-free loader
// path. `react-optional.ts` owns that resolution — and owns the record of
// the TWO breakages (a static import; then a top-level await) it has to
// keep fixed at once. A host that renders this fallback has React by
// construction; a headless consumer never reaches the render path, and if
// one somehow does it gets a named seam rather than a crash.

import type { CodeEditorProps, WidgetSurface } from "@paged-media/plugin-api";

import { type CreateElement, requireCreateElement } from "./react-optional";

function TextareaCodeEditor(
  props: CodeEditorProps,
): ReturnType<CreateElement> {
  const createElement = requireCreateElement(
    "plugin-sdk: host.widgets.CodeEditor fell back to the built-in textarea, " +
      "but React is not installed. Install react, or inject a widget catalog " +
      "via createBundleHost({ widgets }).",
  );
  return createElement("textarea", {
    value: props.value,
    readOnly: props.readOnly,
    spellCheck: false,
    "aria-label": props.ariaLabel,
    "data-code-editor-fallback": props.language ?? "text",
    onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    style: {
      width: "100%",
      minHeight: props.minHeight ?? 96,
      resize: "vertical",
      font: "12px/1.5 var(--font-mono, monospace)",
      color: "var(--pg-fg)",
      background: "var(--pg-bg)",
      border: "1px solid var(--pg-border)",
      borderRadius: "var(--radius-sm, 4px)",
      padding: "var(--space-2, 8px)",
      boxSizing: "border-box",
    },
  });
}

/** The default widget catalog: a textarea CodeEditor. Replaced wholesale
 *  when the host app injects `widgets` into `createBundleHost`. */
export const FALLBACK_WIDGETS: WidgetSurface = {
  CodeEditor: TextareaCodeEditor,
};
