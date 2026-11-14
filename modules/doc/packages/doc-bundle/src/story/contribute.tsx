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

// Doc ADR 630 — the Story view (a module view) and the Story Map (a panel),
// wired to the host's doors: the engine's story is read with
// `storyContent`, written with `mutate` (one undo step per run of typing in
// one paragraph, through `amend`), stories and threads with the stories
// collection and `frameChain`, and navigation with `selection.set` and
// `viewport.goToPage` / `revealText` — jumps the editor records, so Go back
// returns from them (editor ADR 1211).

import type { BundleHost, ElementId, Mutation } from "@paged-media/plugin-api";
import { t } from "@paged-media/strings";

import { STORY } from "../messages.js";
import {
  nextOverset,
  previewText,
  storyMap,
  type MapFrame,
  type MapStory,
  type StoryFacts,
} from "./story-map-model.js";
import { StoryMapPanel, type StoryMapDoors } from "./story-map-panel.js";
import { StoryView, createStoryFocus, type StoryDoors } from "./story-view.js";

export const STORY_VIEW_ID = "media.paged.doc.view.story";
export const STORY_MAP_PANEL_ID = "media.paged.doc.panel.storyMap";
const C = "media.paged.doc.command";
export const STORY_VIEW_COMMAND = `${C}.storyView`;
export const STORY_MAP_COMMAND = `${C}.storyMap`;
export const NEXT_OVERSET_COMMAND = `${C}.nextOverset`;

/** Preview at most this many stories' first words (each is a content read). */
const PREVIEW_CAP = 60;

type ReadStory = {
  paragraphs: Array<{
    paragraphStyle?: string;
    runs: Array<{ text: string }>;
  }>;
};

