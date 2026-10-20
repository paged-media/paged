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

// The session snapshot a panel renders (src/panels/use-session.ts) stays
// current across a hidden dock tab: the editor keeps a hidden tab's panel in
// a hidden <Activity> (editor ADR 240), whose effects are unmounted, so a
// change made while it is hidden must show once the tab is shown again.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Activity, createElement } from "react";

import { useSessionSnapshot } from "../src/panels/use-session";
import type { DataSourceSession, SessionState } from "../src/session";

afterEach(() => cleanup());

function fakeSession() {
  const listeners = new Set<() => void>();
  let sources: string[] = [];
  const session = {
    getState: () => ({ sources: [...sources] }) as unknown as SessionState,
    onDidChange(l: () => void) {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
  } as unknown as DataSourceSession;
  return {
    session,
    addSilently(name: string) {
      sources = [...sources, name];
    },
    addSource(name: string) {
      sources = [...sources, name];
      for (const l of [...listeners]) l();
    },
  };
}

function Sources({ session }: { session: DataSourceSession }) {
  const [state] = useSessionSnapshot(session);
  return createElement("p", null, `sources: ${state.sources.join(",")}`);
}

describe("useSessionSnapshot", () => {
  it("shows a change made while the panel was hidden", () => {
    const s = fakeSession();
    const tree = (mode: "visible" | "hidden") =>
      createElement(Activity, {
        mode,
        children: createElement(Sources, { session: s.session }),
      });
    const view = render(tree("visible"));
    expect(view.container.textContent).toBe("sources: ");
    act(() => s.addSource("a"));
    expect(view.container.textContent).toBe("sources: a");
    act(() => view.rerender(tree("hidden")));
    act(() => s.addSource("catalogue"));
    act(() => view.rerender(tree("visible")));
    expect(view.container.textContent).toBe("sources: a,catalogue");
  });

  it("refresh re-reads the session after an action the panel started", () => {
    const s = fakeSession();
    function Probe() {
      const [state, refresh] = useSessionSnapshot(s.session);
      return createElement(
        "button",
        { type: "button", onClick: refresh },
        `sources: ${state.sources.join(",")}`,
      );
    }
    const view = render(createElement(Probe));
    // A change the session does not announce: only a refresh shows it.
    s.addSilently("quiet");
    expect(view.container.textContent).toBe("sources: ");
    act(() => view.container.querySelector("button")!.click());
    expect(view.container.textContent).toBe("sources: quiet");
  });
});
