// The session `activate` creates, reachable from a test.
//
// `activate(host)` builds its ImageSession internally and hands it only to
// the contributions it registers, so a test that invokes a REGISTERED
// command or tool (the real handler, not the session method behind it)
// cannot otherwise read what the command did to the image. This wraps
// `createImageSession` (bun:test's `mock.module`, the test kit's
// `importActual` pattern) to record each session it creates, unchanged:
// the wrapper delegates to the real factory and adds nothing else, so a
// suite that shares the module registry with this one sees the same
// sessions it always did.

import { mock } from "bun:test";

import { importActual } from "@paged-media/test-kit";

import type { ImageSession } from "../src/session";

const actual = await importActual(() => import("../src/session"));
const created: ImageSession[] = [];

mock.module("../src/session", () => ({
  ...actual,
  createImageSession: (
    ...args: Parameters<typeof actual.createImageSession>
  ) => {
    const s = actual.createImageSession(...args);
    created.push(s);
    return s;
  },
}));

/** The session the most recent `activate` created. */
export function lastSession(): ImageSession {
  const s = created.at(-1);
  if (!s) throw new Error("no image session was created (bundle not loaded?)");
  return s;
}
