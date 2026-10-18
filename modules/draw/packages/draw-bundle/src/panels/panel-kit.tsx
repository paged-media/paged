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

// Shared pieces of the React panels in this folder:
//   · PanelIntro — one plain sentence on what the panel is for, plus the
//     longer explanation in a collapsed "About" disclosure;
//   · useActionFeedback — runs a panel action and shows its refusal IN the
//     panel (a command that refuses says why through `host.log.warn`; the
//     panel used to leave that in the log, where nobody looks);
//   · ConfirmButton — a destructive action that cannot be undone takes a
//     second click on a button that now reads "Confirm delete";
//   · human labels for the kinds of selected objects.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import * as React from "react";

const introStyle: React.CSSProperties = {
  margin: "0 0 8px",
  font: "12px/1.45 var(--font-sans, sans-serif)",
  color: "var(--pg-muted-fg, currentColor)",
};
const aboutStyle: React.CSSProperties = {
  marginTop: 10,
  font: "11px/1.45 var(--font-sans, sans-serif)",
  color: "var(--pg-muted-fg, currentColor)",
};
const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  font: "11px var(--font-sans, sans-serif)",
};
const refusalStyle: React.CSSProperties = {
  margin: "6px 0",
  padding: "4px 6px",
  borderLeft: "2px solid var(--status-error, currentColor)",
  font: "12px/1.4 var(--font-sans, sans-serif)",
  color: "var(--pg-fg, currentColor)",
  overflowWrap: "anywhere",
};

/** The one-sentence intro at the top of a panel. */
export function PanelIntro(props: {
  /** One plain sentence: what the panel is for. */
  summary: string;
  /** `data-*` attribute name the intro carries (for tests). */
  attr: string;
}): React.ReactElement {
  return (
    <p style={introStyle} {...{ [props.attr]: "" }}>
      {props.summary}
    </p>
  );
}

/** The collapsed "About" disclosure at the bottom of a panel. The `attr`
 *  sits on the body, so its text is exactly `text`. */
export function PanelAbout(props: {
  text: string;
  attr: string;
}): React.ReactElement {
  return (
    <details style={aboutStyle}>
      <summary style={summaryStyle}>About</summary>
      <div style={{ marginTop: 4 }} {...{ [props.attr]: "" }}>
        {props.text}
      </div>
    </details>
  );
}

// ------------------------------------------------------------ refusals

type Warn = (message: string, ...rest: unknown[]) => void;
interface WarnTap {
  listeners: Set<(message: string) => void>;
}
const taps = new WeakMap<object, WarnTap>();

/** Listen to `host.log.warn` without replacing the host object (the
 *  commands key their caches on its identity). The tap forwards every
 *  call unchanged; null when the log cannot be tapped. */
function tapWarnings(host: BundleHost): WarnTap | null {
  const log = host.log as unknown as { warn: Warn };
  const known = taps.get(log);
  if (known) return known;
  const original = log.warn;
  if (typeof original !== "function") return null;
  const tap: WarnTap = { listeners: new Set() };
  try {
    log.warn = (message: string, ...rest: unknown[]) => {
      original.call(log, message, ...rest);
      for (const l of [...tap.listeners]) l(String(message));
    };
  } catch {
    return null;
  }
  taps.set(log, tap);
  return tap;
}

/** A command's log line, as a sentence for the panel: the command id
 *  prefix and the trailing "no-op" go. */
export function refusalText(message: string): string {
  let text = message.trim();
  text = text.replace(/^[a-z][\w.-]*(?: panel)?:\s+/i, "");
  text = text.replace(/\s*[—-]+\s*no-op\.?$/i, "");
  if (text.length === 0) return "The action did not run.";
  text = text[0]!.toUpperCase() + text.slice(1);
  return /[.!?)]$/.test(text) ? text : `${text}.`;
}

/**
 * Run panel actions and keep the last refusal on screen. `run(work)`
 * clears the previous message, runs the work, and shows the first
 * warning it logged (or the error it threw) until the next action.
 * `after` runs once the work settled (the panel's reload).
 */
export function useActionFeedback(
  host: BundleHost,
  after: () => void,
): {
  refusal: string | null;
  run: (work: () => Promise<unknown>) => Promise<void>;
} {
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = React.useCallback(
    async (work: () => Promise<unknown>) => {
      setRefusal(null);
      const tap = tapWarnings(host);
      let first: string | null = null;
      const listen = (message: string) => {
        if (first === null) first = message;
      };
      tap?.listeners.add(listen);
      try {
        await work();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        host.log.warn(`draw panel: ${message}`);
        if (first === null) first = message;
      } finally {
        tap?.listeners.delete(listen);
      }
      if (mounted.current && first !== null) setRefusal(refusalText(first));
      after();
    },
    [host, after],
  );
  return { refusal, run };
}

/** The refusal line a panel shows under its header. */
export function Refusal(props: {
  text: string | null;
  attr?: string;
}): React.ReactElement | null {
  if (props.text === null) return null;
  return (
    <div
      role="status"
      style={refusalStyle}
      {...{ [props.attr ?? "data-draw-panel-refusal"]: "" }}
    >
      {props.text}
    </div>
  );
}

// ------------------------------------------------------------ confirm

/** How long a destructive button stays armed. */
export const CONFIRM_TIMEOUT_MS = 4000;

/**
 * A button for an action that cannot be undone. The first click arms it
 * (it reads `confirmLabel`); a second click within a few seconds runs
 * `onConfirm`; otherwise it reverts.
 */
export function ConfirmButton(
  props: {
    label: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">,
): React.ReactElement {
  const { label, confirmLabel = "Confirm delete", onConfirm, title, ...rest } =
    props;
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      {...rest}
      data-armed={armed ? "true" : "false"}
      title={armed ? "Click again to confirm. This cannot be undone." : title}
      style={{
        ...rest.style,
        ...(armed ? { color: "var(--status-error, currentColor)" } : null),
      }}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

// ------------------------------------------------------------ labels

const KIND_LABELS: Readonly<Record<string, string>> = {
  polygon: "path",
  graphicLine: "line",
  rectangle: "rectangle",
  oval: "ellipse",
  textFrame: "text frame",
  group: "group",
};

/** "path", "line", "text frame"… for a selected element's kind. */
export function elementKindLabel(id: ElementId): string {
  return KIND_LABELS[id.kind] ?? "object";
}

/** "topLeft" → "Top left", "easeInOut" → "Ease in out". */
export function humanize(token: string): string {
  const words = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.length === 0 ? token : words[0]!.toUpperCase() + words.slice(1);
}
