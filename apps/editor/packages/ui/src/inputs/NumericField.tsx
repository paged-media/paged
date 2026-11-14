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

// THE ONE NUMERIC FIELD (the interaction spec's UXI-PNL-002, PNL-005,
// PNL-008 to PNL-011; the strategy's §5.2 field contract). Every number a
// user types or scrubs in the editor goes through here: NumberInput,
// LengthInput, BoundsInput and SmartDialMicro are thin wrappers, the
// catalogue's leaves and the control bar's fields render it, and plugins
// get it as `host.widgets.NumericField`.
//
//   · Typing reads ONE grammar (`./expression`): units, + − × ÷, brackets,
//     relative "+=5 mm" / "*110%", mixed units resolved to the field's
//     unit, the UI locale's decimal comma.
//   · Enter or blur commits; Escape restores what was there.
//   · A value that is not one says why: `aria-invalid` and an inline
//     message (invalid syntax, out of range, a unit the field cannot take).
//   · Scrubbing the label (Shift fine, Alt coarse) previews live through
//     `onPreview` and commits ONCE on release: one scrub is one undo step.
//     Every preview and the commit of a scrub carry one `coalesceKey`; the
//     binding sends it with each write (engine ADR 1304: one key, one undo
//     step). Without `onPreview` the field shows the scrubbed number and
//     commits on release only.
//   · A mixed selection reads "Mixed", never 0 or the first object's
//     value; a relative entry then applies to each object
//     (`onCommitRelative`).
//   · A data-bound value carries the bound badge (PNL-011).

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useFieldName } from "@paged-media/panel-kit";
import { Icon, useScrubGesture } from "@paged-media/shell";
import { useStrings, type Strings } from "@paged-media/strings";

import { INPUT } from "../messages";
import { unitDigits, useDocumentUnit } from "./document-unit";
import {
  decimalSeparator,
  parseNumericExpression,
  type NumericParseError,
  type RelativeEdit,
} from "./expression";
import { POINTS_PER_UNIT, type LengthUnit } from "./units";

/** What produced a value the field hands its owner. */
export interface NumericCommitMeta {
  /** `type`: Enter or blur; `scrub`: a scrub's preview or its release;
   *  `step`: an arrow key. */
  source: "type" | "scrub" | "step";
  /** The key every preview and the commit of ONE scrub share, so the owner
   *  can make them one undo step; null outside a scrub. */
  coalesceKey: string | null;
  /** The relative entry typed ("+=5 mm"), when there was one. */
  relative: RelativeEdit | null;
}

