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

// Word's multilevel list presets (doc ADR 608 amendment 1, engine ADR
// 1018): each builds a `NumberingListDef` with Word's per-level
// definitions — format, level text, restart, indents, bullet — so the
// engine numbers `1.` `a.` `i.` or `1.` `1.1.` `1.1.1.` exactly as Word,
// and Tab / Shift+Tab (`setListLevel`) walk the levels.

/** One level of a list definition, as `createNumberingList` takes it
 *  (the wire's `NumberingLevelSpec`; Word's format names and `%1.` level
 *  text are accepted there as they are). */
export interface NumberingLevelSpec {
  level: number;
  listType?: string;
  format?: string;
  expression?: string;
  suffix?: string;
  startAt?: number;
  restartAfter?: number;
  leftIndent?: number;
  firstLineIndent?: number;
  tabPosition?: number;
  bulletCharacter?: string;
  bulletFont?: string;
}

export type ListPresetId = "outline" | "legal" | "bullets";

export interface ListPreset {
  id: ListPresetId;
  /** The list's `Self` id: one list per preset per document. */
  selfId: string;
  name: string;
  listType: "NumberedList" | "BulletList";
  levels: NumberingLevelSpec[];
}

/** Word's default indents: a quarter inch more per level, the marker
 *  hanging a quarter inch. */
const INDENT = 18;
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const indents = (level: number) => ({
  leftIndent: INDENT * (level + 1),
  firstLineIndent: -INDENT,
  tabPosition: INDENT * (level + 1),
});

export const LIST_PRESETS: Record<ListPresetId, ListPreset> = {
  outline: {
    id: "outline",
    selfId: "NumberingList/word-preset-outline",
    name: "Word 1. a. i.",
    listType: "NumberedList",
    levels: LEVELS.map((level) => ({
      level,
      listType: "NumberedList",
      format: ["decimal", "lowerLetter", "lowerRoman"][(level - 1) % 3]!,
      expression: `%${level}.`,
      suffix: "tab",
      startAt: 1,
      restartAfter: level - 1,
      ...indents(level),
    })),
  },
  legal: {
    id: "legal",
    selfId: "NumberingList/word-preset-legal",
    name: "Word 1. 1.1. 1.1.1.",
    listType: "NumberedList",
    levels: LEVELS.map((level) => ({
      level,
      listType: "NumberedList",
      format: "decimal",
      expression:
        LEVELS.slice(0, level)
          .map((l) => `%${l}`)
          .join(".") + ".",
      suffix: "tab",
      startAt: 1,
      restartAfter: level - 1,
      ...indents(level),
    })),
  },
  bullets: {
    id: "bullets",
    selfId: "NumberingList/word-preset-bullets",
    name: "Word • ◦ ▪",
    listType: "BulletList",
    levels: LEVELS.map((level) => ({
      level,
      listType: "BulletList",
      bulletCharacter: ["•", "◦", "▪"][(level - 1) % 3]!,
      suffix: "tab",
      ...indents(level),
    })),
  },
};
