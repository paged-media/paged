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

// THE LINK INDEX — one shared read of "which leaf carries which plugin
// metadata", per host, per document revision.
//
// WHY IT EXISTS. Ten features tag their elements with this plugin's
// metadata envelope (blend, repeat, pattern, symbols, objects-on-path,
// live paint, graphic styles, opacity mask, text on a path, the appearance
// bake). Each used to find its own elements with its own copy of the same
// loop — `document.tree()`, then one awaited `getMetadata` per leaf OF THE
// WHOLE DOCUMENT — and ran it again for every command, every panel reload
// and, in three panels, every RECORD. Measured on a 1 403-leaf document:
// 1 403 reads to select one record's two objects, 2 812 to update one
// blend, 6 720 for a 20-change burst in an open panel
// (`test/perf/perf-budgets-commands.spec.ts`, `test/panels/*.spec.tsx`).
//
// WHAT IT IS. The raw envelope per leaf id, read ONCE per document
// revision and shared by every caller on the same host. It parses
// nothing: `blendKeyOf`, `repeatSourceOf`, … stay where they are and
// read the envelopes this hands them, so each feature keeps its own
// vocabulary and its own tolerance for foreign shapes.
//
// THE PER-LEAF READS WERE THE ENGINE GAP, NOT THE DESIGN — and C-65
// closes it: an engine whose scene tree carries each row's
// `pluginMetadata` answers every leaf in the ONE tree read the walk makes
// anyway (`seedFromTree`). On an older engine a cold index still costs
// one round trip per leaf — in parallel windows, instead of one awaited
// after the other. `readEnvelopes` below is the ONE place that loop
// lives; when a bulk door ships it replaces that function's body and
// nothing else in this repo changes. (The facade's `getMetadata` is a
// `requestElementProperties` filtered to this plugin's key, so the same
// door could answer Select Same's property reads too.)
//
// INVALIDATION, and why it is an event and not a guess:
//   · every `mutationApplied` / `undoApplied` / `redoApplied` the host
//     reports (`document.onDidChange`) starts a new revision. The event
//     is delivered inside the reply that resolves `mutate`, so a command
//     that writes and then reads links in the same flow sees its own
//     write — the conformance specs' make → update → release chains are
//     what hold this to account;
//   · two engine messages the facade does not forward also start one,
//     read off the raw client because nothing else reports them:
//     `documentLoaded` (a host that outlives its document would
//     otherwise serve the previous document's links) and
//     `gestureCommitted` (a committed drag has an undo step of its own
//     and no `mutationApplied`);
//   · `invalidate()` is there for a caller that knows better, and
//     `forgetAllLinks()` for whoever swaps a document without the engine
//     saying so — the headless test harness does (see that function).
// A revision's caches are dropped as a set, so nothing from one revision
// is ever combined with another's.
//
// WHAT IT DOES NOT SEE. An element nested by `pasteInto` is INVISIBLE to
// `document.tree()` (CLAUDE.md, "B-18 NESTING IS REAL") and so is not in
// a snapshot — while still answering `getMetadata` BY ID. `envelopeOf`
// therefore falls through to a direct read for any id the walk did not
// reach, which is exactly what `repeatLinks` did for its clipped
// instances before this module existed.
//
// RECIPE WRITES. A `.paged` container-part write emits no document event,
// so a command that saved its recipe AFTER its last mutation left every
// open panel one write behind. `announceRecipeChange` is the missing
// event: each `write*Library` calls it, and `onDidChange` listeners hear
// it beside the document events.

