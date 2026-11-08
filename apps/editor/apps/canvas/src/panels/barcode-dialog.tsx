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

// Object > Insert barcode…: the data to encode and its symbology (EAN-13,
// UPC-A, Code-128, QR). OK runs `paged.insert.barcode` with those values: the
// symbol lands centred on the current page as ONE undo step. The values last
// used are kept for the session of this editor.

import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  createValueStore,
  FocusScope,
  scoped,
  useRegistries,
  useScoped,
  type EditorScope,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  BARCODE_SYMBOLOGIES,
  type BarcodeSymbology,
} from "../barcode-commands";

const M = defineMessages("app.barcodeDialog", {
  title: "Barcode",
  data: "Data",
  symbology: "Symbology",
  ean13: "EAN-13",
  upca: "UPC-A",
  code128: "Code-128",
  qr: "QR code",
  note: "EAN-13 and UPC-A take digits (the check digit is added when it is left out), Code-128 and QR any text. The symbol is drawn as vector modules, black on the page.",
  ok: "OK",
  cancel: "Cancel",
});

/** What the dialog sets. */
export interface BarcodeOptions {
  symbology: BarcodeSymbology;
  data: string;
}

const DEFAULTS: BarcodeOptions = { symbology: "qr", data: "" };

/** The options last used, per editor. */
const LAST_OPTIONS = scoped("barcodeOptions", () =>
  createValueStore<BarcodeOptions>(DEFAULTS),
);

/** Whether the dialog is open, per editor. */
const OPEN = scoped("barcodeDialog", () => createValueStore<boolean>(false));

export function openBarcodeDialog(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export function BarcodeDialog() {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <BarcodeForm close={() => store.set(false)} /> : null;
}

function BarcodeForm({ close }: { close: () => void }) {
  const strings = useStrings();
  const registries = useRegistries();
  const last = useScoped(LAST_OPTIONS);
  const [options, setOptions] = useState<BarcodeOptions>(last.get);
  const set = <K extends keyof BarcodeOptions>(k: K, v: BarcodeOptions[K]) =>
    setOptions((o) => ({ ...o, [k]: v }));
  const label = (s: BarcodeSymbology) => strings.t(M[s]);
  const ready = options.data.length > 0;

  const ok = () => {
    if (!ready) return;
    last.set(options);
    void registries.commands
      .invoke("paged.insert.barcode", { ...options })
      .finally(close);
  };
  const onEscape = useEffectEvent(() => close());
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div
      data-barcode-backdrop=""
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
        aria-labelledby="barcode-title"
        data-barcode-dialog=""
        data-panel-host=""
        style={{
          width: "min(360px, 92vw)",
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
            id="barcode-title"
            style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <div className="flex flex-col gap-1.5">
            <Row label={strings.t(M.symbology)}>
              <select
                aria-label={strings.t(M.symbology)}
                data-barcode-symbology=""
                value={options.symbology}
                onChange={(e) =>
                  set("symbology", e.target.value as BarcodeSymbology)
                }
                style={fieldStyle}
              >
                {BARCODE_SYMBOLOGIES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={strings.t(M.data)}>
              <input
                type="text"
                aria-label={strings.t(M.data)}
                data-barcode-data=""
                value={options.data}
                onChange={(e) => set("data", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ok();
                }}
                style={fieldStyle}
              />
            </Row>
            <div
              className="text-xs"
              style={{ color: "var(--pg-muted-fg)" }}
              data-barcode-note=""
            >
              {strings.t(M.note)}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-barcode-cancel=""
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
              data-barcode-ok=""
              disabled={!ready}
              onClick={ok}
              style={{ ...buttonStyle, opacity: ready ? 1 : 0.5 }}
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

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  borderRadius: 6,
  fontSize: 12,
  border: `1px solid ${color.border}`,
  background: "transparent",
  color: color.fg,
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};
