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

// Word's Home group in the host's control bar (doc ADR 608, editor ADR
// 298): the paragraph style box (the document's own styles first), font,
// size, B/I/U/strike/sub/sup, text colour, bullets and numbering, the
// indents, alignment and line spacing — every control reading the
// selection's effective format from the word store and writing through the
// same commands the shortcuts run. Amendment 1 (engine ADR 1018): the
// Styles menu (Update to Match, Modify…, New Style, Apply Styles), highlight,
// double underline, hidden text, shading, borders, the multilevel list
// presets with Restart / Continue Numbering, Show ¶ (hidden text) and Clear
// paragraph formatting.

import type { ControlBarGroupProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

import { WORD } from "../messages.js";
import type { WordCommandName } from "./commands.js";
import {
  alignmentOf,
  isBold,
  isItalic,
  lineSpacingOf,
  styleBoxOrder,
  styleLabel,
  WORD_SIZES,
  type Read,
} from "./format.js";
import type { WordStore } from "./word-state.js";

export interface HomeGroupActions {
  run(name: WordCommandName): void;
  applyParagraphStyle(styleId: string): void;
  setFontFamily(family: string): void;
  setFontSize(size: number): void;
  setTextColor(swatchId: string): void;
  setHighlight(swatchId: string): void;
  setShading(swatchId: string): void;
}

/** The Styles menu's entries, by command. */
const STYLE_ACTIONS = [
  "styleUpdate",
  "styleModify",
  "styleNew",
  "applyStyles",
] as const satisfies readonly WordCommandName[];

const NO_SWATCH = "Swatch/None";

const MIXED = "__mixed__";

export function makeHomeGroup(store: WordStore, actions: HomeGroupActions) {
  function HomeGroup(_props: ControlBarGroupProps) {
    const strings = useStrings();
    const live = useLive(store, subscribeOf);
    const snap = live.get();
    const f = snap.format;
    const off = !snap.hasSelection;
    const style = f.appliedParagraphStyle as Read<string>;
    const family = f.characterFontFamily as Read<string>;
    const fontStyle = f.characterFontStyle as Read<string>;
    const size = f.characterFontSize as Read<number>;
    const color = f.characterFillColor as Read<string>;
    const align = alignmentOf(f.paragraphJustification as Read<string>);
    const list = f.paragraphListType as Read<string>;
    const spacing = lineSpacingOf(f.characterLeading as Read<number>, size);
    const styles = styleBoxOrder(snap.styles);
    const knownStyle = styles.some((s) => s.selfId === style);
    const sizes =
      typeof size === "number" && !WORD_SIZES.includes(size)
        ? [...WORD_SIZES, size].sort((a, b) => a - b)
        : WORD_SIZES;
    const highlight = f.characterHighlightColor as Read<string>;
    const highlighted =
      typeof highlight === "string" &&
      highlight !== "" &&
      highlight !== "mixed" &&
      highlight !== NO_SWATCH;
    const border =
      f.paragraphBorderOn === true
        ? "box"
        : (f.paragraphRuleBelow as { on?: unknown } | null)?.on === true
          ? "bottom"
          : "none";
    const styleBox = useRef<HTMLSelectElement>(null);
    // Apply Styles: the command asks for the style box's focus.
    useEffect(() => {
      if (snap.focusStyleBox > 0) styleBox.current?.focus();
    }, [snap.focusStyleBox]);
    const swatchOptions = snap.swatches
      .filter((s) => s.selfId !== NO_SWATCH)
      .map((s) => (
        <option key={s.selfId} value={s.selfId}>
          {s.name.replace(/^\$ID\//, "")}
        </option>
      ));

    return (
      <span data-word-home style={row}>
        <select
          ref={styleBox}
          data-word-style
          aria-label={strings.t(WORD.paragraphStyle)}
          title={strings.t(WORD.paragraphStyle)}
          disabled={off}
          value={typeof style === "string" && style !== "mixed" ? style : MIXED}
          onChange={(e) => {
            if (e.target.value !== MIXED)
              actions.applyParagraphStyle(e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 148 }}
        >
          {(typeof style !== "string" || style === "mixed") && (
            <option value={MIXED} disabled>
              {style === "mixed"
                ? strings.t(WORD.mixed)
                : strings.t(WORD.paragraphStyle)}
            </option>
          )}
          {styles.map((s) => (
            <option key={s.selfId} value={s.selfId}>
              {styleLabel(s)}
            </option>
          ))}
          {typeof style === "string" && style !== "mixed" && !knownStyle && (
            <option value={style}>{style.replace(/^.*\//, "")}</option>
          )}
        </select>
        <select
          data-word-styles-menu
          aria-label={strings.t(WORD.stylesMenu)}
          title={strings.t(WORD.stylesMenu)}
          disabled={off}
          value=""
          onChange={(e) => {
            const name = e.target.value as WordCommandName;
            if (name) actions.run(name);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 28, padding: 0 }}
        >
          <option value="">⋯</option>
          {STYLE_ACTIONS.map((name) => (
            <option key={name} value={name}>
              {strings.t(WORD[name])}
            </option>
          ))}
        </select>
        <select
          data-word-font
          aria-label={strings.t(WORD.fontFamily)}
          title={strings.t(WORD.fontFamily)}
          disabled={off}
          value={
            typeof family === "string" && family !== "mixed" ? family : MIXED
          }
          onChange={(e) => {
            if (e.target.value !== MIXED) actions.setFontFamily(e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 128 }}
        >
          {(typeof family !== "string" || family === "mixed") && (
            <option value={MIXED} disabled>
              {family === "mixed"
                ? strings.t(WORD.mixed)
                : strings.t(WORD.fontFamily)}
            </option>
          )}
          {typeof family === "string" &&
            family !== "mixed" &&
            !snap.fonts.includes(family) && (
              <option value={family}>{family}</option>
            )}
          {snap.fonts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          data-word-size
          aria-label={strings.t(WORD.fontSize)}
          title={strings.t(WORD.fontSize)}
          disabled={off}
          value={typeof size === "number" ? String(size) : MIXED}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) actions.setFontSize(n);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 58 }}
        >
          {typeof size !== "number" && (
            <option value={MIXED} disabled>
              —
            </option>
          )}
          {sizes.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
        <Sep />
        <Toggle
          id="bold"
          label={strings.t(WORD.bold)}
          on={isBold(fontStyle)}
          off={off}
          run={actions.run}
        >
          <b>B</b>
        </Toggle>
        <Toggle
          id="italic"
          label={strings.t(WORD.italic)}
          on={isItalic(fontStyle)}
          off={off}
          run={actions.run}
        >
          <i style={{ fontFamily: "serif" }}>I</i>
        </Toggle>
        <Toggle
          id="underline"
          label={strings.t(WORD.underline)}
          on={f.characterUnderline === true}
          off={off}
          run={actions.run}
        >
          <u>U</u>
        </Toggle>
        <Toggle
          id="doubleUnderline"
          label={strings.t(WORD.doubleUnderline)}
          on={f.characterUnderlineType === "double"}
          off={off}
          run={actions.run}
        >
          <span style={{ textDecoration: "underline double" }}>D</span>
        </Toggle>
        <Toggle
          id="strikethrough"
          label={strings.t(WORD.strikethrough)}
          on={f.characterStrikethru === true}
          off={off}
          run={actions.run}
        >
          <s>S</s>
        </Toggle>
        <Toggle
          id="subscript"
          label={strings.t(WORD.subscript)}
          on={f.characterPosition === "Subscript"}
          off={off}
          run={actions.run}
        >
          <span>
            x<sub>2</sub>
          </span>
        </Toggle>
        <Toggle
          id="superscript"
          label={strings.t(WORD.superscript)}
          on={f.characterPosition === "Superscript"}
          off={off}
          run={actions.run}
        >
          <span>
            x<sup>2</sup>
          </span>
        </Toggle>
        <Toggle
          id="hidden"
          label={strings.t(WORD.hidden)}
          on={f.characterHidden === true}
          off={off}
          run={actions.run}
        >
          <span style={{ textDecoration: "underline dotted" }}>ab</span>
        </Toggle>
        <Toggle
          id="highlight"
          label={strings.t(WORD.highlight)}
          on={highlighted}
          off={off}
          run={actions.run}
        >
          <span
            style={{ background: "#fde047", color: "#000", padding: "0 2px" }}
          >
            ab
          </span>
        </Toggle>
        <select
          data-word-highlight
          aria-label={strings.t(WORD.highlightColor)}
          title={strings.t(WORD.highlightColor)}
          disabled={off}
          value=""
          onChange={(e) => {
            if (e.target.value) actions.setHighlight(e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 28, padding: 0 }}
        >
          <option value="">▾</option>
          <option value={NO_SWATCH}>{strings.t(WORD.noColor)}</option>
          {swatchOptions}
        </select>
        <select
          data-word-color
          aria-label={strings.t(WORD.textColor)}
          title={strings.t(WORD.textColor)}
          disabled={off || snap.swatches.length === 0}
          value={typeof color === "string" && color !== "mixed" ? color : MIXED}
          onChange={(e) => {
            if (e.target.value !== MIXED) actions.setTextColor(e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 92 }}
        >
          {(typeof color !== "string" || color === "mixed") && (
            <option value={MIXED} disabled>
              {strings.t(WORD.textColor)}
            </option>
          )}
          {snap.swatches.map((s) => (
            <option key={s.selfId} value={s.selfId}>
              {s.name.replace(/^\$ID\//, "")}
            </option>
          ))}
        </select>
        <Sep />
        <Toggle
          id="bullets"
          label={strings.t(WORD.bullets)}
          on={list === "BulletList"}
          off={off}
          run={actions.run}
        >
          <span>•≡</span>
        </Toggle>
        <Toggle
          id="numbering"
          label={strings.t(WORD.numbering)}
          on={list === "NumberedList"}
          off={off}
          run={actions.run}
        >
          <span>1≡</span>
        </Toggle>
        <select
          data-word-multilevel
          aria-label={strings.t(WORD.multilevelList)}
          title={strings.t(WORD.multilevelList)}
          disabled={off}
          value=""
          onChange={(e) => {
            const name = e.target.value as WordCommandName;
            if (name) actions.run(name);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 28, padding: 0 }}
        >
          <option value="">▾</option>
          <option value="listOutline">1. a. i.</option>
          <option value="listLegal">1. 1.1. 1.1.1.</option>
          <option value="listBullets">• ◦ ▪</option>
          <option value="restartNumbering">
            {strings.t(WORD.restartNumbering)}
          </option>
          <option value="continueNumbering">
            {strings.t(WORD.continueNumbering)}
          </option>
        </select>
        <Toggle
          id="decreaseIndent"
          label={strings.t(WORD.decreaseIndent)}
          on={false}
          off={off}
          run={actions.run}
        >
          <span>⇤</span>
        </Toggle>
        <Toggle
          id="increaseIndent"
          label={strings.t(WORD.increaseIndent)}
          on={false}
          off={off}
          run={actions.run}
        >
          <span>⇥</span>
        </Toggle>
        <Sep />
        <Toggle
          id="alignLeft"
          label={strings.t(WORD.alignLeft)}
          on={align === "left"}
          off={off}
          run={actions.run}
        >
          <AlignGlyph lines={["100%", "60%", "85%"]} justify="flex-start" />
        </Toggle>
        <Toggle
          id="alignCenter"
          label={strings.t(WORD.center)}
          on={align === "center"}
          off={off}
          run={actions.run}
        >
          <AlignGlyph lines={["100%", "60%", "85%"]} justify="center" />
        </Toggle>
        <Toggle
          id="alignRight"
          label={strings.t(WORD.alignRight)}
          on={align === "right"}
          off={off}
          run={actions.run}
        >
          <AlignGlyph lines={["100%", "60%", "85%"]} justify="flex-end" />
        </Toggle>
        <Toggle
          id="justify"
          label={strings.t(WORD.justify)}
          on={align === "justify"}
          off={off}
          run={actions.run}
        >
          <AlignGlyph lines={["100%", "100%", "60%"]} justify="flex-start" />
        </Toggle>
        <select
          data-word-spacing
          aria-label={strings.t(WORD.lineSpacing)}
          title={strings.t(WORD.lineSpacing)}
          disabled={off}
          value={spacing === null ? MIXED : String(spacing)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "1") actions.run("lineSpacing1");
            else if (v === "1.5") actions.run("lineSpacing15");
            else if (v === "2") actions.run("lineSpacing2");
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 82 }}
        >
          {spacing === null && (
            <option value={MIXED} disabled>
              {strings.t(WORD.lineSpacing)}
            </option>
          )}
          <option value="1">{strings.t(WORD.single)}</option>
          <option value="1.5">{strings.t(WORD.oneAndHalf)}</option>
          <option value="2">{strings.t(WORD.double)}</option>
        </select>
        <Sep />
        <Toggle
          id="shading"
          label={strings.t(WORD.shading)}
          on={f.paragraphShadingOn === true}
          off={off}
          run={actions.run}
        >
          <span aria-hidden style={{ fontSize: 15 }}>
            ◧
          </span>
        </Toggle>
        <select
          data-word-shading
          aria-label={strings.t(WORD.shadingColor)}
          title={strings.t(WORD.shadingColor)}
          disabled={off}
          value=""
          onChange={(e) => {
            if (e.target.value) actions.setShading(e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 28, padding: 0 }}
        >
          <option value="">▾</option>
          {swatchOptions}
        </select>
        <select
          data-word-borders
          aria-label={strings.t(WORD.borders)}
          title={strings.t(WORD.borders)}
          disabled={off}
          value={border}
          onChange={(e) => {
            const v = e.target.value;
            actions.run(
              v === "box"
                ? "borderBox"
                : v === "bottom"
                  ? "borderBottom"
                  : "borderNone",
            );
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ ...select, width: 92 }}
        >
          <option value="none">{strings.t(WORD.borderNone)}</option>
          <option value="bottom">{strings.t(WORD.borderBottom)}</option>
          <option value="box">{strings.t(WORD.borderBox)}</option>
        </select>
        <Toggle
          id="showHidden"
          label={strings.t(WORD.showHidden)}
          on={snap.showHidden}
          off={false}
          run={actions.run}
        >
          <span>¶</span>
        </Toggle>
        <Toggle
          id="clearParagraph"
          label={strings.t(WORD.clearParagraph)}
          on={false}
          off={off}
          run={actions.run}
        >
          <span>¶̸</span>
        </Toggle>
      </span>
    );
  }
  return HomeGroup;
}

function Toggle({
  id,
  label,
  on,
  off,
  run,
  children,
}: {
  id: WordCommandName;
  label: string;
  on: boolean;
  off: boolean;
  run: (name: WordCommandName) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-word-button={id}
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={off}
      // Keep the caret: a mouse-down on a button would take focus from the
      // text input, and the selection with it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run(id)}
      style={{
        ...button,
        background: on ? "var(--selected-bg)" : "transparent",
        color: on ? "var(--pg-primary)" : "var(--chrome-icon)",
        opacity: off ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

function AlignGlyph({
  lines,
  justify,
}: {
  lines: readonly string[];
  justify: CSSProperties["alignItems"];
}) {
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: justify,
        gap: 2,
        width: 14,
      }}
    >
      {lines.map((w, i) => (
        <span
          key={i}
          style={{ height: 1.5, width: w, background: "currentColor" }}
        />
      ))}
    </span>
  );
}

function Sep() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 18,
        background: "var(--chrome-divider)",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
};

const select: CSSProperties = {
  height: 28,
  padding: "0 6px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-divider)",
  background: "var(--pg-muted)",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  flexShrink: 0,
};

const button: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "var(--radius-md)",
  border: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  padding: 0,
  fontSize: 13,
  flexShrink: 0,
};