import type {
  BundleHost,
  Disposable,
  ElementId,
  PluginMetadataEnvelope,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import manifest from "../manifest.json";

/** This plugin's Label key — the one the facade's `getMetadata` reads. */
const OWN_KEY = `x-paged:${manifest.id}`;

/** RFI C-65 — the envelope a TREE ROW carries for this plugin, read
 *  exactly as `getMetadata` reads it (the JSON value of this plugin's
 *  key; unparsable → none). `undefined` when the row has no
 *  `pluginMetadata` field at all: an engine older than the field, whose
 *  leaves still need a read each. An engine that has it lists the field
 *  on EVERY item row, empty when there is nothing, so its absence is
 *  never "no metadata". */
export function treeEnvelopeOf(node: SceneTreeNode): PluginMetadataEnvelope | null | undefined {
  const entries = (node as { pluginMetadata?: unknown }).pluginMetadata;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries as { key?: unknown; value?: unknown }[]) {
    if (entry?.key !== OWN_KEY || typeof entry.value !== "string") continue;
    try {
      return JSON.parse(entry.value) as PluginMetadataEnvelope;
    } catch {
      return null;
    }
  }
  return null;
}

/** One element's property table, as `document.elementProperties` answers
 *  it (the contract exports the door, not the row type). */
export type ElementProperties = Awaited<
  ReturnType<BundleHost["document"]["elementProperties"]>
>;

/** One leaf and the raw envelope it carries (`null` = no metadata of
 *  this plugin's). The envelope is FROZEN: it is shared by every caller
 *  of the revision, and every `with*Key` helper here copies before it
 *  writes, so a mutation would be a bug in the caller. */
export interface LinkEntry {
  readonly id: ElementId;
  readonly envelope: PluginMetadataEnvelope | null;
}

/** The document's links as of one revision. */
export interface LinkSnapshot {
  /** The scene tree the walk was built from. */
  readonly roots: SceneTreeNode[];
  /** Every leaf, in tree order (which is paint order). */
  readonly leaves: readonly LinkEntry[];
  /** The leaves that carry an envelope at all, in tree order — what a
   *  feature iterates. A document of 1 403 leaves with 901 linked ones
   *  parses 901 envelopes, not 1 403 nulls. */
  readonly linked: readonly LinkEntry[];
}

export interface LinkIndex {
  /** The scene tree of the current revision — one read per revision. */
  tree(): Promise<SceneTreeNode[]>;
  /** Every leaf's envelope — one walk per revision, shared by every
   *  caller, including the ones that ask while it is in flight. */
  snapshot(): Promise<LinkSnapshot>;
  /** One element's envelope: out of the revision's cache when it is
   *  there, otherwise ONE direct read (cached for the revision). Never
   *  starts a walk — so a caller that needs one element pays for one —
   *  and reaches the elements a walk cannot (see the module header). */
  envelopeOf(id: ElementId): Promise<PluginMetadataEnvelope | null>;
  /** One element's property table, read once per revision. */
  propertiesOf(id: ElementId): Promise<ElementProperties>;
  /** A read keyed by document revision: `read` runs once per revision
   *  per `key`, and a rejection is not remembered. */
  cached<T>(key: string, read: () => Promise<T>): Promise<T>;
  /** What `cached(key, …)` already holds at this revision, if anything —
   *  for a caller whose cheapest path depends on whether the expensive
   *  read has been paid for. Never reads. */
  peek<T>(key: string): Promise<T> | undefined;
  /** Start a new revision by hand. */
  invalidate(): void;
  /** The document changed, or a recipe part was written. Fired AFTER the
   *  revision moved, so a listener that reads gets the new state. */
  onDidChange(listener: () => void): Disposable;
}

/** Leaves read per parallel window. A walk is one request per leaf (see
 *  the module header), and the engine worker answers its inbox in order:
 *  posting every read of a large document at once would put the whole
 *  walk ahead of whatever the user does next. A window bounds that to
 *  this many reads without giving up the parallelism. */
const LEAF_READ_WINDOW = 64;

/** The binding a recipe write bumps. A HOST-level value on purpose: the
 *  part store belongs to the document, not to one `BundleHost` view of
 *  it, and `host.bindings` is the contract's own reactive channel — so
 *  the announcement reaches every view of the same host, exactly like a
 *  document event does. */
export const BIND_RECIPE_REVISION = "media.paged.draw.recipeRevision";

/** Flatten the scene tree to its selectable LEAF element ids (frames +
 *  paths — NOT groups/spreads/pages; we match on per-frame paint). A
 *  node with children is a container; a node with an id and no children
 *  is a leaf. Groups (id + children) are descended into, not matched. */
