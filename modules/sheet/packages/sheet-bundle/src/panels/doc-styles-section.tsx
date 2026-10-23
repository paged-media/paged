// Sheet ADR 524 — the workbook panel's "Document styles" section: the "Use
// document styles" switch, the table from Excel named styles to the
// document's paragraph / character / cell styles (with how many cells use
// each), "Create document styles from workbook", and the references the
// document no longer has with a remap. Thin glue: the engine folds the
// mapping into every cell's style; the session reads the document and
// journals each change as one undo step.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { font, radius, space } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import type { DocumentStyleLists, MissingReference } from "../doc-styles";
import type { DocStyleTarget } from "../engine-docstyles";
import type { WorkbookSession } from "../session";
import { DOC_STYLES as M } from "../messages";

export type DocStylesSession = Pick<
  WorkbookSession,
  | "docStyles"
  | "documentStyleLists"
  | "documentStyleRevision"
  | "setDocStylesEnabled"
  | "setDocStyleMapping"
  | "createDocStylesFromWorkbook"
  | "remapDocReference"
>;

const note: CSSProperties = {
  margin: `${space[1]} 0 0`,
  font: `11px/1.5 ${font.sans}`,
  color: "var(--pg-muted-fg)",
};

const body: CSSProperties = {
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
};

const select: CSSProperties = {
  font: `11px ${font.sans}`,
  color: "var(--pg-fg)",
  background: "var(--pg-bg)",
  border: "1px solid var(--pg-border)",
  borderRadius: radius.sm,
  padding: "2px 4px",
  minWidth: 0,
  width: "100%",
};

const button: CSSProperties = {
  font: `12px ${font.sans}`,
  padding: "3px 8px",
  color: "var(--pg-fg)",
  background: "var(--pg-muted)",
  border: "1px solid var(--pg-border)",
  borderRadius: radius.sm,
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  font: "inherit",
  color: "var(--pg-primary)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
};

const cellStyle: CSSProperties = {
  padding: "2px 2px",
  verticalAlign: "middle",
};

type Slot = "para" | "char" | "cell";
const LIST_OF: Record<Slot, keyof Omit<DocumentStyleLists, "swatches">> = {
  para: "paragraph",
  char: "character",
  cell: "cell",
};

/** One style select: none, the document's styles, and — when the mapping
 *  names one the document lost — that id, marked. */
