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

// The panels' colour input, one for the editor and every built-in module:
// the host's colour picker (`widgets.ColorPicker`: the editor's colour
// mixer, colour-managed preview and all), else the browser's own colour
// input. The host's widget reaches the panels through one slot, set when
// the editor mounts or a module activates (`setHostColorPicker`), because
// dialogs and sections mount outside any panel's tree. `compact` shows a
// chip that opens the picker below it, for a row or a grid of colours.

import { useState, type ComponentType, type InputHTMLAttributes } from "react";
import type { ColorPickerProps } from "@paged-media/plugin-api";

let hostPicker: ComponentType<ColorPickerProps> | null = null;

/** The host's colour picker, or null for the browser's input. */
export function setHostColorPicker(
  picker: ComponentType<ColorPickerProps> | null,
): void {
  hostPicker = picker;
}

type Extra = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "title" | "style" | "className"
> &
  Record<`data-${string}`, string | number | boolean | undefined>;

export interface ColorInputProps {
  /** `#rrggbb`. */
  value: string;
  /** Every change, `#rrggbb`. */
  onChange: (hex: string) => void;
  /** The settled value (the host picker's commit, the browser input's
   *  blur). */
  onCommit?: (hex: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** A chip that opens the picker, instead of the picker in place. */
  compact?: boolean;
}

/** `value` is `#rrggbb`; `onChange` gets `#rrggbb`. Any `data-*` attribute
 *  lands on the control (on a wrapper where the host draws it). */
export function ColorInput({
  value,
  onChange,
  onCommit,
  disabled,
  ariaLabel,
  compact,
  ...extra
}: ColorInputProps & Extra) {
  const [open, setOpen] = useState(false);
  const Picker = hostPicker;
  if (Picker) {
    const {
      id: _id,
      title,
      style: _style,
      className: _className,
      ...data
    } = extra;
    const picker = (
      <Picker
        value={value}
        onChange={onChange}
        onCommit={onCommit}
        disabled={disabled}
        ariaLabel={ariaLabel}
      />
    );
    if (!compact) return <span {...data}>{picker}</span>;
    return (
      <span
        {...data}
        data-color-input-compact=""
        style={{ position: "relative", display: "inline-block" }}
      >
        <button
          type="button"
          aria-label={ariaLabel}
          aria-expanded={open}
          title={title ?? value}
          disabled={disabled}
          data-color-input-chip=""
          onClick={() => setOpen(!open)}
          style={{
            width: 26,
            height: 22,
            padding: 0,
            borderRadius: 4,
            border: "1px solid var(--pg-border)",
            background: value,
            cursor: disabled ? "default" : "pointer",
          }}
        />
        {open && !disabled ? (
          <div
            data-color-input-popover=""
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              zIndex: 50,
              marginTop: 4,
              width: 240,
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--pg-border)",
              background: "var(--pg-bg)",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
            }}
          >
            {picker}
          </div>
        ) : null}
      </span>
    );
  }
  return (
    <input
      type="color"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit ? (e) => onCommit(e.target.value) : undefined}
      {...extra}
    />
  );
}
