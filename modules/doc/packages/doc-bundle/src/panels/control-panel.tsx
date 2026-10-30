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

// Doc ADR 614 (content controls) — the Content control panel: the control
// at the caret, and what changes it. A checkbox toggles, a drop-down or a
// combo box chooses an item (a combo box also takes text), a date takes a
// date, a text control a text. Each button is one engine mutation, one
// undo step (engine ADR 1052).

import type { PanelProps } from "@paged-media/plugin-api";
import { t as tActive, useStrings } from "@paged-media/strings";
import * as React from "react";

import { WORD } from "../messages.js";
import type {
  ControlAction,
  ControlAtCaret,
  ControlStore,
} from "../word/controls.js";
import type { PanelDescriptor } from "./outline-panel.js";

const box: React.CSSProperties = {
  padding: "8px 12px",
  display: "grid",
  gap: 6,
  fontSize: 13,
};
const row: React.CSSProperties = { display: "flex", gap: 6 };

function Editor({
  at,
  act,
}: {
  at: ControlAtCaret;
  act: (a: ControlAction) => Promise<boolean>;
}) {
  const { t } = useStrings();
  const c = at.control;
  const [text, setText] = React.useState(
    c.showingPlaceholder ? "" : at.text,
  );
  const [refused, setRefused] = React.useState(false);
  React.useEffect(() => {
    setText(c.showingPlaceholder ? "" : at.text);
    setRefused(false);
  }, [c.id, at.text, c.showingPlaceholder]);
  const run = (a: ControlAction) =>
    void act(a).then((ok) => setRefused(!ok));
  const locked = c.lock === "contentLocked" || c.lock === "sdtContentLocked";
  return (
    <div style={box} data-doc-control={c.kind} data-doc-control-id={c.id}>
      <strong>{c.alias || c.tag || t(WORD.controlTitle)}</strong>
      {c.kind === "checkbox" && (
        <label style={row}>
          <input
            type="checkbox"
            checked={c.checked === true}
            disabled={locked}
            onChange={() => run({ kind: "toggle" })}
            data-doc-control-input="checkbox"
          />
          {t(WORD.controlChecked)}
        </label>
      )}
      {(c.kind === "dropDown" || c.kind === "comboBox") && (
        <select
          aria-label={t(WORD.controlChoose)}
          value={Math.max(
            0,
            (c.items ?? []).findIndex((i) => i.value === c.value),
          )}
          disabled={locked}
          onChange={(e) =>
            run({ kind: "choose", index: Number(e.target.value) })
          }
          data-doc-control-input="choose"
        >
          {(c.items ?? []).map((item, i) => (
            <option key={`${i}-${item.value}`} value={i}>
              {item.display}
            </option>
          ))}
        </select>
      )}
      {c.kind === "date" && (
        <input
          type="date"
          aria-label={t(WORD.controlDate)}
          value={c.value ?? ""}
          disabled={locked}
          onChange={(e) =>
            e.target.value && run({ kind: "set", value: e.target.value })
          }
          data-doc-control-input="date"
        />
      )}
      {(c.kind === "plainText" ||
        c.kind === "richText" ||
        c.kind === "comboBox") && (
        <div style={row}>
          <input
            aria-label={t(WORD.controlText)}
            value={text}
            disabled={locked}
            onChange={(e) => setText(e.target.value)}
            data-doc-control-input="text"
          />
          <button
            type="button"
            disabled={locked}
            onClick={() => run({ kind: "set", value: text })}
            data-doc-control-action="set"
          >
            {t(WORD.controlSet)}
          </button>
        </div>
      )}
      {locked && <small>{t(WORD.controlLocked)}</small>}
      {refused && <small data-doc-control-refused="">{t(WORD.refRefused)}</small>}
    </div>
  );
}

export function makeControlPanel(
  store: ControlStore,
  act: (at: ControlAtCaret, a: ControlAction) => Promise<boolean>,
): PanelDescriptor {
  const Component: React.FC<PanelProps> = () => {
    const at = React.useSyncExternalStore(store.subscribe, store.get);
    const { t } = useStrings();
    if (!at) {
      return (
        <div style={box} data-doc-panel="control">
          <small>{t(WORD.controlNone)}</small>
        </div>
      );
    }
    return (
      <div data-doc-panel="control">
        <Editor at={at} act={(a) => act(at, a)} />
      </div>
    );
  };
  return {
    title: tActive(WORD.controlTitle),
    component: Component,
    defaultDock: "right",
    icon: "panel-outline",
  };
}
