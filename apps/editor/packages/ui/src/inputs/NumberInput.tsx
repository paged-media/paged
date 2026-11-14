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

// The kit `Num` field (gallery-deep1.jsx): a THIN WRAPPER over the one
// numeric field (`./NumericField`), kept for its callers' props. `value:
// null` is the mixed / no-value state; `mixed` says which (the field reads
// "Mixed" then, never a number). A typed commit write-replaces (the
// binding layer fans out); a relative entry ("+=5") applies to the value.

import type { CSSProperties } from "react";

import {
  NumericField,
  type NumericCommitMeta,
  type NumericFieldProps,
} from "./NumericField";
import type { RelativeEdit } from "./expression";

export interface NumberInputProps {
  /** Current value. `null` = mixed/no value. */
  value: number | null;
  /** The targets disagree: reads "Mixed". */
  mixed?: boolean;
  /** Fires on every change (scrub update + keyboard edit + commit). */
  onChange: (value: number) => void;
  /** The final value: Enter / blur, a scrub's release, an arrow step. */
  onCommit?: (value: number, meta?: NumericCommitMeta) => void;
  /** Live value while scrubbing (see `NumericFieldProps.onPreview`). */
  onPreview?: (value: number, meta: NumericCommitMeta) => void;
  onCancelPreview?: (meta: NumericCommitMeta) => void;
  onCommitRelative?: (edit: RelativeEdit, meta: NumericCommitMeta) => void;
  /** Units per pixel of scrub-drag (and per arrow key). Default 1. */
  step?: number;
  /** Clamp range. */
  min?: number;
  max?: number;
  /** Decimal places. Default 2. */
  precision?: number;
  /** Text on the scrub handle ("X", "W", "Pt"). */
  label?: string;
  /** A glyph on the scrub handle instead of `label`. */
  icon?: string;
  /** Mono text inside the field before the value ("W", "gutter"). */
  prefix?: string;
  /** Unit text after the value when not editing ("pt", "%"); an
   *  expression may name it. */
  suffix?: string;
  /** Full display override (read-only text like "Metrics"). */
  displayText?: string;
  /** The name of an UNSET value ("Auto"), shown while `value` is null. */
  unsetText?: string;
  /** Reads typed text into a value; null when it is not one. Default: the
   *  expression parser. */
  parse?: (text: string) => number | null;
  /** Data-bound (UXI-PNL-011): `true` or the source's name. */
  bound?: boolean | string;
  /** Placeholder while the field is empty. */
  placeholder?: string;
  /** A field that may be empty (see `NumericFieldProps.onClear`). */
  onClear?: () => void;
  /** `data-*` attributes for the `<input>` (a spec's hook). */
  inputAttributes?: Readonly<Record<string, string | undefined>>;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

/** Numeric input with a scrub handle: the one numeric field. */
export function NumberInput(props: NumberInputProps) {
  const { onChange, onCommit, ...rest } = props;
  // A field with only `onChange` still commits through it (the field calls
  // `onChange` with every final value too: the legacy contract).
  const field: NumericFieldProps = {
    ...rest,
    onChange,
    onCommit: onCommit ? (v, meta) => onCommit(v, meta) : undefined,
  };
  return <NumericField {...field} />;
}
