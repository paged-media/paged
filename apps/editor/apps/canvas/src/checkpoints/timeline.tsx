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

// The document's timeline in the Library panel (editor ADR 1234):
// "Imported → Typography pass → Exported … → Approved", oldest first, each
// a named checkpoint. Save checkpoint… names the open state; selecting a
// checkpoint offers Preview (its pages, read-only), Compare with current
// (both side by side, what changed boxed and listed), Restore as new
// version (the open document kept first; nothing overwritten) and Remove
// (off the timeline; the version stays in the history).

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type {
  CheckpointEntry,
  DocumentEntry,
  LibraryClient,
} from "@paged-media/repository";
import { useEditorScope, usePaged } from "@paged-media/shell";
import { color, font, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import { openCompare } from "../compare/compare-dialog";
import { keepCheckpointReported, restoreCheckpointAsNew } from "./checkpoints";

const M = defineMessages("app.checkpointTimeline", {
  timeline: "Timeline",
  empty: "No checkpoints yet. Save checkpoint… names this state.",
  save: "Save checkpoint…",
  saveTitle:
    "Keep this state, saved or not, as a named point you can preview, compare and restore",
  name: "Checkpoint name",
  placeholder: "Typography pass",
  keep: "Keep",
  cancel: "Cancel",
  preview: "Preview",
  compare: "Compare with current",
  restore: "Restore as new version",
  restoreConfirm:
    "Make {name} the newest version? What is open now is kept as a checkpoint first.",
  remove: "Remove",
  current: "Current",
  auto: "automatic",
  import: "import",
  export: "export",
  before: "kept before a change",
  approved: "approval",
  pages: "{count, plural, one {# page} other {# pages}}",
});

const KIND_WORD = {
  named: null,
  import: M.import,
  export: M.export,
  before: M.before,
  approved: M.approved,
} as const;

/** The timeline of `doc`, read again whenever `version` changes. */
export function CheckpointTimeline({
  library,
  doc,
  version,
}: {
  library: LibraryClient;
  doc: DocumentEntry;
  version: unknown;
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const [list, setList] = useState<CheckpointEntry[]>([]);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let live = true;
    void library.checkpoints(doc.id).then(
      (l) => {
        if (live) setList(l);
      },
      () => {
        if (live) setList([]);
      },
    );
    return () => {
      live = false;
    };
  }, [library, doc, version, tick]);
  const refresh = () => setTick((n) => n + 1);
  const chosen = list.find((c) => c.id === selected) ?? null;
  const when = (ts: number) =>
    new Date(ts).toLocaleString(strings.locale, {
      dateStyle: "short",
      timeStyle: "short",
    });
  const keep = () => {
    const clean = name.trim();
    if (!clean) return;
    setNaming(false);
    setName("");
    void keepCheckpointReported(paged, clean).then(refresh);
  };
  return (
    <section data-checkpoint-timeline="" style={{ marginTop: 10 }}>
      <div style={headStyle}>
        <span style={kickerStyle}>{strings.t(M.timeline)}</span>
        <button
          type="button"
          data-checkpoint-save=""
          title={strings.t(M.saveTitle)}
          aria-expanded={naming}
          onClick={() => setNaming(!naming)}
          style={buttonStyle}
        >
          {strings.t(M.save)}
        </button>
      </div>
      {naming && (
        <form
          data-checkpoint-name-form=""
          onSubmit={(e) => {
            e.preventDefault();
            keep();
          }}
          style={{ display: "flex", gap: 6, margin: "6px 0" }}
        >
          <input
            autoFocus
            data-checkpoint-name=""
            aria-label={strings.t(M.name)}
            placeholder={strings.t(M.placeholder)}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNaming(false);
            }}
            style={{ ...buttonStyle, flex: 1, minWidth: 0 }}
          />
          <button
            type="submit"
            data-checkpoint-keep=""
            disabled={!name.trim()}
            style={buttonStyle}
          >
            {strings.t(M.keep)}
          </button>
          <button
            type="button"
            onClick={() => setNaming(false)}
            style={buttonStyle}
          >
            {strings.t(M.cancel)}
          </button>
        </form>
      )}
      {list.length === 0 ? (
        <p data-checkpoint-empty="" style={mutedStyle}>
          {strings.t(M.empty)}
        </p>
      ) : (
        <ol data-checkpoint-chain="" style={chainStyle}>
          {list.map((c) => (
            <li key={c.id} style={{ display: "contents" }}>
              <button
                type="button"
                data-checkpoint={c.id}
                data-checkpoint-kind={c.kind}
                aria-pressed={c.id === selected}
                title={when(c.ts)}
                onClick={() => {
                  setSelected(c.id === selected ? null : c.id);
                  setConfirming(false);
                }}
                style={{
                  ...chipStyle,
                  ...(c.id === selected ? chipSelectedStyle : {}),
                  ...(c.auto ? { borderStyle: "dashed" } : {}),
                }}
              >
                {c.name}
              </button>
              <span aria-hidden style={arrowStyle}>
                →
              </span>
            </li>
          ))}
          <li style={{ display: "contents" }}>
            <span data-checkpoint-current="" style={currentStyle}>
              {strings.t(M.current)}
            </span>
          </li>
        </ol>
      )}
      {chosen && (
        <div data-checkpoint-detail={chosen.id} style={detailStyle}>
          <div>
            <strong>{chosen.name}</strong>
            <span style={{ ...mutedStyle, marginLeft: 6 }}>
              {when(chosen.ts)}
              {KIND_WORD[chosen.kind]
                ? ` · ${strings.t(KIND_WORD[chosen.kind]!)}`
                : ""}
              {chosen.pages !== undefined
                ? ` · ${strings.t(M.pages, { count: chosen.pages })}`
                : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              data-checkpoint-preview=""
              onClick={() =>
                openCompare(scope, {
                  mode: "preview",
                  a: {
                    kind: "library",
                    docId: doc.id,
                    target: chosen.commit,
                    label: chosen.name,
                  },
                })
              }
              style={buttonStyle}
            >
              {strings.t(M.preview)}
            </button>
            <button
              type="button"
              data-checkpoint-compare=""
              onClick={() =>
                openCompare(scope, {
                  mode: "compare",
                  a: {
                    kind: "library",
                    docId: doc.id,
                    target: chosen.commit,
                    label: chosen.name,
                  },
                  b: { kind: "current", label: strings.t(M.current) },
                })
              }
              style={buttonStyle}
            >
              {strings.t(M.compare)}
            </button>
            <button
              type="button"
              data-checkpoint-restore=""
              onClick={() => setConfirming(true)}
              style={buttonStyle}
            >
              {strings.t(M.restore)}
            </button>
            <button
              type="button"
              data-checkpoint-remove=""
              onClick={() => {
                setSelected(null);
                void library
                  .removeCheckpoint(doc.id, chosen.id)
                  .then(refresh, refresh);
              }}
              style={buttonStyle}
            >
              {strings.t(M.remove)}
            </button>
          </div>
          {confirming && (
            <div
              data-checkpoint-restore-confirm=""
              style={{ display: "grid", gap: 4 }}
            >
              <span>{strings.t(M.restoreConfirm, { name: chosen.name })}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  data-checkpoint-restore-go=""
                  onClick={() => {
                    setConfirming(false);
                    void restoreCheckpointAsNew(paged, chosen).then(refresh);
                  }}
                  style={buttonStyle}
                >
                  {strings.t(M.restore)}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  style={buttonStyle}
                >
                  {strings.t(M.cancel)}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const mono: CSSProperties = { fontFamily: font.mono, fontSize: 11 };

const headStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const kickerStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
};

const buttonStyle: CSSProperties = {
  ...mono,
  cursor: "pointer",
  background: "transparent",
  color: "var(--pg-fg)",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "1px 6px",
};

const mutedStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "var(--pg-muted-fg)",
  fontSize: 11,
};

const chainStyle: CSSProperties = {
  listStyle: "none",
  margin: "8px 0 0",
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 4,
};

const chipStyle: CSSProperties = {
  ...mono,
  cursor: "pointer",
  background: "transparent",
  color: "var(--pg-fg)",
  border: `1px solid ${color.border}`,
  borderRadius: 999,
  padding: "1px 8px",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chipSelectedStyle: CSSProperties = {
  borderColor: "var(--pg-primary)",
  color: "var(--pg-primary)",
};

const arrowStyle: CSSProperties = { color: "var(--pg-muted-fg)", fontSize: 11 };

const currentStyle: CSSProperties = {
  ...mono,
  color: "var(--pg-muted-fg)",
  fontStyle: "italic",
};

const detailStyle: CSSProperties = {
  marginTop: 6,
  padding: 8,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  display: "grid",
  gap: 6,
};
