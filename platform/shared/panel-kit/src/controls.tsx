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

// Two buttons whose state or name a sighted user reads off the glyph or
// the colour, and assistive tech used to get nothing for:
//
//   · `IconButton`: a button that shows a glyph (✕, ⧉, an icon). Its
//     name is `label`, in words, as `aria-label` (and the tooltip); the
//     glyph is hidden from the accessibility tree. A `title` alone names
//     nothing (accessible-name computation skips it when there is text).
//   · `Segment`: one segment of a toggle group or a filter row. It says
//     whether it is on with `aria-pressed`, beside the `data-active` the
//     panels style and test by.
//   · `Tab`: one tab of a `role="tablist"` row: `role="tab"` and
//     `aria-selected`.

import * as React from "react";

export type IconButtonProps = {
  /** The button's name, in words ("Delete swatch"). */
  label: string;
  /** The glyph. */
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">;

/** A button that shows a glyph and is named in words. */
export function IconButton(props: IconButtonProps): React.ReactElement {
  const { label, children, title, type, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      {...rest}
      aria-label={label}
      title={title ?? label}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export type SegmentProps = {
  /** Whether this segment is the one that is on. */
  pressed: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">;

/** One segment of a toggle group: `aria-pressed` and `data-active`
 *  ("true" / "false") follow `pressed`. */
export function Segment(props: SegmentProps): React.ReactElement {
  const { pressed, type, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      {...rest}
      aria-pressed={pressed}
      data-active={pressed ? "true" : "false"}
    />
  );
}

export type TabProps = {
  /** Whether this tab is the selected one. */
  selected: boolean;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "role" | "aria-selected"
>;

/** One tab of a `role="tablist"` row: `role="tab"`, `aria-selected` and
 *  `data-active` follow `selected`. */
export function Tab(props: TabProps): React.ReactElement {
  const { selected, type, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      {...rest}
      role="tab"
      aria-selected={selected}
      data-active={selected ? "true" : "false"}
    />
  );
}
