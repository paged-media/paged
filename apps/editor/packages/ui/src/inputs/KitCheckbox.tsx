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

// The kit checkbox (brand kit `PK.Check`; UX audit F-12): a 14 px box with
// a hairline border that fills with the primary colour and shows the kit's
// check glyph when on. A real `<input type="checkbox">` underneath
// (`appearance: none`), so the keyboard, the form semantics and a label
// click stay the browser's, and a test's `check()` still works. The label
// is the control's name.

import type { InputHTMLAttributes, ReactNode } from "react";
import { Icon } from "@paged-media/shell";

export interface KitCheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className" | "children"
> {
  /** The words beside the box (its accessible name). */
  children?: ReactNode;
  /** Extra classes on the label. */
  className?: string;
}

export function KitCheckbox({
  children,
  className = "",
  checked,
  disabled,
  style,
  ...rest
}: KitCheckboxProps) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 text-[12.5px] ${className}`}
      style={{
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "var(--font-sans)",
        color: "var(--pg-fg)",
      }}
    >
      <span className="relative inline-flex h-[14px] w-[14px] flex-none">
        <input
          {...rest}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          data-kit-checkbox=""
          className="peer h-[14px] w-[14px] cursor-[inherit] appearance-none rounded-[3px] border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{
            margin: 0,
            borderColor: checked ? "var(--pg-primary)" : "var(--pg-border)",
            background: checked ? "var(--pg-primary)" : "var(--pg-bg)",
            ...style,
          }}
        />
        {checked && (
          <Icon
            name="ui-check"
            size={12}
            className="pointer-events-none absolute left-[1px] top-[1px]"
            style={{ color: "var(--pg-primary-fg)" }}
          />
        )}
      </span>
      {children}
    </label>
  );
}
