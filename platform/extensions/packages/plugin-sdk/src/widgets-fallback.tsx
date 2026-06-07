// The plain-textarea CodeEditor fallback — what `host.widgets`
// resolves to when the host APP injects no real widget catalog
// (headless hosts, tests, an editor that hasn't wired the UI package).
// Honest, not fake-interactive: no line numbers, no highlighting, no
// gutter — exactly the W-04 starting point — but the SAME PROPS
// contract, so a bundle authors against `host.widgets.CodeEditor`
// once and transparently gains the rich editor where the host
// provides it.
//
// React is an OPTIONAL peer of plugin-sdk: only this module imports it,
// and only the host path that renders a widget reaches it. The
// diagnostics/loader code paths stay React-free.

import { createElement } from "react";

import type { CodeEditorProps, WidgetSurface } from "@paged-media/plugin-api";

function TextareaCodeEditor(props: CodeEditorProps): ReturnType<typeof createElement> {
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
