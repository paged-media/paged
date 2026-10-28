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

// The deck's outputs as one service (slide ADR 720): PDF, outline,
// template and video, with the progress of the job that runs, so the
// Export view, the palette and the typed commands share one runner and one
// cancel. Also the custom shows and sections a script edits.

import type { BundleHost } from "@paged-media/plugin-api";

import { CustomShows } from "../custom-shows.js";
import type { ImportReport, SlideEngine } from "../engine.js";
import {
  addSectionMutation,
  moveSectionMutation,
  newSectionId,
  removeSectionMutation,
  renameSectionMutation,
  sectionsOf,
} from "../sections.js";
import { createFrameSource } from "../show/frames.js";
import { attachAnimations, showSlides } from "../show/contribute.js";
import { drawScene } from "../show/scene-source.js";
import { readSlides, type Slide, type SlidesStore } from "../slides-model.js";
import {
  chosenSlides,
  exportOutlineFile,
  exportPdf,
  paperFor,
  type Exported,
  type PdfRequest,
  type WrittenPdfExport,
} from "./documents.js";
import { renderVideo, type Video, type VideoOptions } from "./video/runner.js";

export interface OutputDeps {
  store(): SlidesStore | null;
  engine(): Promise<SlideEngine>;
  /** The deck written as a template (`.potx`), or null when it was not
   *  opened from a deck. */
  exportTemplate(): Promise<{
    bytes: Uint8Array;
    fileName: string;
    diagnostics: string[];
  } | null>;
  readReport(): Promise<ImportReport | null>;
  deckName(): Promise<string>;
  playCustomShow?(): ((name: string) => Promise<boolean>) | null;
}

/** The job that runs, as the Export view shows it. */
export interface Job {
  kind: "pdf" | "video" | "outline" | "template";
  done: number;
  total: number;
  /** Set when it ended. */
  result?: { fileName: string; bytes: number; note?: string };
  error?: string;
}

export interface VideoRequest {
  height?: number;
  fps?: number;
  secondsPerSlide?: number;
  useTimings?: boolean;
  codec?: "auto" | "avc" | "vp9";
  slides?: readonly number[];
}

