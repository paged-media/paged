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

// Doc ADR 630 — the Story Map panel: every story's thread drawn as its
// frames, page by page, with where it stops — "Overset" when the last frame
// cannot hold the text, "Not placed" when no frame shows it. A frame's chip
// goes to that frame (selected, its page brought into view — a jump the
// editor's Go back returns from, editor ADR 1211); an overset story's
// marker goes to its last frame; "Story view" opens the story as text.

import { useEffect, useState, type CSSProperties } from "react";

import { useStrings } from "@paged-media/strings";

import { STORY } from "../messages.js";
import type { MapFrame, MapStory } from "./story-map-model.js";

/** What the panel needs from the host (activate wires the doors). */
export interface StoryMapDoors {
  /** The map, read again after every document change. */
  read(): Promise<MapStory[]>;
  onDidChange(listener: () => void): () => void;
  /** Select the frame and bring its page into view (a recorded jump). */
  goToFrame(frame: MapFrame): void;
  /** Open the story in the Story view. */
  openStory(storyId: string): void;
  /** The page's label as the document numbers it ("3", "iv"). */
  pageLabel(pageIndex: number): string;
}

export function StoryMapPanel({ doors }: { doors: StoryMapDoors }) {
  const { t } = useStrings();
  const [map, setMap] = useState<MapStory[] | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => doors.onDidChange(() => setRevision((r) => r + 1)), [doors]);
  useEffect(() => {
    let live = true;
    void doors.read().then((m) => {
      if (live) setMap(m);
    });
    return () => {
      live = false;
    };
  }, [doors, revision]);

  if (!map) return <div style={pad}>{t(STORY.mapLoading)}</div>;
  if (map.length === 0)
    return (
      <div data-story-map="empty" style={pad}>
        {t(STORY.mapEmpty)}
      </div>
    );
  const overset = map.filter((s) => s.overset).length;
  const loose = map.filter((s) => s.disconnected).length;
  return (
    <div data-story-map="" style={pad}>
      <div data-story-map-summary role="status" style={summary}>
        {t(STORY.mapSummary, { count: map.length })}
        {overset > 0 ? (
          <span style={danger}>
            {" "}
            · {t(STORY.mapOverset, { count: overset })}
          </span>
        ) : null}
        {loose > 0 ? (
          <span style={warn}> · {t(STORY.mapLoose, { count: loose })}</span>
        ) : null}
      </div>
      <ol style={list}>
        {map.map((s) => (
          <li
            key={s.storyId}
            data-story-map-story={s.storyId}
            data-overset={s.overset ? "true" : undefined}
            data-disconnected={s.disconnected ? "true" : undefined}
            style={row}
          >
            <div style={head}>
              <span style={preview} title={s.preview}>
                {s.preview || t(STORY.emptyStory)}
              </span>
              <button
                type="button"
                data-story-map-open={s.storyId}
                onClick={() => doors.openStory(s.storyId)}
                style={link}
              >
                {t(STORY.openInStoryView)}
              </button>
            </div>
            <div role="list" aria-label={t(STORY.threadLabel)} style={thread}>
              {s.disconnected ? (
                <span data-story-map-loose style={{ ...badge, ...warnBadge }}>
                  {t(STORY.notPlaced)}
                </span>
              ) : (
                s.frames.map((f, i) => (
                  <span key={f.frameId} role="listitem" style={step}>
                    {i > 0 ? (
                      <span aria-hidden="true" style={arrow}>
                        →
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-story-map-frame={f.frameId}
                      title={t(STORY.goToFrame, {
                        n: i + 1,
                        page:
                          f.pageIndex === null
                            ? t(STORY.pasteboard)
                            : doors.pageLabel(f.pageIndex),
                      })}
                      onClick={() => doors.goToFrame(f)}
                      style={chip}
                    >
                      {f.pageIndex === null
                        ? t(STORY.pasteboardShort)
                        : t(STORY.pageShort, {
                            page: doors.pageLabel(f.pageIndex),
                          })}
                    </button>
                  </span>
                ))
              )}
              {s.overset ? (
                <span role="listitem" style={step}>
                  <span aria-hidden="true" style={arrow}>
                    →
                  </span>
                  <button
                    type="button"
                    data-story-map-overset={s.storyId}
                    title={t(STORY.goToOverset)}
                    onClick={() =>
                      doors.goToFrame(s.frames[s.frames.length - 1]!)
                    }
                    style={{ ...chip, ...dangerBadge }}
                  >
                    ⊕ {t(STORY.overset)}
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const pad: CSSProperties = { padding: 10, fontSize: 12 };
const summary: CSSProperties = {
  marginBottom: 8,
  color: "var(--pg-muted-fg, #5b5b57)",
};
const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const row: CSSProperties = {
  padding: "6px 0",
  borderBottom: "1px solid var(--chrome-border, #e2e2de)",
};
const head: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 4,
};
const preview: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const thread: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 2,
};
const step: CSSProperties = { display: "inline-flex", alignItems: "center" };
const arrow: CSSProperties = {
  padding: "0 2px",
  color: "var(--pg-muted-fg, #5b5b57)",
};
const chip: CSSProperties = {
  minHeight: 24,
  padding: "0 8px",
  borderRadius: 12,
  border: "1px solid var(--chrome-border, #c9c9c4)",
  background: "var(--pg-bg, #ffffff)",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};
const badge: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 12,
};
const dangerBadge: CSSProperties = {
  borderColor: "var(--pg-danger, #b42318)",
  color: "var(--pg-danger, #b42318)",
};
const warnBadge: CSSProperties = {
  border: "1px dashed var(--pg-warning, #b54708)",
  color: "var(--pg-warning, #b54708)",
};
const link: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--pg-primary, #2b6cb0)",
  font: "inherit",
  cursor: "pointer",
  minHeight: 24,
};
const danger: CSSProperties = { color: "var(--pg-danger, #b42318)" };
const warn: CSSProperties = { color: "var(--pg-warning, #b54708)" };
