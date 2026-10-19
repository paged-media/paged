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

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { onChangeOf, subscribeOf, useLive, viewNow } from "../src/index";

function makeStore() {
  let items: string[] = [];
  const listeners = new Set<() => void>();
  return {
    add(item: string) {
      items = [...items, item];
      for (const l of listeners) l();
    },
    list: () => items,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

class Registry {
  #byId = new Map<string, string>();
  #handlers = new Set<() => void>();
  register(id: string) {
    this.#byId.set(id, id);
    for (const h of this.#handlers) h();
  }
  list() {
    return [...this.#byId.keys()];
  }
  onChange(handler: () => void) {
    this.#handlers.add(handler);
    return { dispose: () => this.#handlers.delete(handler) };
  }
}

afterEach(cleanup);

describe("useLive", () => {
  test("a memo over the view recomputes after a change, and only then", () => {
    const store = makeStore();
    const computed: string[][] = [];
    const seen = new Set<unknown>();
    function List() {
      const live = useLive(store, subscribeOf);
      seen.add(live);
      // What the React Compiler emits for a read of `live.list()`: a cache
      // entry keyed on `live`, here written out.
      const items = memoOn(live, () => live.list());
      computed.push(items);
      return (
        <ul>
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      );
    }
    const view = render(<List />);
    expect(view.container.querySelectorAll("li")).toHaveLength(0);
    act(() => store.add("a"));
    act(() => store.add("b"));
    expect(
      [...view.container.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["a", "b"]);
    expect(seen.size).toBe(3);
  });

  test("methods run on the source, private fields included", () => {
    const registry = new Registry();
    function Names() {
      const live = useLive(registry, onChangeOf);
      return <p>{live.list().join(",")}</p>;
    }
    const view = render(<Names />);
    act(() => registry.register("x"));
    expect(view.container.textContent).toBe("x");
    const before = viewNow(registry);
    registry.register("y");
    expect(viewNow(registry)).not.toBe(before);
    expect(viewNow(registry).list()).toEqual(["x", "y"]);
  });

  test("a change between the first render and the subscription is not lost", () => {
    const store = makeStore();
    function Late() {
      const live = useLive(store, subscribeOf);
      return <p>{memoOn(live, () => live.list().length)}</p>;
    }
    function AddsOnMount() {
      // Runs in the same commit, before Late's subscription: the source
      // changes after Late rendered with the old contents.
      useEffect(() => store.add("late"), []);
      return null;
    }
    const view = render(
      <>
        <AddsOnMount />
        <Late />
      </>,
    );
    expect(view.container.textContent).toBe("1");
  });
});

// A one-slot cache per key object, the shape of the compiler's own.
const memo = new WeakMap<object, unknown>();
function memoOn<T>(key: object, compute: () => T): T {
  if (!memo.has(key)) memo.set(key, compute());
  return memo.get(key) as T;
}