export function leafIdsOf(roots: readonly SceneTreeNode[]): ElementId[] {
  const out: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length > 0) {
        walk(children);
      } else if (node.id) {
        out.push(node.id);
      }
    }
  };
  walk(roots);
  return out;
}

/** The group node whose DIRECT children include `member`, or null. Pure
 *  over a tree — the lookup every "which group holds this record" read
 *  shares. */
export function groupHolding(
  roots: readonly SceneTreeNode[],
  member: ElementId,
): ElementId | null {
  for (const node of roots) {
    const children = node.children ?? [];
    if (
      node.id?.kind === "group" &&
      children.some((c) => c.id && c.id.id === member.id)
    ) {
      return node.id;
    }
    if (children.length > 0) {
      const found = groupHolding(children, member);
      if (found) return found;
    }
  }
  return null;
}

const keyOf = (id: ElementId): string => `${id.kind}:${String(id.id)}`;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) deepFreeze(inner);
  }
  return value;
};

/** What one read answered: the envelope, `null` for "this element carries
 *  none", or `undefined` when the read itself failed. */
type Read = PluginMetadataEnvelope | null | undefined;

/**
 * THE ENGINE GAP, IN ONE PLACE: the envelopes of `ids`, in order.
 *
 * One `getMetadata` round trip per id, `LEAF_READ_WINDOW` at a time,
 * because no bulk metadata read exists on the wire (RFI C-65). A bulk
 * door replaces THIS BODY — one request, one reply — and every caller
 * above keeps working.
 */
