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

import { useStrings } from "@paged-media/strings";
import { INPUT } from "../messages";
import { useState } from "react";

import { parseLengthText, unitDigits, useDocumentUnit } from "./document-unit";
import { NumberInput, type NumberInputProps } from "./NumberInput";
import { convertLength, type LengthUnit } from "./units";

export interface LengthInputProps extends Omit<
  NumberInputProps,
  "value" | "onChange" | "onCommit"
> {
  /** Value in points (the IDML-native unit). `null` = mixed. */
  valuePt: number | null;
  /** The display unit. Default: the document unit (ADR 245), followed as it
   * changes; a field that always reads in one unit (a type size in points)
   * names it. With the picker, the picker's choice wins. The canonical
   * value stays in points, and a typed unit ("10mm") is converted. */
  defaultUnit?: LengthUnit;
  /** Show the legacy unit-picker select. Default FALSE — the kit's
   * metric fields carry the unit INSIDE the value ("16 pt"). */
  unitPicker?: boolean;
  /** Hide the in-field unit suffix (compact composite cells). */
  showUnit?: boolean;
  /** Fires whenever the canonical (pt) value changes. */
  onChangePt: (valuePt: number) => void;
  onCommitPt?: (valuePt: number) => void;
}

const UNITS: LengthUnit[] = ["pt", "pc", "px", "mm", "cm", "in"];

/**
 * Numeric input displaying in a length unit while the canonical
 * value stays in points (IDML's native unit); the caller only ever
 * sees pt via `onChangePt` / `onCommitPt`. Gallery pixel-parity:
 * the unit renders inside the field as the kit's value suffix
 * ("16 pt"); the explicit unit-picker select is opt-in legacy.
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
    suffix,
    ...rest
  } = props;
  const docUnit = useDocumentUnit();
  const [picked, setUnit] = useState<LengthUnit | null>(null);
  const unit = (unitPicker ? picked : null) ?? defaultUnit ?? docUnit;

  const displayValue =
    valuePt === null ? null : convertLength(valuePt, "pt", unit);

  return (
    // `max-w-full` + `min-w-0` on both boxes: in a narrow cell (a 2-up
    // metric grid in a 320 px dock) the field shrinks to the cell rather
    // than holding the input's intrinsic ~160 px and running off the edge.
    <div className="inline-flex items-stretch gap-1 min-w-0 max-w-full">
      <NumberInput
        precision={unitDigits(unit)}
        {...rest}
        suffix={suffix ?? (showUnit && !unitPicker ? unit : undefined)}
        parse={(text) => {
          const pt = parseLengthText(text, unit);
          return pt === null ? null : convertLength(pt, "pt", unit);
        }}
        value={displayValue}
        onChange={(next) => onChangePt(convertLength(next, unit, "pt"))}
        onCommit={
          onCommitPt
            ? (next) => onCommitPt(convertLength(next, unit, "pt"))
            : undefined
        }
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
