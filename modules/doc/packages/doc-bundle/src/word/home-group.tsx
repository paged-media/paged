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
// same commands the shortcuts run. Highlight, shading and borders are not
// here: the engine models none of them on text yet (wave 1's engine work).

import type { ControlBarGroupProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
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
}

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

    return (
      <span data-word-home style={row}>
        <select
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
