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

// A length field: a THIN WRAPPER over the one numeric field
// (`./NumericField`, `length`), shown in the document unit (ADR 245) or the
// caller's, canonical in points. The legacy unit picker stays opt-in.

import { useStrings } from "@paged-media/strings";
import { INPUT } from "../messages";
import { useState } from "react";

import { useDocumentUnit } from "./document-unit";
import { NumericField, type NumericCommitMeta } from "./NumericField";
import type { NumberInputProps } from "./NumberInput";
import type { RelativeEdit } from "./expression";
import { POINTS_PER_UNIT, type LengthUnit } from "./units";

export interface LengthInputProps extends Omit<
  NumberInputProps,
  "value" | "onChange" | "onCommit" | "onPreview" | "onCommitRelative"
> {
  /** Value in points (the IDML-native unit). `null` = mixed. */
  valuePt: number | null;
  /** The display unit. Default: the document unit (ADR 245), followed as it
   * changes; a field that always reads in one unit (a type size in points)
   * names it. With the picker, the picker's choice wins. */
  defaultUnit?: LengthUnit;
  /** Show the legacy unit-picker select. Default FALSE — the kit's
   * metric fields carry the unit INSIDE the value ("16 pt"). */
  unitPicker?: boolean;
  /** Hide the in-field unit suffix (compact composite cells). */
  showUnit?: boolean;
  /** Fires whenever the canonical (pt) value changes. */
  onChangePt: (valuePt: number) => void;
  onCommitPt?: (valuePt: number, meta?: NumericCommitMeta) => void;
  /** Live value (pt) while scrubbing. */
  onPreviewPt?: (valuePt: number, meta: NumericCommitMeta) => void;
  /** A relative entry over a mixed value, in points for an additive one. */
  onCommitRelativePt?: (edit: RelativeEdit, meta: NumericCommitMeta) => void;
}

const UNITS: LengthUnit[] = ["pt", "pc", "px", "mm", "cm", "in"];

/**
 * Numeric input displaying in a length unit while the canonical value
 * stays in points; the caller only ever sees pt via `onChangePt` /
 * `onCommitPt`. `min` / `max` / `step` are in the shown unit, as the
 * NumberInput this wrapped read them.
 */
export function LengthInput(props: LengthInputProps) {
  const strings = useStrings();
  const {
    valuePt,
    defaultUnit,
    unitPicker = false,
    showUnit = true,
    onChangePt,
    onCommitPt,
    onPreviewPt,
    onCommitRelativePt,
    suffix,
    min,
    max,
    ...rest
  } = props;
  const docUnit = useDocumentUnit();
  const [picked, setUnit] = useState<LengthUnit | null>(null);
  const unit = (unitPicker ? picked : null) ?? defaultUnit ?? docUnit;
  const per = POINTS_PER_UNIT[unit];

  return (
    // `max-w-full` + `min-w-0` on both boxes: in a narrow cell (a 2-up
    // metric grid in a 320 px dock) the field shrinks to the cell rather
    // than holding the input's intrinsic ~160 px and running off the edge.
    <div className="inline-flex items-stretch gap-1 min-w-0 max-w-full">
      <NumericField
        {...rest}
        length
        unit={unit}
        suffix={suffix}
        showUnit={showUnit && !unitPicker}
        min={min === undefined ? undefined : min * per}
        max={max === undefined ? undefined : max * per}
        value={valuePt}
        onChange={onChangePt}
        onCommit={onCommitPt}
        onPreview={onPreviewPt}
        onCommitRelative={onCommitRelativePt}
      />
      {unitPicker && (
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value as LengthUnit)}
          className="text-xs h-[28px] px-1 rounded-[6px] border border-input bg-background text-foreground"
          aria-label={strings.t(INPUT.unit)}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
