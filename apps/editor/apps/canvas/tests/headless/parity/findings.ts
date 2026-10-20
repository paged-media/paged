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

// The parity FINDINGS: a door that disagrees with the reference, on record
// as an expected failure (`test.failing`) of `parity.test.ts`, keyed
// `<case> <door>`. Each says what happens and what should. When the
// product is fixed the test starts passing, `test.failing` fails, and the
// entry is deleted in the same commit as the fix. An entry whose
// `expected` names an ADR is a difference decided there, kept marked so a
// change that removed it comes back to the decision.

export interface Finding {
  id: string;
  /** What the door does. */
  actual: string;
  /** What it should do. */
  expected: string;
}

export const KNOWN_FINDINGS: Readonly<Record<string, Finding>> = {
  ...Object.fromEntries(
    [
      "insertFrame/command ui.command",
      "insertFrame/command automation.command",
      "insertOval/command ui.command",
      "insertOval/command automation.command",
    ].map((key) => [
      key,
      {
        id: "PAR-6",
        actual:
          "Insert ▸ Rectangle / Ellipse make the frame with a 1 pt Color/Black stroke (the drawing tools' graphic default); insertFrame / insertOval on every other surface make it unstroked",
        expected:
          "a documented difference, not a defect (editor ADR 261): the Insert menu draws what the drawing tools draw, as InDesign paints a tool-drawn shape in [Normal Graphics Frame], and the primitive Place, plugins and scripts mint through stays unpainted",
      },
    ]),
  ),
  "read:paged.schema boa": {
    id: "PAR-3",
    actual:
      "paged.schema(kind) answers the engine catalog's rows (access, wire, idml; no since) while host.objects.schema and editor.schema answer the object registry's (since; no access, wire, idml)",
    expected:
      "one PropertySchema row shape for a kind on every surface (ADR 323 names one type)",
  },
};
