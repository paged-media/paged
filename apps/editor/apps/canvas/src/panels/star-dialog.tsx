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

// Object > Insert star… (Illustrator's Star dialog): Radius 1 (the tips),
// Radius 2 (the valleys), points and rotation. OK runs `paged.insert.star`
// with those values: the star lands centred on the current page as ONE undo
// step, live where the engine draws it (an upright star with Radius 2 the
// smaller). The values last used are kept for the session of this editor.

import { useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  createValueStore,
  FocusScope,
  scoped,
  useRegistries,
  useScoped,
  type EditorScope,
  useEscapeHandler,
} from "@paged-media/shell";
import { LengthInput, NumberInput } from "@paged-media/ui";
import { color, radius } from "@paged-media/panel-kit";
import {
  STAR_DEFAULTS,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
} from "@paged-media/vector-geometry";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.starDialog", {
  title: "Star",
  radius1: "Radius 1",
  radius2: "Radius 2",
  points: "Points",
  rotation: "Rotation",
  note: "Radius 1 is the tips, Radius 2 the valleys between them. A star that stands upright with the smaller Radius 2 stays editable as a polygon with a star inset; a turned one, or one with the larger Radius 2, is a plain path.",
  ok: "OK",
  cancel: "Cancel",
});

/** What the dialog sets. */
export interface StarOptions {
  radius1: number;
  radius2: number;
  points: number;
  rotationDeg: number;
}

const DEFAULTS: StarOptions = {
  radius1: STAR_DEFAULTS.radius1,
  radius2: STAR_DEFAULTS.radius2,
  points: STAR_DEFAULTS.points,
  rotationDeg: STAR_DEFAULTS.rotationDeg,
};

/** The options last used, per editor. */
const LAST_OPTIONS = scoped("starOptions", () =>
  createValueStore<StarOptions>(DEFAULTS),
);

/** Whether the dialog is open, per editor. */
const OPEN = scoped("starDialog", () => createValueStore<boolean>(false));

export function openStarDialog(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export function StarDialog() {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <StarForm close={() => store.set(false)} /> : null;
}

function StarForm({ close }: { close: () => void }) {
  const strings = useStrings();
  const registries = useRegistries();
  const last = useScoped(LAST_OPTIONS);
  const [options, setOptions] = useState<StarOptions>(last.get);
  const set = <K extends keyof StarOptions>(k: K, v: StarOptions[K]) =>
    setOptions((o) => ({ ...o, [k]: v }));

  const ok = () => {
    last.set(options);
    void registries.commands
      .invoke("paged.insert.star", { ...options })
      .finally(close);
  };
  // Escape closes: the modal tier of the Escape arbiter (ADR 1207).
  useEscapeHandler({
    id: "paged.starDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });

  return (
    <div
      data-star-backdrop=""
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
        aria-labelledby="star-title"
        data-star-dialog=""
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
            id="star-title"
            style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <div className="flex flex-col gap-1.5">
            <Row label={strings.t(M.radius1)}>
              <LengthInput
                aria-label={strings.t(M.radius1)}
                valuePt={options.radius1}
                onChangePt={(v) => set("radius1", Math.abs(v))}
              />
            </Row>
            <Row label={strings.t(M.radius2)}>
              <LengthInput
                aria-label={strings.t(M.radius2)}
                valuePt={options.radius2}
                onChangePt={(v) => set("radius2", Math.abs(v))}
              />
            </Row>
            <Row label={strings.t(M.points)}>
              <NumberInput
                aria-label={strings.t(M.points)}
                value={options.points}
                min={STAR_MIN_POINTS}
                max={STAR_MAX_POINTS}
                step={1}
                onChange={(v) => set("points", Math.round(v))}
              />
            </Row>
            <Row label={strings.t(M.rotation)}>
              <NumberInput
                aria-label={strings.t(M.rotation)}
                value={options.rotationDeg}
                suffix="°"
                onChange={(v) => set("rotationDeg", v)}
              />
            </Row>
            <div
              className="text-xs"
              style={{ color: "var(--pg-muted-fg)" }}
              data-star-note=""
            >
              {strings.t(M.note)}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-star-cancel=""
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
              data-star-ok=""
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

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};
