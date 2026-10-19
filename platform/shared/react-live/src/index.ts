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

// A mutable source as a render value (apps/editor/docs/adr/229-react-compiler.md).
//
// The editor's registries, a bundle's published bindings, a module's panel
// store and the BundleHost surfaces are long-lived objects whose CONTENTS
// change while their identity never does. A component that reads one during
// render (`menus.list()`, `store.activePage()`, `bindings.get(name)`) used to
// re-render through a counter bumped from an onChange effect, and sometimes
// listed that counter as a memo dependency it never read. The React Compiler
// memoizes on what a computation reads, not on a dependency array: it keeps
// `store.list()` for as long as `store` is the same object, which is
// forever, and a counter that is never read is not a dependency.
//
// `useLive(source, listen)` makes the change part of the data flow. It
// returns a VIEW of the source, a new object after every change the source
// reports, which reads through to the source. A memo (the compiler's or a
// hand-written one) keyed on the view recomputes exactly when the source
// changed. Read during render through the view; keep the source itself for
// effects and handlers, whose identity must not change.

import { useSyncExternalStore } from "react";

/** How to hear about a change of `source`; returns the unsubscribe. */
export type Listen<T> = (source: T, onChange: () => void) => () => void;

interface Entry {
  view: object;
  listeners: Set<() => void>;
  subscribe: (notify: () => void) => () => void;
  getView: () => object;
}

const entries = new WeakMap<object, Entry>();

/** A view reads every property from the source; its methods run bound to
 *  the source, so a class with private fields works through it, and each
 *  method keeps one identity per view. */
function viewOf<T extends object>(source: T): T {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(source, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      let fn = bound.get(key);
      if (!fn) {
        fn = (value as (...args: unknown[]) => unknown).bind(target);
        bound.set(key, fn);
      }
      return fn;
    },
  });
}

/** The source's entry, listening from the first time anything reads it,
 *  for as long as the source lives. Listening from the first READ, not
 *  from the first subscription: a change that lands after a component
 *  rendered and before React subscribed it (an effect earlier in the same
 *  commit) must still produce a new view, or the component would keep
 *  what it rendered. Idempotent, and nothing to clean up: the listener
 *  goes when the source does. */
function entryOf<T extends object>(source: T, listen?: Listen<T>): Entry {
  let entry = entries.get(source);
  if (!entry) {
    const listeners = new Set<() => void>();
    const created: Entry = {
      view: viewOf(source),
      listeners,
      subscribe: (notify) => {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
      getView: () => created.view,
    };
    entry = created;
    entries.set(source, entry);
    listen?.(source, () => {
      created.view = viewOf(source);
      for (const listener of [...listeners]) listener();
    });
  }
  return entry;
}

/** `source` as a value that changes whenever the source says it changed.
 *  `listen` is used the first time a source is seen; pass the same
 *  adapter for a given source (one of the module-level ones below). */
export function useLive<T extends object>(source: T, listen: Listen<T>): T {
  const entry = entryOf(source, listen);
  return useSyncExternalStore(
    entry.subscribe,
    entry.getView,
    entry.getView,
  ) as T;
}

/** A new view of `source`, for a caller that tracks the source's changes
 *  itself (keeps it in state beside a snapshot, say): the same proxy
 *  `useLive` hands out, without the subscription. */
export function freshView<T extends object>(source: T): T {
  return viewOf(source);
}

/** The current view of `source`, outside React (a test asserting that two
 *  reads before and after a change differ). */
export function viewNow<T extends object>(source: T): T {
  return entryOf(source).getView() as T;
}

/** For a source with `onChange(handler): Disposable` (the editor's
 *  registries). */
export const onChangeOf: Listen<{
  onChange(handler: () => void): { dispose(): void };
}> = (source, onChange) => {
  const sub = source.onChange(() => onChange());
  return () => sub.dispose();
};

/** For a source with `onDidChange(listener): Disposable` (the contract's
 *  surfaces: bindings, a session, a document). */
export const onDidChangeOf: Listen<{
  onDidChange(listener: () => void): { dispose(): void };
}> = (source, onChange) => {
  const sub = source.onDidChange(() => onChange());
  return () => sub.dispose();
};

/** For a source with `subscribe(listener): () => void` (a store). */
export const subscribeOf: Listen<{
  subscribe(listener: () => void): () => void;
}> = (source, onChange) => source.subscribe(() => onChange());

export {
  useNearViewport,
  type NearViewport,
  type NearViewportOptions,
} from "./near-viewport";
