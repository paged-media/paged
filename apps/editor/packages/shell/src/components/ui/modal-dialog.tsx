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

// A modal dialog of the application's own kind: a form with its own buttons
// (OK and Cancel), open while it is mounted. It is the shell's `Dialog`
// (./dialog.tsx), so it has that dialog's focus handling and no second copy
// of it (ADR 234, ADR 1206): focus moves in as it opens, Tab stays inside,
// the rest of the editor is hidden from assistive technology and takes no
// pointer, and focus returns to what opened it, or to the canvas when that
// is gone (a menu item). It portals into the editor's root.
//
//   <ModalDialog onClose={close} data-star-dialog="" style={{ width: 340 }}>
//     <ModalDialogTitle id="star-title">Star</ModalDialogTitle>
//     …
//   </ModalDialog>
//
// The surface is the caller's (`style`): the dialog brings no padding, grid
// or width of its own, and no corner close button.
//
// Escape: a dialog that registers a modal-tier handler with the Escape
// arbiter (ADR 1207) is closed by that handler, as before; one that
// registers none is closed by `onClose` through the dialog's own Escape.

import type { ComponentProps, CSSProperties, ReactNode } from "react";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import { Dialog, DialogContent } from "./dialog";

export interface ModalDialogProps extends Omit<
  ComponentProps<typeof DialogContent>,
  "closeButton"
> {
  /** The dialog asks to close: Escape no arbiter handler took, or a press
   *  outside it when `dismissOnOutside` is set. */
  onClose: () => void;
  /** A press on the backdrop closes the dialog. Off by default: a form
   *  ends through its buttons. */
  dismissOnOutside?: boolean;
}

/** What the shell dialog's classes would otherwise decide for the caller. */
const surfaceReset: CSSProperties = {
  display: "block",
  maxWidth: "none",
};

export function ModalDialog({
  onClose,
  dismissOnOutside = false,
  onInteractOutside,
  style,
  children,
  ...props
}: ModalDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        // A form with no description of its own: its fields are its content.
        aria-describedby={undefined}
        aria-modal="true"
        {...props}
        closeButton={false}
        style={{ ...surfaceReset, ...style }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!dismissOnOutside) event.preventDefault();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's heading, which names it (`aria-labelledby`); its look is the
 * caller's (`style`). `id` stays the
 * stable id of the heading's text that scripts and tests find it by; the
 * heading element's own id is the dialog's.
 */
export function ModalDialogTitle({
  id,
  style,
  children,
}: {
  id?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <DialogPrimitive.Title style={style}>
      <span id={id}>{children}</span>
    </DialogPrimitive.Title>
  );
}
