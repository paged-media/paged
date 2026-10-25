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

// The Data panel's issues line (editor ADR 291, amended 2026-10-24): what
// may be wrong with the content the data placed, as the service names it
// (`data@1` `issues()`): "2 texts do not fit · 1 picture missing". Clicking
// it selects the page items concerned; each issue's message, which says what
// to do, is its tooltip. Read again when the data changes and on the pushes
// that change the document (a frame grown to fit clears its issue).

import { useEffect, useState } from "react";

import type { DataIssue, DataService } from "@paged-media/plugin-api";
import { font, space, status } from "@paged-media/panel-kit";
import {
  elementOfPlacement,
  useCanvasClient,
  useDataRevision,
  useSelection,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.dataPanel.issues", {
  overset:
    "{count, plural, one {# text does not fit} other {# texts do not fit}}",
  missingAsset:
    "{count, plural, one {# picture missing} other {# pictures missing}}",
  lowResolution:
    "{count, plural, one {# picture too coarse} other {# pictures too coarse}}",
  emptyValue: "{count, plural, one {# value empty} other {# values empty}}",
  error: "{count, plural, one {# binding failed} other {# bindings failed}}",
  unplacedRecords:
    "{count, plural, one {# flow left records out} other {# flows left records out}}",
  select: "Click to select the frames concerned.",
});

const ORDER: DataIssue["kind"][] = [
  "error",
  "missingAsset",
  "overset",
  "unplacedRecords",
  "lowResolution",
  "emptyValue",
];

const TONE: Record<DataIssue["severity"], string> = {
  error: status.error,
  warning: status.warn,
  info: "var(--pg-muted-fg)",
};

/** The summary's parts: each kind present with its count, worst first. */
export function issueCounts(
  issues: readonly DataIssue[],
): { kind: DataIssue["kind"]; count: number }[] {
  return ORDER.map((kind) => ({
    kind,
    count: issues.filter((i) => i.kind === kind).length,
  })).filter((p) => p.count > 0);
}

/** The page items the issues are in, each once. */
export function issueElements(issues: readonly DataIssue[]): ElementId[] {
  const seen = new Set<string>();
  const out: ElementId[] = [];
  for (const i of issues) {
    const id = i.address ? elementOfPlacement(i.address) : null;
    if (!id || seen.has(i.address!)) continue;
    seen.add(i.address!);
    out.push(id);
  }
  return out;
}

/** The service's issues, or none when it serves none or the read fails.
 *  Outside the component: the React Compiler does not compile a
 *  conditional inside a `try` (ADR 229). */
async function readIssues(service: DataService): Promise<DataIssue[]> {
  if (typeof service.issues !== "function") return [];
  try {
    return [...(await service.issues())];
  } catch {
    return [];
  }
}

interface SelectDeps {
  client: ReturnType<typeof useCanvasClient>;
  setElementSelection: ReturnType<typeof useSelection>["setElementSelection"];
  setElementGeometry: ReturnType<typeof useSelection>["setElementGeometry"];
}

/** Select `ids`, as the field header's double-click selects a field's
 *  frames (`selectPlaced`, data-panel.tsx). */
async function selectElements(
  { client, setElementSelection, setElementGeometry }: SelectDeps,
  ids: ElementId[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const applied = await client.setElementSelection(ids, "replace");
    setElementSelection(applied);
    setElementGeometry(await client.elementGeometry(applied));
  } catch {
    // An item that vanished meanwhile: the selection stays as it was.
  }
}

export function DataIssuesLine({ service }: { service: DataService }) {
  const { t } = useStrings();
  const client = useCanvasClient();
  const { setElementSelection, setElementGeometry } = useSelection();
  const revision = useDataRevision();
  const [issues, setIssues] = useState<DataIssue[]>([]);

  useEffect(() => {
    if (typeof service.issues !== "function") return;
    // Each read is numbered: a late reply of an older one is dropped.
    const runs = { current: 0 };
    let live = true;
    const read = () => {
      runs.current += 1;
      const mine = runs.current;
      void readIssues(service).then((next) => {
        if (live && mine === runs.current) setIssues(next);
      });
    };
    read();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "documentLoaded"
      )
        read();
    });
    return () => {
      off();
      live = false;
    };
  }, [service, client, revision]);

  const parts = issueCounts(issues);
  if (parts.length === 0) return null;
  const worst: DataIssue["severity"] = issues.some(
    (i) => i.severity === "error",
  )
    ? "error"
    : issues.some((i) => i.severity === "warning")
      ? "warning"
      : "info";
  const ids = issueElements(issues);
  const title = [
    ...issues.map((i) => i.message),
    ...(ids.length > 0 ? ["", t(M.select)] : []),
  ].join("\n");
  return (
    <button
      type="button"
      data-data-issues={worst}
      title={title}
      disabled={ids.length === 0}
      onClick={() =>
        void selectElements(
          { client, setElementSelection, setElementGeometry },
          ids,
        )
      }
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: `0 ${space[2]} ${space[1]}`,
        font: `11px ${font.sans}`,
        color: TONE[worst],
        cursor: ids.length > 0 ? "pointer" : "default",
      }}
    >
      {parts.map((p, k) => (
        <span key={p.kind} data-data-issue-kind={p.kind}>
          {k > 0 ? " · " : ""}
          {t(M[p.kind], { count: p.count })}
        </span>
      ))}
    </button>
  );
}
