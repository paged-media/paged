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

// Concept 2 — the colour mixer: the load-bearing shared component
// behind `paged.color`, the Swatches panel's new-swatch / edit
// popovers, and any picker that needs to AUTHOR a colour rather
// than choose an existing swatch.
//
// Canonical state is `{space, value[], tint}` in the wire's
// SwatchSpec vocabulary; HSB is a derived, UI-only tab over RGB.
// The live preview chip + the out-of-gamut warning triangle come
// from `requestColorCompute` (the document's ACTIVE colour
// management — working space, intent, standard-Lab — not a naive
// client-side approximation). `value: null` renders the MIXED
// sentinel (heterogeneous multi-selection): em-dash channels and a
// split chip; the first edit seeds a neutral default and the commit
// write-replaces across the selection (the binding fan-out).

import { useStrings, type Strings } from "@paged-media/strings";
import { COLOR } from "../messages";
import { useMemo, useState, type CSSProperties } from "react";

import { Segment } from "@paged-media/panel-kit";
import { NumberInput } from "../inputs/NumberInput";

import {
  defaultValue,
  hexToRgb,
  rgbInSpace,
  SPACE_CHANNELS,
  valueToSwatchSpec,
  type MixerValue,
} from "./color-space";
import { hsbToRgb, rgbToHsb } from "./hsb";
import { useColorCompute } from "./use-color-compute";

import type { SwatchSpec } from "@paged-media/client";

type MixerTab = MixerValue["space"] | "HSB";

export interface ColorMixerProps {
  /** Canonical state; `null` = the mixed sentinel. */
  value: MixerValue | null;
  /** Live channel edits (scrubbing). */
  onChange?: (next: MixerValue) => void;
  /** Final value (pointer-up / blur / Enter). */
  onCommit?: (next: MixerValue) => void;
  /** "Add to Swatches" — receives the ready SwatchSpec. Hidden when
   *  absent. */
  onAddSwatch?: (spec: SwatchSpec) => void;
  /** "Apply" — apply the mixed colour to the selection (the Color
   *  panel's ephemeral-apply). Hidden when absent. */
  onApply?: (next: MixerValue) => void;
  /** Show the tint slider (default true). */
  showTint?: boolean;
  /** Compact layout (popover/foot-cluster embeds). */
  compact?: boolean;
}

/** A channel's name in words, for its field ("C" reads as "Cyan"). */
const CHANNEL_NAMES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  CMYK: { c: COLOR.cyan, m: COLOR.magenta, y: COLOR.yellow, k: COLOR.black },
  RGB: { r: COLOR.red, g: COLOR.green, b: COLOR.blue },
  LAB: { l: COLOR.lightness, a: COLOR.greenToRed, b: COLOR.blueToYellow },
  HSB: { h: COLOR.hue, s: COLOR.saturation, b: COLOR.brightness },
  Gray: { k: COLOR.gray },
};
function channelName(
  strings: Strings,
  tab: MixerTab,
  key: string,
  label: string,
): string {
  const name = CHANNEL_NAMES[tab]?.[key];
  return name ? strings.t(name) : label;
}