export function contributeStory(host: BundleHost): () => void {
  const disposers: Array<() => void> = [];
  const focus = createStoryFocus();
  const canRead = host.supports("document.readStory@1");

  const readStory = async (storyId: string): Promise<ReadStory | null> => {
    if (!canRead) return null;
    try {
      return (await host.document.storyContent(storyId)) as ReadStory | null;
    } catch {
      return null;
    }
  };
  const summaries = async (): Promise<StoryFacts[]> => {
    try {
      return [...(await host.document.collection<StoryFacts>("stories"))];
    } catch {
      return [];
    }
  };

  // One run of typing in one paragraph is one undo step: its first write
  // makes a step, the next ones amend it while it is still the last.
  const runs = new WeakMap<object, number>();
  const canAmend = host.supports("document.mutate.amend@1");
  const write = async (m: Mutation, run: object): Promise<boolean> => {
    const label = t(STORY.viewTitle);
    const seq = runs.get(run);
    if (seq !== undefined && canAmend) {
      const amended = await host.document.mutate(m, { amend: seq, label });
      if (amended.applied) {
        if (amended.appliedSeq !== undefined) runs.set(run, amended.appliedSeq);
        return true;
      }
    }
    const out = await host.document.mutate(m, { label });
    if (out.applied && out.appliedSeq !== undefined)
      runs.set(run, out.appliedSeq);
    return out.applied;
  };

  const onDidChange = (listener: () => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = host.document.onDidChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        listener();
      }, 50);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      sub.dispose();
    };
  };

  const viewport = host.viewport as typeof host.viewport & {
    revealText?(
      r: { storyId: string; start: number; end: number },
      o?: { select?: boolean },
    ): Promise<boolean>;
  };

  const storyDoors: StoryDoors = {
    stories: async () => {
      const list = await summaries();
      const out: Array<{ storyId: string; preview: string }> = [];
      for (const [i, s] of list.entries()) {
        const content = i < PREVIEW_CAP ? await readStory(s.selfId) : null;
        out.push({
          storyId: s.selfId,
          preview: content ? previewText(content.paragraphs, 48) : s.selfId,
        });
      }
      return out;
    },
    read: async (storyId) => {
      const content = await readStory(storyId);
      if (!content) return null;
      const facts = (await summaries()).find((s) => s.selfId === storyId);
      return {
        content,
        oversetParagraph: facts?.overset
          ? (facts.oversetAt?.paragraph ?? null)
          : null,
      };
    },
    write,
    onDidChange,
    showInLayout: (storyId, start, end) => {
      host.shell.showView(null);
      void viewport.revealText?.({ storyId, start, end: Math.max(start, end) });
    },
    undo: () => void host.document.undo(),
    redo: () => void host.document.redo(),
  };

  const readMap = async (): Promise<MapStory[]> => {
    const list = await summaries();
    const chains = new Map<string, string[]>();
    const frames: string[] = [];
    for (const s of list) {
      let chain: string[] = [];
      try {
        chain = (await host.document.frameChain(s.selfId)).map(
          (l) => l.frameId,
        );
      } catch {
        chain = [];
      }
      chains.set(s.selfId, chain);
      frames.push(...chain);
    }
    let pageOrder: string[] = [];
    try {
      pageOrder = (
        await host.document.collection<{ selfId: string }>("pages")
      ).map((p) => p.selfId);
    } catch {
      pageOrder = [];
    }
    const framePages = new Map<string, { pageId: string; pageIndex: number }>();
    if (frames.length > 0) {
      try {
        const geom = await host.document.elementGeometry(
          frames.map((id) => ({ kind: "textFrame", id }) as ElementId),
        );
        geom.forEach((g, i) => {
          const pageId = g.pageId ? String(g.pageId) : null;
          const at = pageId ? pageOrder.indexOf(pageId) : -1;
          if (pageId && at >= 0)
            framePages.set(frames[i]!, { pageId, pageIndex: at });
        });
      } catch {
        // No geometry: the chips read "Pasteboard".
      }
    }
    const previews = new Map<string, string>();
    for (const [i, s] of list.entries()) {
      if (i >= PREVIEW_CAP) break;
      const content = await readStory(s.selfId);
      if (content) previews.set(s.selfId, previewText(content.paragraphs));
    }
    return storyMap(list, chains, framePages, previews);
  };

  const goToFrame = (frame: MapFrame) => {
    void host.selection.set([
      { kind: "textFrame", id: frame.frameId } as ElementId,
    ]);
    if (frame.pageId && host.supports("viewport.pages@1"))
      void host.viewport.goToPage(frame.pageId as never);
  };

  const openStory = (storyId: string) => {
    focus.set(storyId);
    host.shell.showView(STORY_VIEW_ID);
  };

  const mapDoors: StoryMapDoors = {
    read: readMap,
    onDidChange,
    goToFrame,
    openStory,
    pageLabel: (index) => String(index + 1),
  };

  // The Story view: a module view where the host has them.
  const views = host.supports("shell.views@1");
  if (views) {
    const StoryViewSurface = (props: { id: string; close(): void }) => (
      <StoryView doors={storyDoors} focus={focus} close={props.close} />
    );
    disposers.push(
      host.contribute.view({
        id: STORY_VIEW_ID,
        title: t(STORY.viewTitle),
        render: StoryViewSurface,
      }).dispose,
    );
  }

  const StoryMap = () => <StoryMapPanel doors={mapDoors} />;
  disposers.push(
    host.contribute.panel({
      id: STORY_MAP_PANEL_ID,
      title: t(STORY.mapTitle),
      component: StoryMap,
      defaultDock: "right",
      icon: "panel-stories",
    }).dispose,
  );

  // Story view ⇄ Layout view: the same command toggles, on the story of
  // the text caret, else the one shown last, else the first.
  disposers.push(
    host.contribute.command({
      id: STORY_VIEW_COMMAND,
      title: t(STORY.viewCommand),
      handler: () => {
        if (!views) return false;
        if (host.shell.activeView() === STORY_VIEW_ID) {
          host.shell.showView(null);
          return true;
        }
        const caret = host.supports("text.caret@1") ? host.text.caret() : null;
        if (caret) focus.set(caret.storyId);
        return host.shell.showView(STORY_VIEW_ID);
      },
    }).dispose,
    host.contribute.command({
      id: STORY_MAP_COMMAND,
      title: t(STORY.mapCommand),
      handler: () => host.shell.openPanel(STORY_MAP_PANEL_ID),
    }).dispose,
    // Overset navigation: the next overset story's last frame, round the
    // document; the map shows the same stories first.
    host.contribute.command({
      id: NEXT_OVERSET_COMMAND,
      title: t(STORY.nextOverset),
      handler: async () => {
        const map = await readMap();
        const next = nextOverset(map, focus.get());
        if (!next) return false;
        focus.set(next.storyId);
        goToFrame(next.frames[next.frames.length - 1]!);
        return true;
      },
    }).dispose,
  );
  for (const [path, command, order] of [
    // English paths: the host translates them (`menu.*`, messages.ts).
    ["View/Story view", STORY_VIEW_COMMAND, 10],
    ["View/Story map", STORY_MAP_COMMAND, 20],
    ["View/Go to next overset story", NEXT_OVERSET_COMMAND, 30],
  ] as const) {
    disposers.push(
      host.contribute.menu({ path, command, group: "story", order }).dispose,
    );
  }
  return () => {
    for (const d of disposers.splice(0).reverse()) d();
  };
}