export interface NumericFieldProps {
  /** The value: in points for a `length` field, else in the field's own
   *  unit. Null: no value (mixed, unset, or nothing to read). */
  value: number | null;
  /** The targets disagree: the field reads "Mixed" (UXI-PNL-008). */
  mixed?: boolean;
  /** A length: shown in `unit` (default: the document unit, ADR 245),
   *  read and committed in points. */
  length?: boolean;
  /** A length field's display unit. Default: the document unit. */
  unit?: LengthUnit;
  /** A non-length field's suffix ("%", "°"), shown after the number and
   *  accepted as typed. For a length field it overrides the shown unit
   *  text. */
  suffix?: string;
  /** Show the unit or suffix (default true). */
  showUnit?: boolean;
  /** Bounds, in the value's unit (points for a length). A typed value
   *  outside them is refused with a message; a scrub clamps. */
  min?: number;
  max?: number;
  /** Shown units per scrubbed pixel and per arrow key. Default 1. */
  step?: number;
  /** Decimal places shown. Default: the unit's digits for a length, 2. */
  precision?: number;
  /** Text on the scrub handle ("X", "W"). */
  label?: string;
  /** A glyph on the scrub handle instead of `label`. */
  icon?: string;
  /** Mono text inside the field before the value ("gutter"). */
  prefix?: string;
  /** A read-only text instead of the value (a seam's placeholder). */
  displayText?: string;
  /** The name of an unset value ("Auto"), shown while `value` is null;
   *  the field stays editable. */
  unsetText?: string;
  /** Placeholder while empty (the control bar's "Auto"). */
  placeholder?: string;
  disabled?: boolean;
  /** Shown, focusable, not editable (a value with no write path). */
  readOnly?: boolean;
  /** The value comes from data (UXI-PNL-011): `true`, or the source's
   *  name. */
  bound?: boolean | string;
  /** `panel`: the kit's metric field (h28, the label a chip). `bar`: the
   *  control bar's compact label · value · unit. `inline`: a bare value and
   *  unit in a row of text (the smart dial's value). */
  variant?: "panel" | "bar" | "inline";
  /** Focus the field when it mounts (a click-to-edit value). */
  autoFocus?: boolean;
  /** Editing ended: committed, refused and restored, or Escape. */
  onEditEnd?: () => void;
  /** The shown number's text, when not editing (a signed "+15"). */
  format?: (shown: number) => string;
  /** A committed value (Enter, blur, a scrub's release, an arrow step). */
  onCommit?: (value: number, meta: NumericCommitMeta) => void;
  /** A live value while scrubbing. The owner previews it, keyed by
   *  `meta.coalesceKey`, and the commit that follows closes the preview. */
  onPreview?: (value: number, meta: NumericCommitMeta) => void;
  /** A scrub that previewed ended without a new value (Escape, or released
   *  where it started): put back what was there. */
  onCancelPreview?: (meta: NumericCommitMeta) => void;
  /** A relative entry where the field has no single value (a mixed
   *  selection): apply it to each target's own value. The operand is in
   *  the value's unit (points for an added length). Without it a relative
   *  entry over a mixed value is refused with a message. */
  onCommitRelative?: (edit: RelativeEdit, meta: NumericCommitMeta) => void;
  /** An arrow step as a relative write (by `delta`, in the value's unit),
   *  where an absolute commit would race a re-read (a move). */
  onStep?: (delta: number) => void;
  /** Every live change: a valid typed edit, a scrub update, a commit. */
  onChange?: (value: number) => void;
  /** A custom reader of typed text (in shown units); null when it is not a
   *  value. Default: the expression parser. */
  parse?: (text: string) => number | null;
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  /** `data-*` attributes for the field's root. */
  dataAttributes?: Readonly<Record<string, string | undefined>>;
  /** `data-*` attributes for the `<input>` itself (a test hook a spec
   *  fills). */
  inputAttributes?: Readonly<Record<string, string | undefined>>;
  /** A field that may be empty: committing empty text calls this (a
   *  custom angle cleared back to none). Without it empty text restores. */
  onClear?: () => void;
}

function fmt(v: number, precision: number): string {
  const factor = Math.pow(10, precision);
  const n = Math.round(v * factor) / factor;
  return String(Object.is(n, -0) ? 0 : n);
}

/** The words for a refused value. */
export function numericErrorText(
  strings: Strings,
  error: NumericParseError,
  shown: (n: number) => string = String,
): string {
  switch (error.kind) {
    case "unit":
      return strings.t(INPUT.unsupportedUnit, { unit: error.unit });
    case "range":
      if (!Number.isFinite(error.value)) return strings.t(INPUT.notFinite);
      if (error.min !== undefined && error.max !== undefined)
        return strings.t(INPUT.outOfRange, {
          min: shown(error.min),
          max: shown(error.max),
        });
      if (error.min !== undefined)
        return strings.t(INPUT.atLeast, { min: shown(error.min) });
      if (error.max !== undefined)
        return strings.t(INPUT.atMost, { max: shown(error.max) });
      return strings.t(INPUT.notFinite);
    case "syntax":
      if (error.reason === "unclosed") return strings.t(INPUT.unclosed);
      if (error.reason === "needsValue") return strings.t(INPUT.needsValue);
      return strings.t(INPUT.invalidSyntax);
  }
}

