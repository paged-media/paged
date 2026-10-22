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

// Scripting Stage 2 — embedded-Boa script editor. Multi-line
// textarea for JS source + run button + output log. Each `Run`
// dispatches `client.executeScript(source)` against the loaded
// document; the worker's embedded Boa engine evaluates the script
// and returns captured console.* lines + any thrown error.
//
// Same Operation channel as the gestures + Inspector + REPL —
// every `paged.set(...)` lands as a SetProperty mutation and the
// existing mutationApplied notification updates the rest of the UI.
//
// The Ask bar hands a request to Claude (ADR 221): the agent writes a
// script, runs it through this same door, reads the result back and
// corrects until it is done. Each script it runs shows in the editor and
// the log, so nothing it does is hidden, and every write undoes like a
// hand-run script.

import { useRef, useState } from "react";

import {
  AI_UNAVAILABLE_TEXT,
  describeAiError,
  plainSummary,
  PoweredByClaude,
  runEditorAgent,
  useAiAvailability,
  useCanvasClient,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.scriptEditor", {
  you: "You: {prompt}",
  declined: "Claude declined this request.",
  turnLimit: " (stopped at the turn limit)",
  truncated: " (the reply was cut off)",
  claude: "Claude: {summary}{stopped}",
  done: "Done.",
  dispatchFailed: "dispatch failed: {message}",
  askPlaceholder: "Ask Claude to write a script…",
  askLabel: "Ask Claude to write a script",
  stop: "Stop",
  ask: "Ask",
  engine: "JS — embedded Boa",
  running: "running…",
  run: "Run ▶",
  source: "Script source",
  empty: "Cmd-Enter to run. Output appears here.",
});

interface LogEntry {
  source: string;
  output: string[];
  error: string | null;
  /** A line from Claude (its summary, a refusal) rather than a run. */
  note?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PanelProps = any;

const EXAMPLE = `// Try editing the textFrame's opacity from JS.
// All scene-graph writes go through the Operation channel,
// so Cmd-Z undoes them.
paged.set("textFrame:ua365e1", "frameOpacity", 50);
console.log("set opacity to 50");
`;

export function ScriptEditorPanel(_: PanelProps) {
  const strings = useStrings();
  const client = useCanvasClient();
  const [source, setSource] = useState<string>(EXAMPLE);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // F-25 (PN-352): with no AI service, Ask says so before a request is typed.
  const offline = useAiAvailability() === "unavailable";

  const scrollLog = () => {
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({
        top: logRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  };

  const askClaude = async (requested?: string) => {
    const prompt = (requested ?? ask).trim();
    if (!prompt || asking || running || offline) return;
    const controller = new AbortController();
    setAsking(controller);
    const append = (entry: LogEntry) => {
      setLog((prev) => [...prev, entry]);
      scrollLog();
    };
    append({
      source: "",
      output: [],
      error: null,
      note: strings.t(M.you, { prompt }),
    });
    // A promise chain rather than try/finally: the React Compiler does
    // not compile a component with a `finally` in it (ADR 229).
    await runEditorAgent(client, {
      mode: "script",
      prompt,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "script") setSource(event.source);
        else if (event.type === "scriptResult")
          append({
            source: event.source,
            output: event.run.output,
            error: event.run.error,
          });
      },
    })
      .then((result) => {
        if (result.outcome === "refused")
          append({
            source: "",
            output: [],
            error: strings.t(M.declined),
          });
        else {
          const stopped =
            result.outcome === "turnLimit"
              ? strings.t(M.turnLimit)
              : result.outcome === "truncated"
                ? strings.t(M.truncated)
                : "";
          append({
            source: "",
            output: [],
            error: null,
            note: strings.t(M.claude, {
              summary: plainSummary(result.summary) || strings.t(M.done),
              stopped,
            }),
          });
        }
        setAsk("");
      })
      .catch((err: unknown) => {
        append({ source: "", output: [], error: describeAiError(err) });
      })
      .finally(() => setAsking(null));
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    await client
      .executeScript(source)
      .then((result) => {
        setLog((prev) => [
          ...prev,
          { source, output: result.output, error: result.error },
        ]);
        requestAnimationFrame(() => {
          logRef.current?.scrollTo({
            top: logRef.current.scrollHeight,
            behavior: "smooth",
          });
        });
      })
      .catch((err: unknown) => {
        setLog((prev) => [
          ...prev,
          {
            source,
            output: [],
            error: strings.t(M.dispatchFailed, {
              message: (err as Error).message,
            }),
          },
        ]);
      })
      .finally(() => setRunning(false));
  };

  return (
    <div className="flex flex-col h-full text-sm" data-script-editor="ready">
      <form
        className="flex items-center gap-1 p-1 border-b border-input"
        data-script-ask
        onSubmit={(e) => {
          e.preventDefault();
          void askClaude();
        }}
      >
        <input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={strings.t(M.askPlaceholder)}
          aria-label={strings.t(M.askLabel)}
          disabled={asking !== null}
          className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-background border border-input outline-none focus:ring-1 focus:ring-ring"
          data-script-ask-input
        />
        {asking ? (
          <button
            type="button"
            onClick={() => asking.abort()}
            className="px-2 py-0.5 rounded hover:bg-muted/60 text-xs"
            data-action="ask-stop"
          >
            {strings.t(M.stop)}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!ask.trim() || running || offline}
            title={offline ? AI_UNAVAILABLE_TEXT : undefined}
            className="px-2 py-0.5 rounded hover:bg-muted/60 disabled:opacity-50 text-xs"
            data-action="ask"
          >
            {strings.t(M.ask)}
          </button>
        )}
        <PoweredByClaude size={10} />
      </form>
      {offline ? (
        <div
          role="status"
          data-script-ai-unavailable
          className="px-2 py-1 text-xs text-muted-foreground border-b border-input"
        >
          {AI_UNAVAILABLE_TEXT}
        </div>
      ) : null}
      <div className="flex items-center justify-between p-1 border-b border-input">
        <span className="text-xs text-muted-foreground px-1">
          {strings.t(M.engine)}
        </span>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || asking !== null}
          className="px-2 py-0.5 rounded hover:bg-muted/60 disabled:opacity-50"
          data-action="run"
        >
          {running ? strings.t(M.running) : strings.t(M.run)}
        </button>
      </div>
      <textarea
        aria-label={strings.t(M.source)}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="font-mono text-xs p-2 flex-1 min-h-0 bg-background outline-none focus:ring-1 focus:ring-ring resize-none border-b border-input"
        spellCheck={false}
        data-script-source
        onKeyDown={(e) => {
          // Cmd-Enter (or Ctrl-Enter) runs the script — standard
          // creative-tool convention for script panes.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div
        ref={logRef}
        className="font-mono text-xs p-2 overflow-y-auto bg-muted/30 max-h-48"
        data-script-log
      >
        {log.length === 0 ? (
          <div className="text-muted-foreground">{strings.t(M.empty)}</div>
        ) : (
          log.map((entry, i) => (
            <div key={i} className="border-b border-input/30 mb-1 pb-1">
              {entry.note && (
                <div className="whitespace-pre-wrap font-sans" data-script-note>
                  {entry.note}
                </div>
              )}
              {entry.output.map((line, j) => (
                <div key={j}>{line}</div>
              ))}
              {entry.error && (
                <div className="text-status-error" data-script-error>
                  ✗ {entry.error}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
