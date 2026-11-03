// The panels' colour input: the host's colour-picker widget
// (`widgets.ColorPicker`, offered when the host supports
// `widgets.colorPicker@1`), else the browser's own colour input. The host's
// widget reaches the sections through this one slot, set when the module
// activates, because dialogs and sections mount outside the panel's tree.

import type { ComponentType, InputHTMLAttributes } from "react";
import type { ColorPickerProps } from "@paged-media/plugin-api";

let hostPicker: ComponentType<ColorPickerProps> | null = null;

/** Called once by `activate` with the session's `colorPicker()`. */
export function setHostColorPicker(
  picker: ComponentType<ColorPickerProps> | null,
): void {
  hostPicker = picker;
}

type Extra = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "title" | "style"
> &
  Record<`data-${string}`, string | number | boolean | undefined>;

/** `value` is `#rrggbb`; `onChange` gets `#rrggbb`. Any `data-*` attribute
 *  lands on the control (on a wrapper where the host draws it). */
export function ColorInput({
  value,
  onChange,
  disabled,
  ariaLabel,
  ...extra
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
} & Extra) {
  const Picker = hostPicker;
  if (Picker) {
    const { id: _id, title: _title, style: _style, ...data } = extra;
    return (
      <span {...data}>
        <Picker
          value={value}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={ariaLabel}
        />
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
      {...extra}
    />
  );
}