/** The outcome of reading the typed text. */
type Read =
  | { ok: true; shown: number | null; relative: RelativeEdit | null }
  | { ok: false; error: NumericParseError };

export function NumericField(props: NumericFieldProps) {
  // Named by its row's label when the caller gives it no name (ADR 233).
  const named = useFieldName(props);
  const strings = useStrings();
  const docUnit = useDocumentUnit();
  const {
    value,
    mixed = false,
    length = false,
    suffix,
    showUnit = true,
    step = 1,
    label = "",
    icon,
    prefix,
    displayText,
    unsetText,
    placeholder,
    disabled = false,
    bound,
    variant = "panel",
    className = "",
  } = props;

  const unit: LengthUnit | null = length ? (props.unit ?? docUnit) : null;
  // Points per shown unit; 1 for a field that is not a length.
  const per = unit ? POINTS_PER_UNIT[unit] : 1;
  const precision = props.precision ?? (unit ? unitDigits(unit) : 2);
  const unitText = suffix ?? unit ?? "";
  const shownMin = props.min === undefined ? undefined : props.min / per;
  const shownMax = props.max === undefined ? undefined : props.max / per;
  const shownValue = value === null ? null : value / per;
  const readOnly = displayText != null || props.readOnly === true;
  const decimal = decimalSeparator(strings.locale);

  const display = (v: number | null): string => {
    if (displayText != null) return displayText;
    if (v === null) {
      if (mixed) return strings.t(INPUT.mixed);
      return unsetText ?? "—";
    }
    const n = props.format ? props.format(v) : fmt(v, precision);
    return variant === "panel" && showUnit && unitText ? `${n} ${unitText}` : n;
  };

  const [text, setText] = useState<string>(() => display(shownValue));
  const [error, setError] = useState<NumericParseError | null>(null);
  // Edited since focus: only typed text commits on blur (a step already
  // wrote itself, and the same value twice is a junk undo step).
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const fieldId = useId();
  // The scrub in progress: its coalesce key and whether it previewed.
  const scrubRef = useRef<{ key: string; previewed: boolean } | null>(null);
  const scrubCount = useRef(0);
  // Enter and Escape blur the field after settling it themselves; the blur
  // they cause must not commit a second time (or commit what Escape put
  // back: the handler's closure still holds the typed text).
  const settledRef = useRef(false);
  // The value editing started from (or last committed): a typed value equal
  // to it is no change. Not the live `value`: an owner that follows
  // `onChange` while the user types has already moved it.
  const baseRef = useRef<number | null>(null);

  // A new value (or a new way of showing it) re-syncs the text unless the
  // user is typing in the field.
  const syncText = useEffectEvent(() => {
    if (document.activeElement !== inputRef.current) {
      setText(display(shownValue));
      setError(null);
    }
  });
  useEffect(() => {
    syncText();
  }, [value, mixed, unit, suffix, displayText, unsetText, strings.locale]);

  const canonical = (shown: number) => shown * per;
  /** A relative entry in the value's unit: an added length in points. */
  const canonicalEdit = (edit: RelativeEdit): RelativeEdit =>
    (edit.op === "+" || edit.op === "-") && !edit.percent
      ? { ...edit, operand: edit.operand * per }
      : edit;
  const meta = (
    source: NumericCommitMeta["source"],
    relative: RelativeEdit | null = null,
  ): NumericCommitMeta => ({
    source,
    coalesceKey: source === "scrub" ? (scrubRef.current?.key ?? null) : null,
    relative,
  });

  const scrubbable =
    !disabled &&
    !readOnly &&
    !mixed &&
    (props.onCommit != null || props.onChange != null);
  const scrub = useScrubGesture({
    initial: shownValue ?? 0,
    step,
    min: shownMin,
    max: shownMax,
    precision,
    onUpdate: (next, phase) => {
      if (phase === "begin") {
        scrubCount.current += 1;
        scrubRef.current = {
          key: `numeric:${fieldId}:${scrubCount.current}`,
          previewed: false,
        };
      }
      setText(display(next));
      if (phase === "revert") return;
      const session = scrubRef.current;
      if (phase === "update" && props.onPreview && session) {
        session.previewed = true;
        props.onPreview(canonical(next), meta("scrub"));
      }
      if (phase === "update") props.onChange?.(canonical(next));
    },
    onEnd: (outcome, next, initial) => {
      const session = scrubRef.current;
      if (outcome === "commit" && next !== initial) {
        props.onCommit?.(canonical(next), meta("scrub"));
        props.onChange?.(canonical(next));
      } else if (session?.previewed) {
        props.onCancelPreview?.(meta("scrub"));
      }
      if (outcome === "cancel") setText(display(shownValue));
      scrubRef.current = null;
    },
  });

  const read = (raw: string): Read => {
    if (props.parse) {
      const n = props.parse(raw);
      if (n === null || !Number.isFinite(n))
        return {
          ok: false,
          error: { kind: "syntax", at: 0, reason: "unexpected" },
        };
      if (
        (shownMin !== undefined && n < shownMin) ||
        (shownMax !== undefined && n > shownMax)
      )
        return {
          ok: false,
          error: { kind: "range", value: n, min: shownMin, max: shownMax },
        };
      return { ok: true, shown: n, relative: null };
    }
    const r = parseNumericExpression(raw, {
      unit: unit ?? suffix ?? null,
      current: mixed ? null : shownValue,
      min: shownMin,
      max: shownMax,
      decimal,
    });
    if (!r.ok) return r;
    if (r.value === null && !props.onCommitRelative)
      return {
        ok: false,
        error: { kind: "syntax", at: 0, reason: "needsValue" },
      };
    return { ok: true, shown: r.value, relative: r.relative };
  };

  /** Commit the typed text; false when it is refused (the field keeps it
   *  and says why). */
  const commitText = (): boolean => {
    if (readOnly) return true;
    if (text.trim() === "" && dirty && props.onClear) {
      setError(null);
      setDirty(false);
      if (shownValue !== null) props.onClear();
      return true;
    }
    if (text.trim() === "" || !dirty) {
      setText(display(shownValue));
      setError(null);
      setDirty(false);
      return true;
    }
    const r = read(text);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setError(null);
    setDirty(false);
    if (r.shown === null) {
      // A relative entry over a mixed selection: each target its own.
      if (r.relative) {
        const edit = canonicalEdit(r.relative);
        props.onCommitRelative?.(edit, meta("type", edit));
      }
      setText(display(shownValue));
      return true;
    }
    const v = Math.round(r.shown * 10 ** precision) / 10 ** precision;
    setText(display(v));
    const base = baseRef.current ?? shownValue;
    if (base !== null && Math.abs(v - base) < 1e-9) return true;
    baseRef.current = v;
    props.onChange?.(canonical(v));
    props.onCommit?.(canonical(v), meta("type", r.relative));
    return true;
  };

  const stepBy = (e: KeyboardEvent<HTMLInputElement>, dir: 1 | -1) => {
    const scale = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const delta = step * scale * dir;
    if (mixed || shownValue === null) {
      if (!props.onCommitRelative || !mixed) return;
      const edit = canonicalEdit({ op: "+", operand: delta, percent: false });
      props.onCommitRelative(edit, meta("step", edit));
      return;
    }
    // Step from what the field shows: a second press can land before the
    // first one's re-read.
    const typed = read(text);
    const base = typed.ok && typed.shown !== null ? typed.shown : shownValue;
    let next = base + delta;
    if (shownMin !== undefined) next = Math.max(shownMin, next);
    if (shownMax !== undefined) next = Math.min(shownMax, next);
    next = Math.round(next * 10 ** precision) / 10 ** precision;
    setText(fmt(next, precision));
    setDirty(false);
    setError(null);
    if (props.onStep) props.onStep(canonical(next) - canonical(base));
    else {
      props.onChange?.(canonical(next));
      props.onCommit?.(canonical(next), meta("step"));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (commitText()) {
        settledRef.current = true;
        inputRef.current?.blur();
        props.onEditEnd?.();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText(display(shownValue));
      setError(null);
      setDirty(false);
      settledRef.current = true;
      inputRef.current?.blur();
      props.onEditEnd?.();
    } else if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !readOnly &&
      !disabled &&
      (props.onCommit ||
        props.onChange ||
        props.onStep ||
        props.onCommitRelative)
    ) {
      e.preventDefault();
      stepBy(e, e.key === "ArrowUp" ? 1 : -1);
    }
    // Tool shortcuts must not fire while typing in a field.
    e.stopPropagation();
  };

  const state =
    displayText != null
      ? "display"
      : value !== null
        ? "value"
        : mixed
          ? "mixed"
          : unsetText != null
            ? "unset"
            : "none";
  const muted = mixed || readOnly || (value === null && unsetText == null);
  const errorText = error
    ? numericErrorText(strings, error, (n) =>
        unitText ? `${fmt(n, precision)} ${unitText}` : fmt(n, precision),
      )
    : null;
  const boundTitle =
    typeof bound === "string"
      ? strings.t(INPUT.boundTo, { source: bound })
      : strings.t(INPUT.boundToData);

  const input = (
    <input
      {...props.inputAttributes}
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={named["aria-label"] ?? props.title}
      aria-labelledby={named["aria-labelledby"]}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      className={
        variant === "panel"
          ? `flex-1 min-w-0 ${prefix ? "pl-1" : "pl-2"} pr-2 bg-transparent outline-none text-[11.5px] focus:ring-1 focus:ring-ring focus:ring-inset disabled:text-muted-foreground`
          : undefined
      }
      autoFocus={props.autoFocus}
      style={
        variant === "panel"
          ? {
              fontFamily: "var(--font-mono)",
              color: muted ? "var(--pg-muted-fg)" : undefined,
            }
          : {
              ...(variant === "bar" ? barInput : inlineInput),
              color: muted ? "var(--pg-muted-fg)" : "var(--pg-fg)",
            }
      }
      onFocus={(e) => {
        if (readOnly || disabled) return;
        // The raw number for editing, selected so typing REPLACES it.
        // Written to the element synchronously: the state update alone
        // lands after the browser placed the caret ("36" into "12 pt"
        // made 1236).
        const raw = shownValue === null ? "" : fmt(shownValue, precision);
        baseRef.current = shownValue;
        setText(raw);
        setDirty(false);
        e.currentTarget.value = raw;
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setText(e.target.value);
        setDirty(true);
        if (error) setError(null);
        // Live update when the partial text already reads as a value.
        if (e.target.value.trim() === "" && props.onClear) props.onClear();
        else if (props.onChange) {
          const r = read(e.target.value);
          if (r.ok && r.shown !== null) props.onChange(canonical(r.shown));
        }
      }}
      onBlur={() => {
        if (settledRef.current) {
          settledRef.current = false;
          return;
        }
        if (readOnly) return;
        if (!commitText()) {
          // Leaving with a refused value puts back what was there.
          setText(display(shownValue));
          setError(null);
          setDirty(false);
        }
        props.onEditEnd?.();
      }}
      onKeyDown={onKeyDown}
    />
  );

  const handle = (icon || label) && (
    <span
      ref={scrubbable ? scrub.bind : undefined}
      data-scrub-handle=""
      className={
        variant === "panel"
          ? "px-[7px] inline-flex items-center select-none rounded-l-[5px] text-muted-foreground bg-muted border-r border-input font-medium text-[11px]"
          : undefined
      }
      aria-hidden="true"
      title={scrubbable ? strings.t(INPUT.dragToAdjust) : undefined}
      style={{
        ...(variant === "bar" ? barLabel : {}),
        touchAction: "none",
        cursor: scrubbable ? "ew-resize" : "default",
      }}
    >
      {icon ? <Icon name={icon} size={13} /> : label}
    </span>
  );

  const badge = bound ? (
    <span
      data-badge="bound"
      title={boundTitle}
      className="inline-flex items-center pl-[5px]"
      style={{ color: "var(--pg-primary)" }}
    >
      <Icon name="ui-database" size={10} />
    </span>
  ) : null;

  const message = errorText ? (
    <span
      id={errorId}
      role="alert"
      data-numeric-error={error?.kind}
      className="text-[10.5px]"
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        zIndex: 20,
        marginTop: 2,
        padding: "2px 6px",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        background: "var(--pg-bg)",
        border: "1px solid var(--status-error)",
        color: "var(--status-error)",
      }}
    >
      {errorText}
    </span>
  ) : null;

  const rootData = {
    "data-numeric-field": variant,
    "data-field-state": state,
    "data-mixed":
      mixed || (value === null && displayText == null && unsetText == null)
        ? ""
        : undefined,
    "data-invalid": error ? "" : undefined,
    "data-bound": bound ? "" : undefined,
    "data-scrubbing": scrub.isScrubbing ? "" : undefined,
    "data-disabled": disabled || undefined,
    ...props.dataAttributes,
  };

  const live = scrub.isScrubbing ? (
    <span className="sr-only" aria-live="polite">
      {strings.t(INPUT.scrubbing, { value: fmt(scrub.value, precision) })}
    </span>
  ) : null;

  if (variant === "inline") {
    return (
      <span
        {...rootData}
        title={props.title}
        className={`relative inline-flex items-baseline gap-[2px] ${className}`}
        style={props.style}
      >
        {badge}
        {input}
        {showUnit && unitText ? (
          <span className="text-[10px]" style={{ color: "var(--pg-muted-fg)" }}>
            {unitText}
          </span>
        ) : null}
        {message}
        {live}
      </span>
    );
  }

  if (variant === "bar") {
    return (
      <label
        title={props.title}
        {...rootData}
        style={{
          ...barBox,
          position: "relative",
          opacity: value === null && !placeholder && !mixed ? 0.45 : 1,
          borderColor: error ? "var(--status-error)" : undefined,
          ...props.style,
        }}
      >
        {handle}
        {badge}
        {input}
        {showUnit && unitText ? <span style={barUnit}>{unitText}</span> : null}
        {message}
        {live}
      </label>
    );
  }

  return (
    <div
      {...rootData}
      title={props.title}
      className={`relative inline-flex min-w-0 max-w-full items-stretch rounded-[6px] border bg-background h-[28px] ${error ? "border-[color:var(--status-error)]" : "border-input"} ${className}`}
      style={props.style}
    >
      {handle}
      {badge}
      {prefix && (
        <span
          className="pl-2 inline-flex items-center select-none text-[11.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--pg-fg)" }}
          aria-hidden="true"
        >
          {prefix}
        </span>
      )}
      {input}
      {message}
      {live}
    </div>
  );
}

// The control bar's compact field (`variant="bar"`).
const barBox: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 28,
  padding: "0 7px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-divider)",
  background: "var(--pg-muted)",
  flexShrink: 0,
  cursor: "text",
};

const barLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--pg-muted-fg)",
  whiteSpace: "nowrap",
};

const barInput: CSSProperties = {
  width: 46,
  border: "none",
  outline: "none",
  background: "transparent",
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 12,
  textAlign: "right",
  padding: 0,
};

const inlineInput: CSSProperties = {
  width: 50,
  textAlign: "right",
  borderRadius: 5,
  border: "1px solid var(--pg-primary)",
  background: "var(--pg-bg)",
  outline: "none",
  padding: "1px 4px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const barUnit: CSSProperties = {
  fontSize: 10.5,
  color: "var(--pg-muted-fg)",
};
