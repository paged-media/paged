// The session's diagnostics, as a panel shows them: what failed or was
// deliberately skipped, newest first, with the binding it concerns. Shared by
// the sources panel (imports) and the bindings panel (refresh, preview,
// bindings, variables) — each passes the sources it owns. Renders nothing when
// there is nothing to say.

import type { CSSProperties, ReactElement } from "react";

import type { SessionDiagnostic } from "../session";
import { color, space, status } from "@paged-media/panel-kit";

const COLOR: Record<SessionDiagnostic["level"], string> = {
  error: status.error,
  warn: status.warn,
  info: color.mutedFg,
};

const list: CSSProperties = {
  margin: 0,
  paddingLeft: space[3],
  fontSize: "11px",
  lineHeight: 1.5,
};

/** The diagnostics of `sources` (all when omitted), newest first, with a
 *  clear action. */
export function DiagnosticsList(props: {
  diagnostics: readonly SessionDiagnostic[];
  sources?: readonly SessionDiagnostic["source"][];
  onClear?: () => void;
}): ReactElement | null {
  const shown = props.diagnostics
    .filter((d) => !props.sources || props.sources.includes(d.source))
    .slice()
    .reverse();
  if (shown.length === 0) return null;
  return (
    <div data-data-diagnostics>
      <ul style={list}>
        {shown.map((d, i) => (
          <li
            key={i}
            data-level={d.level}
            data-source={d.source}
            style={{ color: COLOR[d.level] }}
          >
            {d.source}
            {d.binding ? ` · ${d.binding}` : ""}: {d.message}
          </li>
        ))}
      </ul>
      {props.onClear && (
        <button type="button" onClick={props.onClear}>
          Clear messages
        </button>
      )}
    </div>
  );
}
