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

// The second click that runs an action which cannot be undone. The first
// click arms the button (it then reads "Confirm delete", or the caller's
// words); a second click within CONFIRM_MS runs the action; otherwise the
// arm lapses. Never `window.confirm`: the question stays in the panel, on
// the button itself.
//
// `useConfirm` is the state, keyed, so one panel can arm one of several
// buttons (a sheet's delete and its replace); `ConfirmButton` is the button
// for one action.

import * as React from "react";

import { status } from "./tokens";

/** How long an armed button waits for its confirming second click. */
export const CONFIRM_MS = 4000;

/** The title an armed `ConfirmButton` shows. */
export const ARMED_TITLE = "Click again to confirm. This cannot be undone.";

export interface Confirm {
  /** The key of the armed action, or null. */
  armed: string | null;
  /** Arm `key`; when `key` is already armed, disarm and run `run`. */
  confirm(key: string, run: () => void): void;
  /** Disarm without running anything. */
  disarm(): void;
}

/** The arm state of a panel's destructive buttons. Arming another key
 *  replaces the arm and restarts the wait. */
export function useConfirm(ms: number = CONFIRM_MS): Confirm {
  const [armed, setArmed] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), ms);
    return () => clearTimeout(timer);
  }, [armed, ms]);
  return {
    armed,
    confirm(key, run) {
      if (armed === key) {
        setArmed(null);
        run();
      } else {
        setArmed(key);
      }
    },
    disarm() {
      setArmed(null);
    },
  };
}

export type ConfirmButtonProps = {
  /** What the button says before it is armed. */
  label: React.ReactNode;
  /** What it says while armed (default "Confirm delete"). */
  confirmLabel?: React.ReactNode;
  /** The title while armed. */
  armedTitle?: string;
  /** The action, run on the confirming click. */
  onConfirm: () => void;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">;

/** A button for one action that cannot be undone. It carries
 *  `data-armed="true"` while armed and turns the error colour. */
export function ConfirmButton(props: ConfirmButtonProps): React.ReactElement {
  const {
    label,
    confirmLabel = "Confirm delete",
    armedTitle = ARMED_TITLE,
    onConfirm,
    title,
    style,
    ...rest
  } = props;
  const { armed, confirm } = useConfirm();
  const on = armed !== null;
  return (
    <button
      type="button"
      {...rest}
      data-armed={on ? "true" : "false"}
      title={on ? armedTitle : title}
      style={on ? { ...style, color: status.error } : style}
      onClick={() => confirm("confirm", onConfirm)}
    >
      {on ? confirmLabel : label}
    </button>
  );
}
