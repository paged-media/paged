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

// The WORKBOOK door (`workbooks@1`, `contribute.workbookEditor@1`,
// extensions ADR 1102): one bundle offers a surface that edits tabular data
// held as a workbook; any other bundle opens it with a workbook's bytes,
// mounts the surface in its own UI and takes the edited bytes back. A
// chart's data (a slide's, later a Word document's) is edited on the
// spreadsheet's own grid and engine, not on a copy of them.
//
// The workbook never enters the document through this door: the consumer
// owns where its bytes live and writes them itself. Type-only, like the
// rest of plugin-api.

import type { ComponentType } from "react";

import type { Disposable } from "./host.js";

/** What a range means to the consumer (a chart's series names, its
 *  categories, its values); the editor tints each role as Office does. */
export type WorkbookRangeRole = "name" | "category" | "value";

/** A block of cells of one sheet, zero-based and inclusive. */
export interface WorkbookRange {
  /** The sheet's name, as the workbook names it. */
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  role?: WorkbookRangeRole;
}

/** What a consumer opens. */
export interface WorkbookEditRequest {
  /** The workbook, as XLSX bytes. */
  xlsx: Uint8Array;
  /** Its name (the editor's title, a formula's `CELL("filename")`). */
  name?: string;
  /** The cells the consumer reads, shown tinted by role. The sheet of the
   *  first range opens first. */
  ranges?: readonly WorkbookRange[];
}

/** The props a consumer gives the editing surface: the box it may fill, in
 *  CSS pixels. The surface takes keys and pointers inside it. */
export interface WorkbookEditorProps {
  width: number;
  height: number;
}

/** One open workbook. */
export interface WorkbookEditSession {
  /** The id of the editor that answers (its bundle's namespace). */
  readonly editor: string;
  /** The editing surface: React in the host's realm, like a panel or a
   *  frame surface (ADR 334). Mount it while the session is open. */
  readonly Surface: ComponentType<WorkbookEditorProps>;
  /** Whether a cell changed since the session opened. */
  changed(): boolean;
  /** The workbook now, as XLSX bytes. While nothing changed these are the
   *  request's bytes, unchanged (the SDK guarantees it). */
  xlsx(): Uint8Array;
  /** Fires after each edit. */
  onDidChange(listener: () => void): Disposable;
  /** Free the editor's engine. Idempotent; after it `xlsx` keeps answering
   *  the last bytes. */
  close(): void;
}

/** What the providing bundle contributes. */
export interface WorkbookEditorContribution {
  /** Namespaced under the bundle's id. */
  id: string;
  /** Opens a session on a workbook. Rejects when the bytes are not one. */
  open(request: WorkbookEditRequest): Promise<WorkbookEditSession>;
}

/** `host.workbooks`: a consumer's side of the door. */
export interface WorkbooksSurface {
  /** Whether an editor is registered now. */
  available(): boolean;
  /** Open a workbook in the registered editor (the first one registered).
   *  Rejects when none is, or when the editor refuses the bytes. */
  open(request: WorkbookEditRequest): Promise<WorkbookEditSession>;
  /** Fires when an editor is registered or goes. */
  onDidChangeAvailability(listener: () => void): Disposable;
}
