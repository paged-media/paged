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

// The slide bundle's two typed commands, UNIT: the bundle on the in-process
// host over a recording fake editor (no engine; the slide wasm is real).
// newSlide: the one mutation it emits for a deck, where it puts the page,
// what it answers, and when it refuses (not a deck, an unknown slide, a
// refused insert) without touching the document. importPptx: what reaches
// the door that opens the document, the deck label it writes after, and the
// refusal on a host that cannot open one. The same commands on the real
// engine: test/headless/object-model.spec.ts.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import type {
  MainToWorkerKind,
  Mutation,
  PluginManifest,
  WorkerToMain,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "@paged-media/plugin-sdk";
import {
  covers,
  createFakeEditor,
  type FakeEditorOptions,
} from "@paged-media/test-kit";

import slideBundle from "../src/index";
import {
  IMPORT_PPTX_COMMAND,
  LABEL_KEY,
  NEW_SLIDE_COMMAND,
} from "../src/object-model";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const DECK_LABEL = {
  key: LABEL_KEY,
  value: JSON.stringify({
    v: 1,
    data: { deck: { name: "Pitch", width: 960, height: 540, fonts: [] } },
  }),
};

const page = (selfId: string, index: number) => ({
  selfId,
  index,
  sizePt: [720, 405],
  pluginMetadata: [],
});

/** The container-part doors, answered: writes land in `parts`. */
function withParts(
  fakeOptions: FakeEditorOptions,
  parts: Map<string, number[]>,
): FakeEditorOptions {
  return {
    ...fakeOptions,
    reply: (m) => {
      if (m.kind === "writePagedPart") {
        parts.set(m.payload.path, m.payload.bytes);
        return { kind: "pagedPartWritten", payload: {} };
      }
      if (m.kind === "readPagedPart") {
        const bytes = parts.get(m.payload.path);
        return {
          kind: "pagedPartRead",
          payload: { found: !!bytes, bytes: bytes ?? [] },
        };
      }
      return fakeOptions.reply?.(m);
    },
  };
}