export class Output {
  readonly shows: CustomShows;
  private job: Job | null = null;
  private abort: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host: BundleHost,
    private readonly deps: OutputDeps,
  ) {
    this.shows = new CustomShows(host);
  }

  current(): Job | null {
    return this.job;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(job: Job | null) {
    this.job = job ? { ...job } : null;
    for (const l of [...this.listeners]) l();
  }
  /** Stop the job that runs, between two frames or slides. */
  cancel(): void {
    this.abort?.abort();
  }

  /** The deck's slides, read from the document now (so a script's
   *  write is seen by its next command). */
  async slides(): Promise<readonly Slide[]> {
    let slides: Slide[] | null = null;
    try {
      slides = await readSlides(this.host);
    } catch {
      slides = null;
    }
    if (!slides || slides.length === 0)
      throw new Error("failed: the open document is not a slide deck");
    return slides;
  }

  defaultPaper(): "letter" | "a4" {
    const lang = (globalThis as { navigator?: { language?: string } }).navigator
      ?.language;
    return paperFor(lang);
  }

  private async run<T extends { fileName: string; bytes: Uint8Array }>(
    kind: Job["kind"],
    work: (
      progress: (done: number, total: number) => void,
      signal: AbortSignal,
    ) => Promise<T>,
    note?: (r: T) => string | undefined,
  ): Promise<T> {
    if (this.job && !this.job.result && !this.job.error)
      throw new Error("busy: another export is running");
    const ctl = new AbortController();
    this.abort = ctl;
    this.set({ kind, done: 0, total: 0 });
    try {
      const out = await work(
        (done, total) => this.set({ kind, done, total }),
        ctl.signal,
      );
      this.set({
        kind,
        done: this.job?.total ?? 0,
        total: this.job?.total ?? 0,
        result: {
          fileName: out.fileName,
          bytes: out.bytes.length,
          note: note?.(out),
        },
      });
      return out;
    } catch (e) {
      this.set({
        kind,
        done: 0,
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      this.abort = null;
    }
  }

  async pdf(req: Omit<PdfRequest, "title">): Promise<WrittenPdfExport> {
    const slides = await this.slides();
    const engine = await this.deps.engine();
    const title = await this.deps.deckName();
    return this.run(
      "pdf",
      (progress, signal) =>
        exportPdf(
          this.host,
          engine,
          slides,
          { paper: this.defaultPaper(), ...req, title },
          {
            onProgress: progress,
            signal,
          },
        ),
      (r) => (r.replaced > 0 ? `${r.replaced}` : undefined),
    );
  }

  async outline(format: "rtf" | "txt"): Promise<Exported> {
    const slides = await this.slides();
    const engine = await this.deps.engine();
    const title = await this.deps.deckName();
    return this.run("outline", () =>
      exportOutlineFile(this.host, engine, slides, format, title),
    );
  }

  async template(): Promise<{
    bytes: Uint8Array;
    fileName: string;
    diagnostics: string[];
  }> {
    return this.run("template", async () => {
      const out = await this.deps.exportTemplate();
      if (!out)
        throw new Error(
          "failed: this document was not opened from a PowerPoint deck, so it cannot be saved as a template",
        );
      return out;
    });
  }

  async video(req: VideoRequest = {}): Promise<Video & { fileName: string }> {
    const slides = await this.slides();
    const height = req.height ?? 1080;
    const fps = req.fps ?? 30;
    if (![720, 1080, 2160].includes(height))
      throw new Error(
        `invalid: a video is 720, 1080 or 2160 pixels high, not ${height}`,
      );
    if (![24, 30, 60].includes(fps))
      throw new Error(
        `invalid: a video runs at 24, 30 or 60 frames a second, not ${fps}`,
      );
    const seconds = req.secondsPerSlide ?? 5;
    if (!(seconds > 0 && seconds <= 3600))
      throw new Error(
        "invalid: the seconds per slide must be above 0 and at most 3600",
      );
    const chosen = chosenSlides(slides, {
      includeHidden: true,
      slides: req.slides,
    });
    const show = showSlides(chosen, await this.deps.readReport());
    // Their animations play in the video (slide ADR 714).
    const engine = await this.deps.engine();
    try {
      await attachAnimations(
        this.host,
        engine,
        show,
        new Map(chosen.map((s) => [s.pageId, s.state.timing])),
      );
    } catch {
      // Without them the slides are drawn whole.
    }
    const title = await this.deps.deckName();
    const opts: VideoOptions = {
      height: height as VideoOptions["height"],
      fps: fps as VideoOptions["fps"],
      defaultSeconds: seconds,
      useTimings: req.useTimings ?? true,
      codec: req.codec ?? "auto",
    };
    return this.run("video", async (progress, signal) => {
      const frames = createFrameSource(this.host);
      try {
        const v = await renderVideo(show, frames, opts, {
          signal,
          onProgress: (p) => progress(p.done, p.total),
          animation: async (slide, scale) => {
            if (!slide.anim) return null;
            const scene = await drawScene(
              this.host,
              slide.anim.plan,
              scale,
              slide.sizePt,
            );
            if (!scene) return null;
            const player = engine.animPlayer({
              timing: slide.anim.timing,
              slide: { w: slide.sizePt[0], h: slide.sizePt[1] },
              boxes: scene.boxes,
            });
            return { scene, player };
          },
        });
        return { ...v, fileName: `${title || "presentation"}.mp4` };
      } finally {
        frames.dispose();
      }
    });
  }

  /** Hand a written file to the host's saver. */
  async save(file: {
    bytes: Uint8Array;
    fileName: string;
    mimeType?: string;
  }): Promise<boolean> {
    if (!this.host.supports("shell.saveFile@1")) return false;
    return this.host.shell.saveFile({
      suggestedName: file.fileName,
      bytes: file.bytes,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    });
  }

  // ---- custom shows and sections, by slide number (scripts)

  private pageOf(slides: readonly Slide[], n: number): string {
    const s = slides[n - 1];
    if (!s) throw new Error(`unknownAddress: the deck has no slide ${n}`);
    return s.pageId;
  }

  async customShows(): Promise<
    { id: number; name: string; slides: number[] }[]
  > {
    const slides = await this.slides();
    const num = new Map(slides.map((s) => [s.pageId, s.number]));
    return (await this.shows.list()).map((c) => ({
      id: c.id,
      name: c.name,
      slides: c.pages.flatMap((p) => (num.has(p) ? [num.get(p)!] : [])),
    }));
  }

  async setCustomShow(
    name: string,
    numbers: readonly number[],
  ): Promise<number> {
    if (name.trim() === "")
      throw new Error("invalid: a custom show needs a name");
    const slides = await this.slides();
    const pages = numbers.map((n) => this.pageOf(slides, n));
    const out = await this.shows.set(name, pages);
    if (!out) throw new Error("failed: the deck refused the custom show");
    return out.id;
  }

  async deleteCustomShow(name: string): Promise<void> {
    if (!(await this.shows.remove(name)))
      throw new Error(`unknownAddress: the deck has no custom show "${name}"`);
  }

  async playCustomShow(name: string): Promise<boolean> {
    const play = this.deps.playCustomShow?.();
    if (!play) throw new Error("unavailable: this host cannot present");
    return play(name);
  }

  async sections(): Promise<{ id: string; name: string; slides: number[] }[]> {
    const slides = await this.slides();
    return sectionsOf(slides).map((s) => ({
      id: s.id,
      name: s.name,
      slides: s.pageIds.map((p) => slides.find((x) => x.pageId === p)!.number),
    }));
  }

  private async apply(
    m: Parameters<BundleHost["document"]["mutate"]>[0] | null,
    what: string,
  ) {
    if (!m) throw new Error(`failed: ${what}`);
    const out = await this.host.document.mutate(m);
    if (!out.applied) throw new Error(`failed: ${what} was refused`);
  }

  private async sectionNamed(name: string) {
    const s = sectionsOf(await this.slides()).find((x) => x.name === name);
    if (!s)
      throw new Error(`unknownAddress: the deck has no section "${name}"`);
    return s;
  }

  async addSection(name: string, slide?: number): Promise<string> {
    const slides = await this.slides();
    const store = this.deps.store();
    const pageId =
      slide !== undefined
        ? this.pageOf(slides, slide)
        : (store?.activePage() ?? slides[0]!.pageId);
    const id =
      slides.find((s) => s.pageId === pageId)?.state.section?.id ??
      newSectionId();
    await this.apply(
      addSectionMutation(slides, pageId, name, id),
      "the section could not be added",
    );
    return id;
  }

  async renameSection(name: string, to: string): Promise<void> {
    const s = await this.sectionNamed(name);
    if (s.name === to) return;
    await this.apply(
      renameSectionMutation(await this.slides(), s.id, to),
      "the rename",
    );
  }

  async moveSection(name: string, by: "up" | "down"): Promise<void> {
    const s = await this.sectionNamed(name);
    await this.apply(
      moveSectionMutation(await this.slides(), s.id, by === "up" ? -1 : 1),
      `the section cannot move ${by}`,
    );
  }

  async deleteSection(name: string, withSlides = false): Promise<void> {
    const s = await this.sectionNamed(name);
    await this.apply(
      removeSectionMutation(await this.slides(), s.id, withSlides),
      withSlides
        ? "a deck keeps at least one slide"
        : "the section could not be removed",
    );
  }
}
