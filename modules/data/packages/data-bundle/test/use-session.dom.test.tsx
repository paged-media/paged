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

// useSessionSnapshot under a hidden <Activity>, the way a dock tab the user
// is not looking at is kept (editor ADR 240): the state stays, the effect
// (the session subscription) is unmounted. Showing the tab again must show
// the session as it is now, not as it was when the tab was hidden.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Activity, createElement } from "react";

import { useSessionSnapshot } from "../src/panels/use-session";
import type { DataSourceSession, SessionState } from "../src/session";

afterEach(() => cleanup());

/** The two members the hook reads, over a mutable state. */
function fakeSession(): {
  session: DataSourceSession;
  set(status: string): void;
} {
  let state = { persistence: { status: "pending", hash: null } };
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state as unknown as SessionState,
    onDidChange(l: () => void) {
      listeners.add(l);
      return { dispose: () => void listeners.delete(l) };
    },
  } as unknown as DataSourceSession;
  return {
    session,
    set(status) {
      state = { persistence: { status, hash: null } };
      for (const l of [...listeners]) l();
    },
  };
}

function Status({ session }: { session: DataSourceSession }) {
  const [state] = useSessionSnapshot(session);
  return createElement(
    "p",
    { "data-persistence": state.persistence.status },
    state.persistence.status,
  );
}

const shown = (root: HTMLElement) =>
  root.querySelector("[data-persistence]")?.getAttribute("data-persistence");

describe("useSessionSnapshot", () => {
  it("follows the session while shown", async () => {
    const f = fakeSession();
    const { container } = render(createElement(Status, { session: f.session }));
    expect(shown(container)).toBe("pending");
    await act(async () => f.set("saved"));
    expect(shown(container)).toBe("saved");
  });

  it("a tab shown again reads the session as it is now (a change while it was hidden is not lost)", async () => {
    const f = fakeSession();
    const tree = (mode: "visible" | "hidden") =>
      createElement(Activity, {
        mode,
        children: createElement(Status, { session: f.session }),
      });
    const { container, rerender } = render(tree("visible"));
    expect(shown(container)).toBe("pending");
    await act(async () => rerender(tree("hidden")));
    // Saved while the tab is hidden: no subscription hears it.
    await act(async () => f.set("saved"));
    await act(async () => rerender(tree("visible")));
    expect(shown(container)).toBe("saved");
  });
});
