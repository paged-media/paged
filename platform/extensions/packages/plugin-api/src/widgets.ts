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

// Host-provided panel WIDGETS (paged.web W-04, paged.draw-adjacent).
//
// Some panel controls are heavier than a styled <input> and must be
// owned by the HOST, not bundled per plugin: the host controls the
// dependency (one code editor across every scripting-adjacent plugin),
// guarantees a consistent look, and can swap the implementation
// without touching a bundle. The first such widget is `codeEditor`
// (a line-numbered, syntax-highlighted, diagnostics-gutter source
// editor — the source panel's HTML/CSS lanes).
//
// Type-only, like the rest of plugin-api: the WIDGET COMPONENT itself
// is a value the host injects at `loadBundle` time and reaches the
// bundle through `host.widgets`. A bundle imports only the PROPS types
// from here; if the host provides no widget surface, `host.widgets`
// degrades to a plain-textarea fallback (probe with
// `host.supports("widgets.codeEditor@1")`).

import type { ComponentType } from "react";

/** Languages the host code editor highlights. `text` = no
 *  highlighting (line numbers + gutter only). Additive: a host MAY
 *  accept more, but only these are contract-guaranteed. */
export type CodeEditorLanguage = "html" | "css" | "text";

/** A per-line marker rendered in the editor's diagnostics gutter and,
 *  where the host supports it, as an inline squiggle. Structurally a
 *  subset of `Diagnostic` (host.ts) — `line` is 1-based. */
export interface CodeEditorDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based line the marker attaches to. Out-of-range = clamped. */
  line: number;
}

/**
 * Props the host code-editor widget accepts. Controlled: the bundle
 * owns `value` and applies `onChange`. The widget never mutates the
 * document — it is a pure text surface (the panel persists through
 * `host.document`/`host.storage` as it already does for a textarea).
 */
export interface CodeEditorProps {
  value: string;
  onChange(next: string): void;
  /** Syntax-highlight language; default `"text"`. */
  language?: CodeEditorLanguage;
  /** Per-line markers (squiggles + gutter dots). */
  diagnostics?: readonly CodeEditorDiagnostic[];
  /** Non-editable view (still highlighted + line-numbered). */
  readOnly?: boolean;
  /** Min editor height in CSS px (the widget grows with content). */
  minHeight?: number;
  /** Accessible label / test hook passthrough (`data-*` is host'd). */
  ariaLabel?: string;
}

/**
 * The widget catalog the host injects. Members are React component
 * TYPES (the knowingly-non-clonable exit, same class as panel
 * components — DESIGN.md §6): they live in the host's UI package and
 * are handed to in-process bundles. Across the future isolate boundary
 * a widget is addressed by a serializable descriptor instead; that is
 * a second `WidgetSurface` implementation, not a contract change.
 */
export interface WidgetSurface {
  /** The line-numbered, syntax-highlighting, diagnostics-gutter source
   *  editor. Always present: a plain-textarea fallback stands in when
   *  the host app injects no real widget catalog. */
  readonly CodeEditor: ComponentType<CodeEditorProps>;
}
