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

// Disclosures: a section the user opens and closes, and the collapsed
// "About" that holds a panel's longer explanation, so the panel itself
// reads as controls plus one plain sentence.
//
//   · `Disclosure` is the native `<details>`/`<summary>`: keyboard,
//     focus and the expanded state come with the element, and the
//     content stays mounted while closed (a field keeps its draft).
//   · `About` is a `Disclosure` with the kit's note look.
//   · `useDisclosure` is for a header the panel draws itself (a button
//     with a chevron) whose content unmounts while closed: it gives the
//     button `aria-expanded` and `aria-controls`.

import * as React from "react";

import { color, font } from "./tokens";

export type DisclosureProps = {
  /** The always-visible line. */
  summary: React.ReactNode;
  /** Open when it mounts (default: closed). After that it is the user's. */
  defaultOpen?: boolean;
  /** Called with the new state when the user opens or closes it. */
  onToggle?: (open: boolean) => void;
  summaryStyle?: React.CSSProperties;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
};

/** A section the user opens and closes. */
export function Disclosure(props: DisclosureProps): React.ReactElement {
  const {
    summary,
    defaultOpen = false,
    onToggle,
    summaryStyle,
    style,
    className,
    children,
    ...data
  } = props;
  return (
    <details
      {...data}
      open={defaultOpen}
      style={style}
      className={className}
      onToggle={
        onToggle
          ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open)
          : undefined
      }
    >
      <summary style={{ cursor: "pointer", ...summaryStyle }}>
        {summary}
      </summary>
      {children}
    </details>
  );
}

const aboutStyle: React.CSSProperties = {
  marginTop: 10,
  font: `11px/1.45 ${font.sans}`,
  color: color.mutedFg,
};
const aboutSummaryStyle: React.CSSProperties = { font: `11px ${font.sans}` };
const aboutBodyStyle: React.CSSProperties = { marginTop: 4 };

/** A computed attribute name as props (the compiler does not lower a
 *  computed key inside a component). */
function attrProps(attr: string | undefined): Record<string, string> {
  return attr ? { [attr]: "" } : {};
}

/** The collapsed "About" at the bottom of a panel or a section. `attr`
 *  sits on the body, so the body's text is exactly the explanation. */
export function About(props: {
  children?: React.ReactNode;
  /** A `data-*` attribute for the body (for tests). */
  attr?: string;
  /** Layout over the kit's note look (a margin, a flex basis). */
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <Disclosure
      summary="About"
      style={props.style ? { ...aboutStyle, ...props.style } : aboutStyle}
      summaryStyle={aboutSummaryStyle}
    >
      <div style={aboutBodyStyle} {...attrProps(props.attr)}>
        {props.children}
      </div>
    </Disclosure>
  );
}

export interface DisclosureState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Spread on the header button. */
  toggle: {
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onClick: () => void;
  };
  /** Spread on the content (rendered only while open). */
  region: { id: string };
}

/** The state of a disclosure whose header the panel draws itself. */
export function useDisclosure(defaultOpen = true): DisclosureState {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();
  return {
    open,
    setOpen,
    toggle: {
      "aria-expanded": open,
      // Only while the content exists: a reference must resolve.
      "aria-controls": open ? id : undefined,
      onClick: () => setOpen(!open),
    },
    region: { id },
  };
}
