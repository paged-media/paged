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

// The React 19 behaviours the shell's features rest on (ADR 240), asserted
// so a React upgrade that changes one fails here instead of in a panel:
//
//   - a hidden <Activity> keeps its subtree's state and unmounts its
//     effects; shown again, the effects mount again;
//   - an effect event reads the latest render's values from a listener the
//     effect attached once;
//   - two Transitions started in separate events are independent: one that
//     suspends does not hold back the other.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  Activity,
  Suspense,
  startTransition,
  use,
  useEffect,
  useEffectEvent,
  useState,
} from "react";

afterEach(() => cleanup());

describe("React 19 behaviours the shell relies on", () => {
  test("a hidden Activity keeps state and unmounts effects", async () => {
    const log: string[] = [];
    function Counter() {
      const [n, setN] = useState(0);
      useEffect(() => {
        log.push("mount");
        return () => {
          log.push("unmount");
        };
      }, []);
      return (
        <button type="button" onClick={() => setN((v) => v + 1)}>
          {n}
        </button>
      );
    }
    function Host({ shown }: { shown: boolean }) {
      return (
        <Activity mode={shown ? "visible" : "hidden"}>
          <Counter />
        </Activity>
      );
    }
    const view = render(<Host shown />);
    const button = view.getByRole("button");
    await act(async () => button.click());
    expect(button.textContent).toBe("1");
    await act(async () => view.rerender(<Host shown={false} />));
    expect(log).toEqual(["mount", "unmount"]);
    expect(button.style.display).toBe("none");
    await act(async () => view.rerender(<Host shown />));
    // The same element, with its state; the effect mounted again.
    expect(view.getByRole("button")).toBe(button);
    expect(button.textContent).toBe("1");
    expect(log).toEqual(["mount", "unmount", "mount"]);
  });

  test("an effect event reads the latest value from a listener attached once", async () => {
    const target = new EventTarget();
    let attached = 0;
    const seen: number[] = [];
    function Listener({ value }: { value: number }) {
      const onPing = useEffectEvent(() => seen.push(value));
      useEffect(() => {
        attached++;
        const f = () => onPing();
        target.addEventListener("ping", f);
        return () => target.removeEventListener("ping", f);
      }, []);
      return null;
    }
    const view = render(<Listener value={1} />);
    await act(async () => view.rerender(<Listener value={2} />));
    target.dispatchEvent(new Event("ping"));
    expect(seen).toEqual([2]);
    expect(attached).toBe(1);
  });

  test("a suspended Transition does not hold back one started in another event", async () => {
    const never = new Promise<string>(() => {});
    let set!: { a: (v: string) => void; b: (v: string) => void };
    function Slow({ value }: { value: string }) {
      return <>{value === "a1" ? use(never) : value}</>;
    }
    function App() {
      const [a, setA] = useState("a0");
      const [b, setB] = useState("b0");
      set = { a: setA, b: setB };
      return (
        <>
          <Suspense fallback="loading">
            <span data-a>
              <Slow value={a} />
            </span>
          </Suspense>
          <span data-b>{b}</span>
        </>
      );
    }
    const view = render(<App />);
    await act(async () => startTransition(() => set.a("a1")));
    await act(async () => startTransition(() => set.b("b1")));
    // B committed; A is still pending on its promise, its old content shown.
    expect(view.container.querySelector("[data-b]")!.textContent).toBe("b1");
    expect(view.container.querySelector("[data-a]")!.textContent).toBe("a0");
  });
});
