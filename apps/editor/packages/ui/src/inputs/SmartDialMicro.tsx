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

// Gallery pixel-parity — the kit Smart Dial's MICRO row
// (brand kit smart-dial.jsx, `micro` mode): a 26px rotary arc +
// label + editable mono value with unit, one row. Ported as a
// controlled component; drag (vertical) adjusts, Shift = fine,
// Alt = coarse, wheel steps, click value to type. Disabled renders
// at 45%.
//
// The typed value is the ONE numeric field (`./NumericField`): the same
// expressions, units, errors and Escape as every other number. A drag shows
// its live angle on the dial and in `onChange`, and commits once, on
// release (one drag is one undo step).
//
// StrictMode-safe dragging: pointer capture on the dial element —
// no window listeners registered inside pointerdown.

import { useStrings } from "@paged-media/strings";
import { INPUT } from "../messages";
import { NumericField } from "./NumericField";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Polar helper — angle in degrees measured CLOCKWISE from top.
function pol(cx: number, cy: number, r: number, a: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [cx + r * Math.sin(t), cy - r * Math.cos(t)];
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const [x0, y0] = pol(cx, cy, r, a0);
  const [x1, y1] = pol(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const START = 225;
const SWEEP = 270; // 90° gap centred at the bottom

export interface SmartDialMicroProps {
  label: string;
  /** `null` = mixed (em-dash value). */
  value: number | null;
  min: number;
  max: number;
  unit?: string;
  precision?: number;
  /** Show a leading "+" on positive values (rotation). */
  signed?: boolean;
  disabled?: boolean;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
}

export function SmartDialMicro({
  label,
  value,
  min,
  max,
  unit = "",
  precision = 0,
  signed,
  disabled,
  onChange,
  onCommit,
}: SmartDialMicroProps) {
  const strings = useStrings();
  const inert = disabled || onChange == null;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const fmt = (v: number) =>
    precision ? v.toFixed(precision) : String(Math.round(v));

  const [editing, setEditing] = useState(false);
  // The angle a drag has reached, shown until the commit re-reads.
  const [live, setLive] = useState<number | null>(null);
  const dragRef = useRef<{ y0: number; v0: number; last: number } | null>(null);

  const v = live ?? value ?? 0;
  const fr = (v - min) / (max - min);
  const hp = pol(13, 13, 10, START + Math.max(0.001, fr) * SWEEP);

  const onPointer =
    (kind: "down" | "move" | "up") =>
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (inert) return;
      if (kind === "down") {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { y0: e.clientY, v0: v, last: v };
      } else if (kind === "move") {
        const drag = dragRef.current;
        if (!drag) return;
        const mult = e.shiftKey ? 0.25 : e.altKey ? 4 : 1;
        const next = clamp(
          drag.v0 + (-(e.clientY - drag.y0) / 120) * (max - min) * mult,
        );
        drag.last = next;
        setLive(next);
        onChange?.(next);
      } else {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        setLive(null);
        if (drag.last !== drag.v0) onCommit?.(clamp(drag.last));
      }
    };

  // Wheel steps need a non-passive listener (preventDefault).
  const dialRef = useRef<HTMLDivElement | null>(null);
  // The step reads the dial's current value and handlers; the listener
  // stays attached for as long as the dial is live.
  const onWheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault();
    const m = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
    const next = clamp(v + (e.deltaY < 0 ? m : -m));
    onChange?.(next);
    onCommit?.(next);
  });
  useEffect(() => {
    const el = dialRef.current;
    if (!el || inert) return;
    const listener = (e: WheelEvent) => onWheel(e);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [inert]);

  const grad = `paged-sd-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div
      data-smart-dial={label}
      data-seam={inert ? "true" : undefined}
      // A disabled seam dial isn't "mixed" — only a live dial with
      // an unresolved value carries the sentinel.
      data-mixed={!inert && value === null ? "" : undefined}
      className="flex items-center gap-[9px] py-[2px]"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <div
        ref={dialRef}
        onPointerDown={onPointer("down")}
        onPointerMove={onPointer("move")}
        onPointerUp={onPointer("up")}
        onPointerCancel={onPointer("up")}
        title={inert ? undefined : strings.t(INPUT.dragToAdjust)}
        className="w-[26px] h-[26px] shrink-0"
        style={{
          cursor: inert ? "default" : "ns-resize",
          touchAction: "none",
        }}
      >
        <svg
          width="26"
          height="26"
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            <linearGradient id={grad} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#4aa3ff" />
              <stop offset="1" stopColor="#8b5cf6" />
            </linearGradient>
          </defs>
          <path
            d={arc(13, 13, 10, START, START + SWEEP)}
            fill="none"
            stroke="var(--pg-border)"
            strokeWidth={3}
            strokeLinecap="round"
          />
          {value !== null && (
            <>
              <path
                d={arc(13, 13, 10, START, START + Math.max(0.001, fr) * SWEEP)}
                fill="none"
                stroke={`url(#${grad})`}
                strokeWidth={3}
                strokeLinecap="round"
              />
              <circle
                cx={hp[0]}
                cy={hp[1]}
                r={3}
                fill="#fff"
                stroke="#8b5cf6"
                strokeWidth={1.6}
              />
            </>
          )}
        </svg>
      </div>
      <span
        className="flex-1 whitespace-nowrap text-xs"
        style={{ color: "var(--pg-muted-fg)" }}
      >
        {label}
      </span>
      {editing && !inert ? (
        <NumericField
          variant="inline"
          autoFocus
          value={value}
          suffix={unit || undefined}
          min={min}
          max={max}
          precision={precision}
          aria-label={label}
          onCommit={(next) => {
            onChange?.(next);
            onCommit?.(next);
          }}
          onEditEnd={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          disabled={inert}
          onClick={() => {
            if (inert || value === null) return;
            setEditing(true);
          }}
          className="inline-flex items-baseline gap-[2px] rounded-[5px] border-0 bg-transparent px-[3px] py-px"
          style={{ cursor: inert ? "default" : "text" }}
        >
          <span
            className="text-[12.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--pg-fg)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value === null && live === null
              ? "—"
              : (signed && v > 0 ? "+" : "") + fmt(v)}
          </span>
          {unit && (
            <span
              className="text-[10px]"
              style={{ color: "var(--pg-muted-fg)" }}
            >
              {unit}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