function boot(
  fakeOptions: FakeEditorOptions,
  options: Partial<CreateBundleHostOptions> = {},
  parts = new Map<string, number[]>(),
) {
  const fake = createFakeEditor(withParts(fakeOptions, parts));
  const handle = createBundleHost(
    () => fake.editor,
    slideBundle.manifest as PluginManifest,
    { console: silent, ...options },
  );
  const bundle = slideBundle.activate(handle.host);
  return {
    fake,
    host: handle.host,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** A deck of two slides; an `insertPage` mints `p3`. */
function deck(refuseInsert = false) {
  return boot({
    documentMeta: { pluginMetadata: [DECK_LABEL] } as never,
    collections: { pages: [page("p1", 1), page("p2", 2)] },
    refuse: (m: Mutation) =>
      refuseInsert && m.op === "insertPage" ? "no master" : null,
    reply: (m: MainToWorkerKind) =>
      m.kind === "mutate" && m.payload.op === "insertPage" && !refuseInsert
        ? ({
            kind: "mutationApplied",
            payload: {
              clientSeq: 0,
              appliedSeq: 1,
              pageIds: ["p3"],
              cacheStats: {
                hits: 0,
                misses: 0,
                len: 0,
                capacity: 0,
                rebuildMs: 0,
              },
              createdPages: ["p3"],
            },
          } as unknown as WorkerToMain)
        : undefined,
  });
}

describe("media.paged.slide.newSlide (unit)", () => {
  it("appends one page after the last slide and answers its slide address", async () => {
    covers("command:media.paged.slide.newSlide");
    const b = deck();
    const out = (await b.host.objects.invoke(NEW_SLIDE_COMMAND, {})) as {
      slide: string;
    };
    expect(b.fake.mutations()).toEqual([
      { op: "insertPage", args: { afterPageId: "p2", masterId: null } },
    ]);
    // One engine mutation: one undo step.
    expect(out.slide).toBe("plugin:media.paged.slide/slide/p3");
    b.dispose();
  });

  it("puts the page after the slide it is given", async () => {
    covers("command:media.paged.slide.newSlide");
    const b = deck();
    await b.host.objects.invoke(NEW_SLIDE_COMMAND, {
      after: "plugin:media.paged.slide/slide/p1",
    });
    expect(b.fake.mutations()).toEqual([
      { op: "insertPage", args: { afterPageId: "p1", masterId: null } },
    ]);
    b.dispose();
  });

  it("refuses in a document that is not a deck, and changes nothing", async () => {
    covers("command:media.paged.slide.newSlide");
    const b = boot({ collections: { pages: [page("p1", 1)] } });
    await expect(b.host.objects.invoke(NEW_SLIDE_COMMAND, {})).rejects.toThrow(
      /failed: this document is not a slide deck/,
    );
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });

  it("refuses a slide that is not in the deck, and changes nothing", async () => {
    covers("command:media.paged.slide.newSlide");
    const b = deck();
    await expect(
      b.host.objects.invoke(NEW_SLIDE_COMMAND, {
        after: "plugin:media.paged.slide/slide/nope",
      }),
    ).rejects.toThrow(/unknownAddress: no slide/);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });

  it("reports a refused insert as a failure, with nothing on the undo stack", async () => {
    covers("command:media.paged.slide.newSlide");
    const b = deck(true);
    await expect(b.host.objects.invoke(NEW_SLIDE_COMMAND, {})).rejects.toThrow(
      /failed: insertPage was refused/,
    );
    expect(b.fake.undoDepth()).toBe(0);
    b.dispose();
  });
});

const PPTX = new Uint8Array(
  readFileSync(
    new URL(
      "../../../slide-conformance/fixtures/placeholders.pptx",
      import.meta.url,
    ),
  ),
);

describe("media.paged.slide.importPptx (unit)", () => {
  it("opens the deck's IDML package through the native-document door, then writes the deck label as one batch", async () => {
    covers("command:media.paged.slide.importPptx");
    const opened: Uint8Array[] = [];
    const parts = new Map<string, number[]>();
    const b = boot(
      {},
      {
        nativeDocument: {
          readModel: async () => null,
          readComposition: async () => null,
          listParts: async () => [],
          open: async (bytes) => void opened.push(bytes),
        },
      },
      parts,
    );
    const out = (await b.host.objects.invoke(IMPORT_PPTX_COMMAND, {
      bytes: PPTX,
      name: "Pitch deck.pptx",
    })) as { slides: string[]; fonts: string[]; diagnostics: string[] };
    expect(opened).toHaveLength(1);
    const head = new TextDecoder().decode(opened[0]!.subarray(0, 120));
    expect(head).toContain("application/vnd.adobe.indesign-idml-package");
    // A slide per deck slide, each an address of the slide kind.
    expect(out.slides.length).toBeGreaterThan(5);
    expect(
      out.slides.every((s) => s.startsWith("plugin:media.paged.slide/slide/")),
    ).toBe(true);
    // The deck label, named after the file, in ONE batch.
    const [batch] = b.fake.mutations();
    expect(b.fake.mutations()).toHaveLength(1);
    expect(batch!.op).toBe("batch");
    const ops = (batch as Extract<Mutation, { op: "batch" }>).args.ops;
    const label = ops.find((o) => o.op === "setDocumentMetadata") as Extract<
      Mutation,
      { op: "setDocumentMetadata" }
    >;
    expect(label.args.key).toBe(LABEL_KEY);
    expect(
      (JSON.parse(label.args.value!) as { data: { deck: { name: string } } })
        .data.deck.name,
    ).toBe("Pitch deck");
    // The source deck rides along as a container part (export reads it).
    const part = (suffix: string) =>
      [...parts.entries()].find(([k]) => k.endsWith(suffix))?.[1];
    expect(Uint8Array.from(part("/source/original.pptx") ?? [])).toEqual(PPTX);
    expect(part("/import/report.json")).toBeDefined();
    b.dispose();
  });

  it("asks the documents door, naming the deck, when there is no native one", async () => {
    covers("command:media.paged.slide.importPptx");
    const asked: Array<string | null> = [];
    const b = boot(
      {},
      {
        documents: {
          exportPaged: async () => new Uint8Array(),
          open: async (_bytes, request) => {
            asked.push(request.name);
            return { opened: false as const, reason: "declined" as const };
          },
        },
      },
    );
    await expect(
      b.host.objects.invoke(IMPORT_PPTX_COMMAND, {
        bytes: PPTX,
        name: "Pitch.pptx",
      }),
    ).rejects.toThrow(/declined to open Pitch/);
    expect(asked).toEqual(["Pitch"]);
    // A declined open writes no label into the document that stayed open.
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });

  it("refuses on a host that cannot open a document, and says so in diagnostics", async () => {
    covers("command:media.paged.slide.importPptx");
    const b = boot({});
    await expect(
      b.host.objects.invoke(IMPORT_PPTX_COMMAND, { bytes: PPTX, name: "x" }),
    ).rejects.toThrow(/failed: this host cannot open a document/);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });
});