export function ColorMixer(props: ColorMixerProps) {
  const strings = useStrings();
  const { value, onChange, onCommit, onAddSwatch, onApply } = props;
  const showTint = props.showTint ?? true;
  const [tab, setTab] = useState<MixerTab>(value?.space ?? "CMYK");

  const compute = useColorCompute(value);
  const mixed = value === null;

  // The channels the active tab shows. HSB derives from RGB.
  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const channels = useMemo(() => {
    if (tab === "HSB") {
      return [
        { key: "h", label: "H", min: 0, max: 360, precision: 0 },
        { key: "s", label: "S", min: 0, max: 100, precision: 0 },
        { key: "b", label: "B", min: 0, max: 100, precision: 0 },
      ];
    }
    return SPACE_CHANNELS[tab];
  }, [tab]);

  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const displayed: number[] = useMemo(() => {
    if (!value) return channels.map(() => 0);
    if (tab === "HSB") {
      const rgb =
        value.space === "RGB"
          ? value.value
          : (hexToRgb(compute.rgbHex) ?? [128, 128, 128]);
      return rgbToHsb(rgb);
    }
    if (tab === value.space) return value.value;
    // Tab differs from the canonical space: show THIS colour in the tab's
    // space (WP4.10), from the canonical RGB when it is RGB, else from the
    // engine's display RGB (and its CMYK when the value has one).
    const rgb = value.space === "RGB" ? value.value : hexToRgb(compute.rgbHex);
    if (!rgb) return defaultValue(tab);
    return rgbInSpace(rgb, tab, value.space === "RGB" ? null : compute.cmyk);
  }, [value, tab, channels, compute.rgbHex, compute.cmyk]);
  // The CMYK field of an RGB colour is the naive conversion (see
  // `rgbInSpace`); the field says so rather than passing for the
  // document's separation.
  const naiveCmyk =
    tab === "CMYK" &&
    value !== null &&
    value.space !== "CMYK" &&
    !(value.space !== "RGB" && compute.cmyk);

  const emit = (next: MixerValue, phase: "change" | "commit") => {
    if (phase === "change") onChange?.(next);
    else {
      onChange?.(next);
      onCommit?.(next);
    }
  };

  const setChannel = (idx: number, raw: number, phase: "change" | "commit") => {
    const base: MixerValue =
      value ??
      ({
        space: tab === "HSB" ? "RGB" : tab,
        value: defaultValue(tab === "HSB" ? "RGB" : tab),
        tint: 100,
      } as MixerValue);
    if (tab === "HSB") {
      const hsb = [...displayed];
      hsb[idx] = raw;
      emit({ space: "RGB", value: hsbToRgb(hsb), tint: base.tint }, phase);
      return;
    }
    if (base.space !== tab) {
      // Switching space: adopt the displayed channels as the new
      // canonical value, then apply the edit.
      const v = [...displayed];
      v[idx] = raw;
      emit({ space: tab, value: v, tint: base.tint }, phase);
      return;
    }
    const v = [...base.value];
    v[idx] = raw;
    emit({ ...base, value: v }, phase);
  };

  const setHex = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const base = value ?? {
      space: "RGB" as const,
      value: defaultValue("RGB"),
      tint: 100,
    };
    emit({ space: "RGB", value: rgb, tint: base.tint }, "commit");
  };

  const setTint = (tint: number, phase: "change" | "commit") => {
    const base: MixerValue = value ?? {
      space: "CMYK",
      value: defaultValue("CMYK"),
      tint: 100,
    };
    emit({ ...base, tint }, phase);
  };

  return (
    <div
      style={rootStyle}
      data-color-mixer="ready"
      data-mixer-mixed={mixed || undefined}
    >
      {/* Space tabs */}
      <div style={tabRow}>
        {(["CMYK", "RGB", "LAB", "HSB", "Gray"] as MixerTab[]).map((t) => (
          <Segment
            key={t}
            data-mixer-space={t}
            pressed={tab === t}
            onClick={() => setTab(t)}
            style={{
              ...tabBtn,
              background:
                tab === t ? "var(--chrome-slot-active)" : "var(--elevated)",
              color:
                tab === t
                  ? "var(--chrome-icon-active)"
                  : "var(--chrome-menu-text)",
            }}
          >
            {t === "Gray" ? "K" : t}
          </Segment>
        ))}
        {/* Preview chip + gamut warning */}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {compute.outOfGamut && !mixed && (
            <span
              data-gamut="out"
              title={strings.t(COLOR.outOfGamut)}
              style={{
                color: "var(--status-review)",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ▲!
            </span>
          )}
          <div
            data-mixer-preview
            title={mixed ? strings.t(COLOR.mixedSelection) : compute.rgbHex}
            style={{
              width: 26,
              height: 18,
              borderRadius: 3,
              border: "1px solid var(--chrome-divider)",
              opacity: compute.pending ? 0.6 : 1,
              background: mixed
                ? "linear-gradient(135deg, var(--elevated) 48%, var(--muted-fg) 48%, var(--muted-fg) 52%, var(--elevated) 52%)"
                : compute.rgbHex,
            }}
          />
        </div>
      </div>

      {/* Channel rows */}
      {channels.map((ch, i) => (
        <div key={ch.key} style={channelRow} data-mixer-channel={ch.key}>
          <span style={channelLabel}>{ch.label}</span>
          {mixed ? (
            <span
              style={{
                fontSize: 11,
                opacity: 0.6,
                flex: 1,
                textAlign: "center",
              }}
              data-mixer-channel-mixed
            >
              —
            </span>
          ) : (
            <NumberInput
              aria-label={channelName(strings, tab, ch.key, ch.label)}
              value={displayed[i] ?? 0}
              min={ch.min}
              max={ch.max}
              precision={ch.precision}
              onChange={(v) => setChannel(i, v, "change")}
              onCommit={(v) => setChannel(i, v, "commit")}
            />
          )}
        </div>
      ))}

      {naiveCmyk && (
        <div
          data-mixer-naive-cmyk
          style={{ fontSize: 10, opacity: 0.65, lineHeight: 1.3 }}
        >
          {strings.t(COLOR.naiveCmyk)}
        </div>
      )}
      {compute.outOfGamut && !mixed && (
        <div
          data-mixer-gamut-note
          style={{ fontSize: 10, color: "var(--status-review)" }}
        >
          {strings.t(COLOR.outOfGamut)}
        </div>
      )}

      {/* Hex (RGB convenience) */}
      <div style={channelRow}>
        <span style={channelLabel}>#</span>
        <input
          aria-label="Hex"
          data-mixer-hex
          defaultValue={mixed ? "" : compute.rgbHex.replace("#", "")}
          key={mixed ? "mixed" : compute.rgbHex}
          placeholder={mixed ? "—" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter") setHex((e.target as HTMLInputElement).value);
          }}
          onBlur={(e) => {
            if (e.target.value) setHex(e.target.value);
          }}
          style={hexInput}
        />
      </div>

      {/* Tint */}
      {showTint && (
        <div style={channelRow} data-mixer-tint>
          <span style={channelLabel}>T%</span>
          {mixed ? (
            <span style={{ fontSize: 11, opacity: 0.6 }}>—</span>
          ) : (
            <NumberInput
              aria-label={strings.t(COLOR.tint)}
              value={value?.tint ?? 100}
              min={0}
              max={100}
              precision={0}
              onChange={(v) => setTint(v, "change")}
              onCommit={(v) => setTint(v, "commit")}
            />
          )}
        </div>
      )}

      {/* Footer actions */}
      {(onAddSwatch || onApply) && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {onApply && (
            <button
              type="button"
              data-mixer-apply
              disabled={mixed && !value}
              onClick={() => value && onApply(value)}
              style={footBtn}
            >
              {strings.t(COLOR.apply)}
            </button>
          )}
          {onAddSwatch && (
            <button
              type="button"
              data-mixer-add-swatch
              disabled={mixed}
              onClick={() => value && onAddSwatch(valueToSwatchSpec(value))}
              style={footBtn}
            >
              {strings.t(COLOR.addToSwatches)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 200,
};

const tabRow: CSSProperties = {
  display: "flex",
  gap: 2,
  alignItems: "center",
  marginBottom: 2,
};

const tabBtn: CSSProperties = {
  fontSize: 10,
  padding: "2px 6px",
  borderRadius: 3,
  border: "1px solid var(--chrome-divider)",
  cursor: "pointer",
  lineHeight: 1.2,
};

const channelRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const channelLabel: CSSProperties = {
  width: 18,
  fontSize: 10,
  opacity: 0.7,
  textAlign: "right",
};

const hexInput: CSSProperties = {
  flex: 1,
  fontSize: 11,
  padding: "2px 6px",
  border: "1px solid var(--chrome-divider)",
  borderRadius: 3,
  fontFamily: "var(--font-mono)",
  background: "var(--elevated)",
  color: "var(--fg)",
};

const footBtn: CSSProperties = {
  fontSize: 11,
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid var(--chrome-divider)",
  background: "var(--elevated)",
  cursor: "pointer",
};
