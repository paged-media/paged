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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Fragment, useState } from "react";

import { useNearViewport } from "../src/index";

// A stand-in IntersectionObserver (the test DOM's never reports): it records
// what it observes, and a test reports an element as intersecting.
const observers: FakeObserver[] = [];
class FakeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  intersect(target: Element) {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

let saved: unknown;
beforeEach(() => {
  observers.length = 0;
  saved = globalThis.IntersectionObserver;
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeObserver;
});
afterEach(() => {
  cleanup();
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
    saved;
});

function List({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  const { observe: observeNear, has: isNear } = useNearViewport({ eager: 2 });
  const keys = Array.from({ length: count }, (_, i) => `k${i}`);
  return (
    <div>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        more
      </button>
      <Fragment ref={observeNear}>
        {keys.map((k, i) => (
          <div key={k} data-near={k}>
            {isNear(k, i) ? `${k}:shown` : `${k}:waiting`}
          </div>
        ))}
      </Fragment>
    </div>
  );
}

describe("useNearViewport", () => {
  test("the eager head is near at once; the rest when the observer reports them", async () => {
    const view = render(<List initial={6} />);
    const text = () => view.container.textContent ?? "";
    expect(text()).toContain("k0:shown");
    expect(text()).toContain("k1:shown");
    expect(text()).toContain("k4:waiting");
    // One observer, watching every item through the fragment.
    expect(observers.length).toBe(1);
    expect(observers[0]!.targets.size).toBe(6);
    const k4 = view.container.querySelector('[data-near="k4"]')!;
    await act(async () => observers[0]!.intersect(k4));
    expect(text()).toContain("k4:shown");
    expect(text()).toContain("k5:waiting");
  });

  test("an item added later is observed too", async () => {
    const view = render(<List initial={3} />);
    await act(async () => view.getByText("more").click());
    const k3 = view.container.querySelector('[data-near="k3"]')!;
    expect(observers.at(-1)!.targets.has(k3)).toBe(true);
    await act(async () => observers.at(-1)!.intersect(k3));
    expect(view.container.textContent).toContain("k3:shown");
  });
});
