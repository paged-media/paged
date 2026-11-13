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

// Object > Transform > Reflect… (Illustrator's dialog): the mirror axis'
// angle (90 flips left to right, 0 top to bottom), an optional PAGE-space
// axis point instead of the selection's centre, and Copy. OK runs
// `paged.transform.reflectHorizontal` with that payload over the selection
// the dialog opened with: ONE batch, one undo step, remembered for
// Transform again. The options last used are kept for the session.

import { useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  createValueStore,
  FocusScope,
  scoped,
  scopeOf,
  useRegistries,
  useScoped,
  type EditorScope,
  useEscapeHandler,
} from "@paged-media/shell";
import { LengthInput, NumberInput } from "@paged-media/ui";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  PAGED_TRANSFORM_REFLECT_HORIZONTAL,
  REFLECT_HORIZONTAL_DEG,
} from "../reflect-commands";

const M = defineMessages("app.reflectDialog", {
  title: "Reflect",
  angle: "Axis angle",
  copy: "Copy (reflect a copy)",
  aboutPoint: "About a point",
  pointX: "Point X",
  pointY: "Point Y",
  note: "Reflects the selection across an axis at this angle through the centre of its box: 90° swaps left and right, 0° top and bottom. With a point, the axis runs through that point of the page instead.",
  ok: "OK",
  cancel: "Cancel",
});

/** What the dialog sets. */
export interface ReflectOptions {
  angleDeg: number;
  copy: boolean;
  aboutPoint: boolean;
  /** The axis point, page pt. */
  x: number;
  y: number;
}

/** The options last used, per editor. */
const LAST_OPTIONS = scoped("reflectOptions", () =>
  createValueStore<ReflectOptions>({
    angleDeg: REFLECT_HORIZONTAL_DEG,
    copy: false,
    aboutPoint: false,
    x: 0,
    y: 0,
  }),
);

/** The payload OK sends `paged.transform.reflectHorizontal`. */
export function reflectPayloadFor(
  o: ReflectOptions,
  targets: readonly string[],
) {
  return {
    targets,
    angleDeg: o.angleDeg,
    copy: o.copy,
    ...(o.aboutPoint ? { pivot: [o.x, o.y] as [number, number] } : {}),
  };
}

/** The addresses the dialog acts on, or null when it is closed. */
const OPEN = scoped("reflectDialog", () =>
  createValueStore<readonly string[] | null>(null),
);

export function openReflect(
  scope: EditorScope,
  targets: readonly string[],
): void {
  scope.get(OPEN).set(targets);
}

/** `ReflectCommandDeps.openOptions` for the app. */
export const openReflectOptions = (
  paged: unknown,
  addresses: readonly string[],
): void => openReflect(scopeOf(paged), addresses);

export function ReflectDialog() {
  const store = useScoped(OPEN);
  const targets = useSyncExternalStore(store.subscribe, store.get, store.get);
  return targets ? (
    <ReflectForm targets={targets} close={() => store.set(null)} />
  ) : null;
}

function ReflectForm({
  targets,
  close,
}: {
  targets: readonly string[];
  close: () => void;
}) {
  const strings = useStrings();
  const registries = useRegistries();
  const last = useScoped(LAST_OPTIONS);
  const [options, setOptions] = useState<ReflectOptions>(last.get);
  const set = <K extends keyof ReflectOptions>(k: K, v: ReflectOptions[K]) =>
    setOptions((o) => ({ ...o, [k]: v }));

  const ok = () => {
    last.set(options);
    void registries.commands
      .invoke(
        PAGED_TRANSFORM_REFLECT_HORIZONTAL,
        reflectPayloadFor(options, targets),
      )
      .finally(close);
  };
  // Escape closes: the modal tier of the Escape arbiter (ADR 1207).
  useEscapeHandler({
    id: "paged.reflectDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });

  return (
    <div
      data-reflect-backdrop=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reflect-title"
        data-reflect-dialog=""
        data-panel-host=""
        style={{
          width: "min(340px, 92vw)",
          padding: 16,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="reflect-title"
            style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <div className="flex flex-col gap-1.5">
            <Row label={strings.t(M.angle)}>
              <NumberInput
                aria-label={strings.t(M.angle)}
                value={options.angleDeg}
                suffix="°"
                onChange={(v) => set("angleDeg", v)}
              />
            </Row>
            <Check
              label={strings.t(M.aboutPoint)}
              checked={options.aboutPoint}
              onChange={(v) => set("aboutPoint", v)}
              data="about-point"
            />
            <Row label={strings.t(M.pointX)}>
              <LengthInput
                aria-label={strings.t(M.pointX)}
                valuePt={options.x}
                disabled={!options.aboutPoint}
                onChangePt={(v) => set("x", v)}
              />
            </Row>
            <Row label={strings.t(M.pointY)}>
              <LengthInput
                aria-label={strings.t(M.pointY)}
                valuePt={options.y}
                disabled={!options.aboutPoint}
                onChangePt={(v) => set("y", v)}
              />
            </Row>
            <Check
              label={strings.t(M.copy)}
              checked={options.copy}
              onChange={(v) => set("copy", v)}
              data="copy"
            />
            <div
              className="text-xs"
              style={{ color: "var(--pg-muted-fg)" }}
              data-reflect-note=""
            >
              {strings.t(M.note)}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-reflect-cancel=""
              onClick={close}
              style={{
                ...buttonStyle,
                background: "transparent",
                color: color.fg,
              }}
            >
              {strings.t(M.cancel)}
            </button>
            <button
              type="button"
              data-reflect-ok=""
              onClick={ok}
              style={buttonStyle}
            >
              {strings.t(M.ok)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[84px]" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  data,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  data: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        data-reflect-check={data}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};
