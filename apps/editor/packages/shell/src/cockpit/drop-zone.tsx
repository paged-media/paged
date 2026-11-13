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

// The canvas column's drop target: what a drag over the document area may
// drop, and what a drop does. Its own file so the drop behaviour has one
// home (the cockpit layout only places it).
//
// Two kinds of drop land here, in this order:
//   1. a Data panel field, table or record (editor ADR 291) is placed on
//      the document — only over the real document viewport, never over an
//      export-style override of the canvas slot;
//   2. a file: while it is dragged the label at the pointer says what the
//      drop will do, and the drop does exactly that (editor ADR 1205,
//      `useDropIntent`): `onFile` gets the file, the point and the intent
//      (place, place into the frame under the pointer, import, open,
//      replace the document, or refuse with the reason).

import type { CSSProperties, ReactNode } from "react";

import { useDataDrop } from "../state/data-door";
import type { DropIntent } from "../state/drop-intent";
import { useDropIntent } from "../state/use-drop-intent";

export interface CanvasDropZoneProps {
  /** Data drops are placed only on the document viewport: false while a
   *  mode or a module view overrides the canvas slot. */
  acceptsDataDrops: boolean;
  /** File intake, with the intent the drop resolved to; absent: files are
   *  not accepted here. */
  onFile?: (
    file: File,
    at?: { clientX: number; clientY: number },
    intent?: DropIntent,
  ) => void;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The `data-cockpit-canvas` element: the canvas column's drop target. */
export function CanvasDropZone({
  acceptsDataDrops,
  onFile,
  style,
  children,
}: CanvasDropZoneProps) {
  const fieldDrop = useDataDrop();
  const fileDrop = useDropIntent(
    onFile ? (file, at, intent) => onFile(file, at, intent) : null,
  );
  return (
    <div
      data-cockpit-canvas
      onDragEnter={(e) => fileDrop.onDragEnter(e)}
      onDragLeave={(e) => fileDrop.onDragLeave(e)}
      onDragOver={(e) => {
        if (acceptsDataDrops && fieldDrop.accepts([...e.dataTransfer.types])) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          return;
        }
        fileDrop.onDragOver(e);
      }}
      onDrop={(e) => {
        if (
          acceptsDataDrops &&
          fieldDrop.accepts([...e.dataTransfer.types]) &&
          fieldDrop.drop(
            (type) => e.dataTransfer.getData(type),
            [...e.dataTransfer.types],
            { clientX: e.clientX, clientY: e.clientY },
          )
        ) {
          e.preventDefault();
          return;
        }
        fileDrop.onDrop(e);
      }}
      style={style}
    >
      {children}
    </div>
  );
}
