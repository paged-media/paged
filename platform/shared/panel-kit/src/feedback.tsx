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

// The outcome of a panel action, shown in the panel.
//
//   · `StatusLine` is the line itself: one tone (ok, warn, error, info)
//     from the kit's status tokens, `role="status"` so assistive tech
//     reads it when it changes.
//   · `Refusal` is the error line a panel shows under its header.
//   · `useActionFeedback` runs a panel action and keeps its refusal on
//     screen: a command that refuses says why through `host.log.warn`,
//     and a panel that left it there showed nothing where the user looks.

import type { BundleHost } from "@paged-media/plugin-api";
import * as React from "react";

import { refusalText } from "./text";
import { color, font, status, type Tone } from "./tokens";

/** A computed attribute name as props (the compiler does not lower a
 *  computed key inside a component). */
function attrProps(attr: string | undefined): Record<string, string> {
  return attr ? { [attr]: "" } : {};
}

/** The look of a status line of `tone`: a bar in the tone's colour, the
 *  text in the panel's. */
export function statusLineStyle(tone: Tone): React.CSSProperties {
  return {
    margin: "6px 0",
    padding: "4px 6px",
    borderLeft: `2px solid ${status[tone]}`,
    font: `12px/1.4 ${font.sans}`,
    color: color.fg,
    overflowWrap: "anywhere",
  };
}

/** One line saying how an action went. Renders nothing for null text. */
export function StatusLine(props: {
  tone?: Tone;
  children?: React.ReactNode;
  /** A `data-*` attribute for tests. */
  attr?: string;
  style?: React.CSSProperties;
}): React.ReactElement | null {
  if (props.children == null || props.children === "") return null;
  const tone = props.tone ?? "info";
  const base = statusLineStyle(tone);
  return (
    <div
      role="status"
      data-tone={tone}
      style={props.style ? { ...base, ...props.style } : base}
      {...attrProps(props.attr)}
    >
      {props.children}
    </div>
  );
}

/** The refusal line a panel shows under its header. */
export function Refusal(props: {
  text: string | null;
  attr?: string;
}): React.ReactElement | null {
  if (props.text === null) return null;
  return (
    <StatusLine tone="error" attr={props.attr ?? "data-panel-refusal"}>
      {props.text}
    </StatusLine>
  );
}

// ------------------------------------------------------------ the log tap

type Warn = (message: string, ...rest: unknown[]) => void;
interface WarnTap {
  listeners: Set<(message: string) => void>;
}
const taps = new WeakMap<object, WarnTap>();

/** Listen to `host.log.warn` without replacing the host object (commands
 *  key their caches on its identity). The tap forwards every call
 *  unchanged; null when the log cannot be tapped. */
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

/** Run `work` and resolve with the first warning it logged, or the message
 *  of what it threw (also logged under `source`), or null. Outside the
 *  hook: the React Compiler does not compile a `try … finally` (editor
 *  ADR 229). */
async function firstWarning(
  host: BundleHost,
  source: string,
  work: () => Promise<unknown>,
): Promise<string | null> {
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
    host.log.warn(`${source}: ${message}`);
    if (first === null) first = message;
  } finally {
    tap?.listeners.delete(listen);
  }
  return first;
}

/**
 * Run panel actions and keep the last refusal on screen. `run(work)`
 * clears the previous message, runs the work, and shows the first warning
 * it logged (or the error it threw) as a sentence until the next action.
 * `after` runs once the work settled (the panel's reload). `source` names
 * the panel in the log line a thrown error leaves.
 */
export function useActionFeedback(
  host: BundleHost,
  after: () => void,
  source = "panel",
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
  // eslint-disable-next-line no-restricted-syntax -- a hook's result: callers may compare it (ADR 229)
  const run = React.useCallback(
    async (work: () => Promise<unknown>) => {
      setRefusal(null);
      const first = await firstWarning(host, source, work);
      if (mounted.current && first !== null) setRefusal(refusalText(first));
      after();
    },
    [host, after, source],
  );
  return { refusal, run };
}
