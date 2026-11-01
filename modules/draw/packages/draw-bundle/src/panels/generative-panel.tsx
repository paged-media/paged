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

// The GENERATIVE panel (WP8.3, draw ADR 369): the prompt field the two
// generative commands need (the contract has no modal dialog door; the
// menu rows "Text to vector…" and "Generative recolor…" raise this panel).
//   · TEXT TO VECTOR — what to draw, and by which route: the Claude agent
//     writes an SVG that the engine imports, or a generated picture is
//     traced;
//   · GENERATIVE RECOLOR — how to recolour the selection; the agent answers
//     with a colour map that Recolor Artwork applies.
// Each button runs the command with the prompt, so the panel adds no logic
// of its own, and a refusal (no agent, no model) is shown as the host said
// it. One undo step per click (two for the picture route: place, trace).

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { About, Refusal, useActionFeedback } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";
import * as React from "react";

import {
  applyGenerativeRecolor,
  applyTextToVector,
  type GenerativeRoute,
} from "../commands/generative";
import { PanelIntro } from "./panel-parts";

const M = defineMessages("draw.generativePanel", {
  title: "Generative",
  summary:
    "Draw from a prompt: the Claude agent writes vector artwork, or recolours the selection. Nothing is drawn until you press the button.",
  textToVector: "Text to vector",
  subject: "What to draw",
  subjectHint: "A lighthouse on a cliff at dusk",
  route: "Route",
  routeAuto: "Automatic",
  routeAgent: "Claude writes an SVG",
  routeImage: "Generate a picture and trace it",
  draw: "Draw",
  recolor: "Generative recolor",
  wish: "How to recolour the selection",
  wishHint: "Warm autumn colours, keep the outlines dark",
  apply: "Recolor",
  working: "Working…",
  note: "Route one sends your prompt, and the list of the selection's colours for a recolour, to Claude through the editor's proxy. The picture route runs the local image model and never leaves this machine. Both are one undo step, except tracing a picture, which is two.",
});

export const GENERATIVE_PANEL_NOTE = M.note;

export function makeGenerativePanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [subject, setSubject] = React.useState("");
    const [wish, setWish] = React.useState("");
    const [route, setRoute] = React.useState<GenerativeRoute>("auto");
    const [busy, setBusy] = React.useState<"draw" | "recolor" | null>(null);
    const { refusal, run } = useActionFeedback(
      host,
      () => undefined,
      "draw generative",
    );
    const go = (which: "draw" | "recolor", work: () => Promise<unknown>) => {
      setBusy(which);
      void run(work).finally(() => setBusy(null));
    };
    return (
      <div style={{ padding: 12 }} data-draw-generative-panel={busy ?? "idle"}>
        <PanelIntro
          summary={s.t(M.summary)}
          attr="data-draw-generative-intro"
        />
        <label style={{ display: "block", margin: "6px 0" }}>
          <div>{s.t(M.subject)}</div>
          <textarea
            style={{ width: "100%" }}
            rows={3}
            data-draw-generative-subject
            value={subject}
            placeholder={s.t(M.subjectHint)}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label style={{ display: "block", margin: "6px 0" }}>
          <div>{s.t(M.route)}</div>
          <select
            data-draw-generative-route
            value={route}
            onChange={(e) => setRoute(e.target.value as GenerativeRoute)}
          >
            <option value="auto">{s.t(M.routeAuto)}</option>
            <option value="agent">{s.t(M.routeAgent)}</option>
            <option value="image">{s.t(M.routeImage)}</option>
          </select>
        </label>
        <button
          type="button"
          data-draw-generative-draw
          disabled={busy !== null || subject.trim() === ""}
          onClick={() =>
            go("draw", () =>
              applyTextToVector(host, { prompt: subject, route }),
            )
          }
        >
          {s.t(busy === "draw" ? M.working : M.draw)}
        </button>
        <hr style={{ margin: "12px 0" }} />
        <label style={{ display: "block", margin: "6px 0" }}>
          <div>{s.t(M.wish)}</div>
          <textarea
            style={{ width: "100%" }}
            rows={3}
            data-draw-generative-wish
            value={wish}
            placeholder={s.t(M.wishHint)}
            onChange={(e) => setWish(e.target.value)}
          />
        </label>
        <button
          type="button"
          data-draw-generative-recolor
          disabled={busy !== null || wish.trim() === ""}
          onClick={() =>
            go("recolor", () => applyGenerativeRecolor(host, { prompt: wish }))
          }
        >
          {s.t(busy === "recolor" ? M.working : M.apply)}
        </button>
        <Refusal text={refusal} />
        <About attr="data-draw-generative-note">
          {s.t(GENERATIVE_PANEL_NOTE)}
        </About>
      </div>
    );
  };
  return { title: t(M.title), component: Component, defaultDock: "right" };
}