function StyleSelect(props: {
  value: string | undefined;
  rows: readonly { id: string; name: string }[];
  label: string;
  none: string;
  onChange: (id: string | undefined) => void;
  data: string;
}): ReactElement {
  const known = props.rows.some((r) => r.id === props.value);
  return (
    <select
      data-sheet-docstyles-select={props.data}
      aria-label={props.label}
      value={props.value ?? ""}
      onChange={(e) => props.onChange(e.target.value || undefined)}
      style={select}
    >
      <option value="">{props.none}</option>
      {props.value && !known && (
        <option value={props.value}>{`${props.value} ⚠`}</option>
      )}
      {props.rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

export function DocStylesSection(props: {
  session: DocStylesSession;
}): ReactElement {
  const { session } = props;
  const { t } = useStrings();
  const info = session.docStyles();
  const [lists, setLists] = useState<DocumentStyleLists | null>(null);
  const [missing, setMissing] = useState<MissingReference[]>([]);
  const [unread, setUnread] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [remapOpen, setRemapOpen] = useState(false);
  const [remapTo, setRemapTo] = useState<Record<string, string>>({});
  const revision = session.documentStyleRevision();
  // The document's lists and what is missing: re-read when the document's
  // styles or the workbook's mapping may have changed.
  const key = info ? JSON.stringify([info.enabled, info.entries]) : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    void session.documentStyleLists().then((r) => {
      if (!live) return;
      setUnread(r === null);
      setLists(r?.lists ?? null);
      setMissing(r?.missing ?? []);
    });
    return () => {
      live = false;
    };
  }, [session, key, revision]);

  if (!info) {
    return (
      <p data-sheet-docstyles-empty style={note}>
        {t(M.noWorkbook)}
      </p>
    );
  }

  const report = (r: { ok: true } | { ok: false; message: string }) =>
    setMsg(r.ok ? null : r.message);

  // The rows: Normal, every style the cells use, every mapped style.
  const rows = info.usage.filter(
    (u) =>
      u.name === "Normal" ||
      u.cells > 0 ||
      Object.keys(info.entries).some(
        (k) => k.toLowerCase() === u.name.toLowerCase(),
      ),
  );
  const entryOf = (name: string): DocStyleTarget =>
    Object.entries(info.entries).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    )?.[1] ?? {};
  const setSlot = (name: string, slot: Slot, id: string | undefined) => {
    const next = { ...entryOf(name), [slot]: id ?? null };
    report(session.setDocStyleMapping(name, next));
  };

  return (
    <div data-sheet-docstyles style={body}>
      <label style={{ display: "flex", alignItems: "center", gap: space[1] }}>
        <input
          type="checkbox"
          data-sheet-docstyles-enabled
          checked={info.enabled}
          onChange={(e) =>
            void session.setDocStylesEnabled(e.target.checked).then(report)
          }
        />
        {t(M.useDocumentStyles)}
      </label>
      {!info.enabled && (
        <p data-sheet-docstyles-offer style={note}>
          {t(M.offer)}
        </p>
      )}
      <table
        data-sheet-docstyles-table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: space[1],
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr style={{ ...note, textAlign: "left" }}>
            <th style={cellStyle}>{t(M.excelStyle)}</th>
            <th style={cellStyle}>{t(M.paragraphStyle)}</th>
            <th style={cellStyle}>{t(M.characterStyle)}</th>
            <th style={cellStyle}>{t(M.cellStyle)}</th>
            <th style={{ ...cellStyle, width: "3em", textAlign: "right" }}>
              {t(M.cells)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const entry = entryOf(u.name);
            return (
              <tr key={u.name} data-sheet-docstyles-row={u.name}>
                <td
                  style={{
                    ...cellStyle,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={u.name}
                >
                  {u.name}
                </td>
                {(["para", "char", "cell"] as const).map((slot) => (
                  <td key={slot} style={cellStyle}>
                    <StyleSelect
                      data={`${u.name}:${slot}`}
                      value={entry[slot] ?? undefined}
                      rows={lists ? lists[LIST_OF[slot]] : []}
                      label={`${u.name} · ${t(
                        slot === "para"
                          ? M.paragraphStyle
                          : slot === "char"
                            ? M.characterStyle
                            : M.cellStyle,
                      )}`}
                      none={t(M.none)}
                      onChange={(id) => setSlot(u.name, slot, id)}
                    />
                  </td>
                ))}
                <td
                  style={{
                    ...cellStyle,
                    textAlign: "right",
                    fontFamily: font.mono,
                  }}
                >
                  {u.cells}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: space[1] }}>
        <button
          type="button"
          data-sheet-docstyles-create
          style={button}
          onClick={() =>
            void session
              .createDocStylesFromWorkbook()
              .then((r) =>
                setMsg(
                  r.ok ? t(M.created, { count: r.created ?? 0 }) : r.message,
                ),
              )
          }
        >
          {t(M.create)}
        </button>
      </div>
      {missing.length > 0 && (
        <p
          data-sheet-docstyles-missing
          style={{
            ...note,
            color: "var(--status-warning, var(--pg-muted-fg))",
          }}
        >
          {t(M.missing, { count: missing.length })}
          {" · "}
          <button
            type="button"
            data-sheet-docstyles-remap
            style={linkButton}
            onClick={() => setRemapOpen((o) => !o)}
          >
            {t(M.remap)}
          </button>
        </p>
      )}
      {remapOpen && lists && missing.length > 0 && (
        <div data-sheet-docstyles-remap-list>
          {missing.map((m) => {
            const options =
              m.kind === "swatch"
                ? lists.swatches.map((id) => ({ id, name: id }))
                : lists[m.kind];
            return (
              <div
                key={`${m.kind}:${m.id}`}
                data-sheet-docstyles-missing-ref={m.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr auto",
                  gap: space[1],
                  alignItems: "center",
                  marginTop: space[1],
                }}
              >
                <span style={note}>{t(M.remapTo, { id: m.id })}</span>
                <StyleSelect
                  data={`remap:${m.id}`}
                  value={remapTo[m.id]}
                  rows={options}
                  label={t(M.remapTo, { id: m.id })}
                  none={t(M.none)}
                  onChange={(id) =>
                    setRemapTo((r) => ({ ...r, [m.id]: id ?? "" }))
                  }
                />
                <button
                  type="button"
                  data-sheet-docstyles-remap-apply={m.id}
                  style={button}
                  disabled={!remapTo[m.id]}
                  onClick={() =>
                    void session
                      .remapDocReference(m.id, remapTo[m.id])
                      .then(report)
                  }
                >
                  {t(M.remap)}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {unread && (
        <p data-sheet-docstyles-unread style={note}>
          {t(M.unread)}
        </p>
      )}
      {msg && (
        <p
          data-sheet-docstyles-msg
          style={{ ...body, margin: `${space[1]} 0 0` }}
        >
          {msg}
        </p>
      )}
      <p style={note}>{t(M.note)}</p>
    </div>
  );
}
