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
// A text field written in styles (engine ADR 1016; docs/composable-editor.md
// §12, decision 6): the author lists the character styles the field allows
// and whether it takes line and paragraph breaks, and this control offers
// exactly those. A button per allowed style puts the selected text in it (or
// back in the frame's own style); Enter makes a paragraph break and
// Shift+Enter a line break, only when the field takes them. The value is
// written as runs when the control loses focus; the engine checks it again.

import { useEffect, useRef, useState, type ReactElement } from "react";

import { space } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import { FORM } from "./messages";

/** One part of a styled value, as the engine's `StyledRun`. */
export type StyledRun =
  | { text: string; style?: string | null }
  | { break: "line" | "paragraph" };

export type Breaks = "none" | "line" | "paragraph";

const isBreak = (r: StyledRun): r is { break: "line" | "paragraph" } =>
  "break" in r;

/** A style's name as a reader sees it: `CharacterStyle/Bold` is "Bold". */
export function styleName(style: string): string {
  return style.replace(/^CharacterStyle\//, "").replace(/\$ID\//, "");
}

/** How a run in `style` looks in the control: bold, italic, or underlined
 *  when the name says neither. */
function look(style: string): Partial<CSSStyleDeclaration> {
  const name = styleName(style);
  const bold = /bold|black|heavy|strong|fett/i.test(name);
  const italic = /italic|oblique|emph|kursiv/i.test(name);
  return {
    fontWeight: bold ? "700" : "",
    fontStyle: italic ? "italic" : "",
    textDecoration: bold || italic ? "" : "underline dotted",
  };
}

/** Builds the control's content from runs, without HTML strings. */
function render(el: HTMLElement, runs: readonly StyledRun[]): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  const doc = el.ownerDocument;
  for (const run of runs) {
    if (isBreak(run)) {
      const br = doc.createElement("br");
      br.setAttribute("data-break", run.break);
      el.appendChild(br);
      continue;
    }
    if (!run.style) {
      el.appendChild(doc.createTextNode(run.text));
      continue;
    }
    const span = doc.createElement("span");
    span.setAttribute("data-style", run.style);
    Object.assign(span.style, look(run.style));
    span.appendChild(doc.createTextNode(run.text));
    el.appendChild(span);
  }
}

/** The control's content as runs: text in the style of the span around it,
 *  a `<br data-break>` as its break, adjacent runs of one style joined. */
export function serialize(el: Node): StyledRun[] {
  const out: StyledRun[] = [];
  const push = (text: string, style: string | null) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && !isBreak(last) && (last.style ?? null) === style) {
      last.text += text;
      return;
    }
    out.push(style ? { text, style } : { text });
  };
  const walk = (node: Node, style: string | null) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        push((child.textContent ?? "").replace(/[\r\n]+/g, " "), style);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      if (e.tagName === "BR") {
        const kind = e.getAttribute("data-break");
        out.push({ break: kind === "line" ? "line" : "paragraph" });
        continue;
      }
      // A block a browser made of a typed return starts a paragraph.
      if ((e.tagName === "DIV" || e.tagName === "P") && out.length > 0)
        out.push({ break: "paragraph" });
      walk(e, e.getAttribute("data-style") ?? style);
    }
  };
  walk(el, null);
  return out;
}

/** The characters a value holds, as the engine counts them. */
export function runsLength(runs: readonly StyledRun[]): number {
  return runs.reduce((n, r) => n + (isBreak(r) ? 1 : [...r.text].length), 0);
}

/** The selection inside `el`, if there is one. */
function rangeIn(el: HTMLElement): Range | null {
  const sel = el.ownerDocument.getSelection?.();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? range : null;
}

/** The style the node `n` stands in, inside `el`. */
function styleAt(el: HTMLElement, n: Node | null): string | null {
  for (let at = n; at && at !== el; at = at.parentNode) {
    if (at.nodeType === 1) {
      const s = (at as Element).getAttribute("data-style");
      if (s) return s;
    }
  }
  return null;
}

/** Puts the selected text in `style`, or back in the frame's own style when
 *  it is in `style` already. */
function applyStyle(el: HTMLElement, style: string): boolean {
  const range = rangeIn(el);
  if (!range || range.collapsed) return false;
  const off = styleAt(el, range.startContainer) === style;
  const text = range.toString();
  range.deleteContents();
  const doc = el.ownerDocument;
  let node: Node = doc.createTextNode(text);
  if (!off) {
    const span = doc.createElement("span");
    span.setAttribute("data-style", style);
    Object.assign(span.style, look(style));
    span.appendChild(node);
    node = span;
  }
  // Inside a span of another style, the new run splits it.
  const host = range.startContainer;
  const outer = host.nodeType === 1 && (host as Element).getAttribute?.("data-style")
    ? (host as Element)
    : host.parentElement?.closest?.("[data-style]");
  if (outer && outer !== el && el.contains(outer)) {
    const after = doc.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEndAfter(outer.lastChild ?? outer);
    const tail = after.extractContents();
    const clone = outer.cloneNode(false) as Element;
    clone.appendChild(tail);
    outer.after(node, clone);
  } else {
    range.insertNode(node);
  }
  render(el, serialize(el));
  return true;
}