async function readEnvelopes(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<Read[]> {
  const out: Read[] = new Array<Read>(ids.length).fill(undefined);
  for (let at = 0; at < ids.length; at += LEAF_READ_WINDOW) {
    await Promise.all(
      ids.slice(at, at + LEAF_READ_WINDOW).map(async (id, i) => {
        try {
          out[at + i] = deepFreeze(await host.document.getMetadata(id));
        } catch {
          /* stays undefined: unreadable, and not remembered as empty */
        }
      }),
    );
  }
  return out;
}

/** Everything read at ONE document revision. Dropped as a set. */
interface Revision {
  tree: Promise<SceneTreeNode[]> | null;
  envelopes: Map<string, Promise<PluginMetadataEnvelope | null>>;
  snapshot: Promise<LinkSnapshot> | null;
  memo: Map<string, Promise<unknown>>;
}

const freshRevision = (): Revision => ({
  tree: null,
  envelopes: new Map(),
  snapshot: null,
  memo: new Map(),
});

const indexes = new WeakMap<object, LinkIndex>();

/** Bumped by {@link forgetAllLinks}; every index compares it on each
 *  read and starts a new revision when it has moved. */
let epoch = 0;

/**
 * Every index, on every host, forgets what it read.
 *
 * For whoever replaces a document WITHOUT the engine saying so. The
 * editor's client broadcasts `documentLoaded` and the index hears it; the
 * plugin-sdk HEADLESS harness's `load()` calls the worker directly and
 * broadcasts nothing (the SDK's own `parentOf` index has the same blind
 * spot), so the conformance harness calls this from its `load`
 * (`test/conformance/host.ts`). There is no door to ASK whether the
 * document is still the same one — no revision on `document.meta()`, and
 * a reloaded fixture has the same ids — so it has to be told.
 */
export function forgetAllLinks(): void {
  epoch += 1;
}

/** The engine messages that change the document without reaching
 *  `document.onDidChange` (see the module header). */
const SILENT_CHANGES = new Set<string>(["gestureCommitted"]);

function createLinkIndex(host: BundleHost): LinkIndex {
  let current = freshRevision();
  /** The walk in flight, of whichever revision — settles when it ends. */
  let walking: Promise<void> | null = null;
  /** The ONE walk waiting behind it. */
  let queued: Promise<LinkSnapshot> | null = null;
  /** Does the host report document changes to this index? When it does
   *  not (a host with no change event), nothing may be remembered. */
  let subscribed = false;
  /** The epoch `current` was read in (see `forgetAllLinks`). */
  let seen = epoch;
  const listeners = new Set<() => void>();

  const invalidate = (): void => {
    current = freshRevision();
  };
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  /** The revision a read belongs to. */
  const revision = (): Revision => {
    if (!subscribed || seen !== epoch) {
      seen = epoch;
      invalidate();
    }
    return current;
  };

  const treeOf = (rev: Revision): Promise<SceneTreeNode[]> => {
    if (rev.tree) return rev.tree;
    const read: Promise<SceneTreeNode[]> = host.document.tree().catch(() => {
      // A tree that could not be read is not a tree with no leaves:
      // answer empty to this caller, and let the next one ask again.
      if (rev.tree === read) rev.tree = null;
      return [] as SceneTreeNode[];
    });
    rev.tree = read;
    return read;
  };

  /** Read `ids` into `rev`, sharing each read with anyone who asks for
   *  that element meanwhile. A failed read answers `null` to its callers
   *  and is forgotten, so the next caller asks again. Resolves to
   *  whether every read succeeded. */
  const load = (rev: Revision, ids: readonly ElementId[]): Promise<boolean> => {
    const bulk = readEnvelopes(host, ids);
    ids.forEach((id, i) => {
      const key = keyOf(id);
      const one: Promise<PluginMetadataEnvelope | null> = bulk.then((all) => {
        const read = all[i];
        if (read === undefined && rev.envelopes.get(key) === one) {
          rev.envelopes.delete(key);
        }
        return read ?? null;
      });
      rev.envelopes.set(key, one);
    });
    return bulk.then((all) => all.every((read) => read !== undefined));
  };

  const envelopeIn = (
    rev: Revision,
    id: ElementId,
  ): Promise<PluginMetadataEnvelope | null> => {
    const key = keyOf(id);
    const hit = rev.envelopes.get(key);
    if (hit) return hit;
    void load(rev, [id]);
    return rev.envelopes.get(key)!;
  };

  const seedFromTree = (rev: Revision, roots: readonly SceneTreeNode[]): void => {
    const walk = (nodes: readonly SceneTreeNode[]) => {
      for (const node of nodes) {
        const children = node.children ?? [];
        if (children.length > 0) {
          walk(children);
          continue;
        }
        if (!node.id) continue;
        const key = keyOf(node.id);
        if (rev.envelopes.has(key)) continue;
        const envelope = treeEnvelopeOf(node);
        if (envelope === undefined) continue;
        rev.envelopes.set(key, Promise.resolve(deepFreeze(envelope)));
      }
    };
    walk(roots);
  };

  /** One walk. Answers the snapshot and whether every read in it
   *  succeeded — an incomplete one is handed to its callers (they get
   *  what the old per-feature loops gave them) but not remembered. */
  const build = async (
    rev: Revision,
  ): Promise<{ snapshot: LinkSnapshot; complete: boolean }> => {
    const pending = treeOf(rev);
    const roots = await pending;
    let complete = rev.tree === pending;
    const ids = leafIdsOf(roots);
    // C-65: a tree that carries each row's metadata answers every leaf it
    // lists in the one read already made — no per-leaf round trips. Rows
    // without the field (an older engine) fall through to `load` below.
    seedFromTree(rev, roots);
    // Only the leaves nothing has read yet at this revision: a command
    // that resolved its record from the selection's own link first does
    // not pay for that leaf twice.
    const known = ids.map((id) => rev.envelopes.get(keyOf(id)));
    const missing = ids.filter((_, i) => known[i] === undefined);
    if (missing.length > 0 && !(await load(rev, missing))) complete = false;
    const envelopes = await Promise.all(
      ids.map((id, i) => known[i] ?? rev.envelopes.get(keyOf(id)) ?? null),
    );
    const leaves = ids.map((id, i) => ({ id, envelope: envelopes[i] ?? null }));
    return {
      snapshot: {
        roots,
        leaves,
        linked: leaves.filter((leaf) => leaf.envelope !== null),
      },
      complete,
    };
  };

  const start = (rev: Revision): Promise<LinkSnapshot> => {
    // The bookkeeping runs INSIDE the step that produces the answer, so
    // by the time any caller resumes, "is a walk in flight" and "is this
    // revision's snapshot remembered" are already true statements.
    const settle = (complete: boolean): void => {
      if (!complete && rev.snapshot === walk) rev.snapshot = null;
      if (walking === done) walking = null;
    };
    const walk: Promise<LinkSnapshot> = build(rev).then(
      (built) => {
        settle(built.complete);
        return built.snapshot;
      },
      (error: unknown) => {
        settle(false);
        throw error;
      },
    );
    const done: Promise<void> = walk.then(
      () => undefined,
      () => undefined,
    );
    rev.snapshot = walk;
    walking = done;
    return walk;
  };

  const snapshot = (): Promise<LinkSnapshot> => {
    const rev = revision();
    if (rev.snapshot) return rev.snapshot;
    if (!walking) return start(rev);
    // A walk of an OLDER revision is still out. Two walks in flight
    // would put two documents' worth of reads in the engine's inbox —
    // and a stream of changes would put one there per change. So: one
    // walk at a time, and ONE waiting, shared by everyone who asks
    // meanwhile. It walks whatever is current when its turn comes, which
    // is at least as new as what any of them asked for.
    queued ??= walking.then(() => {
      queued = null;
      return snapshot();
    });
    return queued;
  };

  const cached = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const rev = revision();
    const hit = rev.memo.get(key);
    if (hit) return hit as Promise<T>;
    const pending = read();
    rev.memo.set(key, pending);
    pending.catch(() => {
      if (rev.memo.get(key) === pending) rev.memo.delete(key);
    });
    return pending;
  };

  const propertiesOf = (id: ElementId): Promise<ElementProperties> =>
    cached(`properties:${keyOf(id)}`, () =>
      host.document.elementProperties(id),
    );

  // Subscribed for the life of the host: a cache with no invalidation
  // source is not a cache, so a host that cannot report a change gets no
  // caching at all (`revision()` above). The host tracks all three
  // subscriptions too, so bundle teardown drops them.
  try {
    host.document.onDidChange(() => {
      invalidate();
      emit();
    });
    subscribed = true;
  } catch {
    subscribed = false;
  }
  try {
    host.bindings.onDidChange((name) => {
      if (name === BIND_RECIPE_REVISION) emit();
    });
  } catch {
    /* no binding store: a recipe write reaches no listener here */
  }
  try {
    host.editor.client.subscribe((message) => {
      if (message.kind === "documentLoaded") {
        invalidate();
        emit();
      } else if (SILENT_CHANGES.has(message.kind)) {
        // The links may have moved, but no panel asked to hear about a
        // drag: the next read is fresh, and nothing is reloaded for it.
        invalidate();
      }
    });
  } catch {
    /* a host with no raw client reports its changes through the facade */
  }

  return {
    tree: () => treeOf(revision()),
    snapshot,
    envelopeOf: (id) => envelopeIn(revision(), id),
    propertiesOf,
    cached,
    peek: <T>(key: string) =>
      revision().memo.get(key) as Promise<T> | undefined,
    invalidate,
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };
}

/** The link index of `host` — created on first use, one per host. */
export function linkIndex(host: BundleHost): LinkIndex {
  let index = indexes.get(host);
  if (!index) {
    index = createLinkIndex(host);
    indexes.set(host, index);
  }
  return index;
}

/**
 * Tell every open panel that a recipe part was written.
 *
 * Called by each `write*Library` after a successful `parts.write` — the
 * one place a recipe reaches the container — rather than by the commands,
 * so a command cannot forget it and a panel needs no trailing reload at
 * its call sites.
 */
export function announceRecipeChange(host: {
  bindings?: BundleHost["bindings"];
}): void {
  const bindings = host.bindings;
  if (!bindings) return;
  const last = bindings.get(BIND_RECIPE_REVISION);
  bindings.publish(
    BIND_RECIPE_REVISION,
    (typeof last === "number" && Number.isFinite(last) ? last : 0) + 1,
  );
}