/** Inserts a break at the caret. */
function insertBreak(el: HTMLElement, kind: "line" | "paragraph"): void {
  const range = rangeIn(el);
  const br = el.ownerDocument.createElement("br");
  br.setAttribute("data-break", kind);
  if (!range) {
    el.appendChild(br);
    return;
  }
  range.deleteContents();
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
}

export function StyledTextControl({
  name,
  runs,
  allowed,
  breaks,
  maxLength,
  onCommit,
}: {
  name: string;
  runs: readonly StyledRun[];
  allowed: readonly string[];
  /** The breaks the field takes; null takes any. */
  breaks: Breaks | null;
  maxLength: number | null;
  onCommit(runs: StyledRun[]): void;
}): ReactElement {
  const strings = useStrings();
  const ref = useRef<HTMLDivElement>(null);
  // Edits not yet written: while there are some, the document's value does
  // not replace what is being typed.
  const dirty = useRef(false);
  const [count, setCount] = useState(runsLength(runs));
  const key = JSON.stringify(runs);
  const takes = breaks ?? "paragraph";

  // The document's value shows whenever the control is not being edited.
  useEffect(() => {
    const el = ref.current;
    if (!el || (dirty.current && el.ownerDocument.activeElement === el))
      return;
    render(el, JSON.parse(key) as StyledRun[]);
    setCount(runsLength(JSON.parse(key) as StyledRun[]));
  }, [key]);

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const next = serialize(el);
    dirty.current = false;
    if (JSON.stringify(next) !== key) onCommit(next);
  };

  return (
    <div style={{ display: "grid", gap: space[1] }}>
      {allowed.length ? (
        <div
          role="toolbar"
          aria-label={strings.t(FORM.styles)}
          style={{ display: "flex", gap: space[1], flexWrap: "wrap" }}
        >
          {allowed.map((style) => (
            <button
              key={style}
              type="button"
              data-field-style={style}
              title={strings.t(FORM.writeIn, { style: styleName(style) })}
              aria-label={strings.t(FORM.writeIn, { style: styleName(style) })}
              style={{ minWidth: 28, ...(look(style) as object) }}
              // Keep the text's selection: the button acts on it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const el = ref.current;
                if (el && applyStyle(el, style)) commit();
              }}
            >
              {styleName(style).slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
      <div
        ref={ref}
        role="textbox"
        contentEditable
        suppressContentEditableWarning
        aria-multiline={takes !== "none"}
        aria-label={name}
        data-field-input={name}
        data-field-styled={name}
        style={{
          minHeight: 28,
          padding: "4px 6px",
          border: "1px solid var(--pg-border, #8884)",
          borderRadius: 4,
          whiteSpace: "pre-wrap",
          background: "var(--pg-input-bg, transparent)",
        }}
        onInput={() => {
          dirty.current = true;
          if (ref.current) setCount(runsLength(serialize(ref.current)));
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const el = ref.current;
          if (!el) return;
          dirty.current = true;
          if (e.shiftKey && takes !== "none") insertBreak(el, "line");
          else if (!e.shiftKey && takes === "paragraph")
            insertBreak(el, "paragraph");
          else if (!e.shiftKey) commit();
          setCount(runsLength(serialize(el)));
        }}
        onPaste={(e) => {
          // Pasted text comes in plain, in the style where it lands.
          e.preventDefault();
          dirty.current = true;
          const el = ref.current;
          const range = el ? rangeIn(el) : null;
          if (!el || !range) return;
          const text = e.clipboardData
            .getData("text/plain")
            .replace(/[\r\n]+/g, takes === "none" ? " " : "\n");
          range.deleteContents();
          const parts = text.split("\n");
          parts.forEach((part, i) => {
            if (i > 0) insertBreak(el, takes === "paragraph" ? "paragraph" : "line");
            const node = el.ownerDocument.createTextNode(part);
            const r = rangeIn(el) ?? range;
            r.insertNode(node);
            r.setStartAfter(node);
            r.collapse(true);
          });
          setCount(runsLength(serialize(el)));
        }}
        onBlur={commit}
      />
      {maxLength !== null ? (
        <span
          data-field-count={name}
          style={{ color: "var(--pg-muted-fg)", fontSize: 11 }}
        >
          {count}/{maxLength}
        </span>
      ) : null}
    </div>
  );
}
