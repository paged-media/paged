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

// The handler tests' shared setup: the editor-shaped fake from the test
// kit, the gesture DSL's unit backend over it, and the readers the
// assertions use.

import type { PagedEditor as ContractEditor } from "@paged-media/plugin-api";
import type { Mutation } from "@paged-media/client";
import {
  createFakeShellEditor,
  flattenMutation,
  gestures,
  type GestureDsl,
  type ShellFakeEditor,
  type ShellFakeOptions,
} from "@paged-media/test-kit";

export interface Harness {
  fake: ShellFakeEditor;
  g: GestureDsl;
}

/** A fake editor (one Letter page at the origin unless `pages` says
 *  otherwise) and the DSL over it. */
export function harness(options: ShellFakeOptions = {}): Harness {
  const fake = createFakeShellEditor(options);
  const g = gestures({
    // A built-in handler reads the shell's handle; the fake is structural.
    editor: fake.shell as unknown as ContractEditor,
    pages: fake.pages,
    camera: fake.camera,
    setZoom: fake.setZoom,
    tools: fake.tools,
    settle: fake.settle,
  });
  return { fake, g };
}

/** The leaves of every mutation the fake saw, in order. */
export function leaves(fake: ShellFakeEditor): Mutation[] {
  return fake
    .mutations()
    .flatMap((m) => flattenMutation(m as never)) as unknown as Mutation[];
}

/** The ops of the leaves (a short way to assert what was sent). */
export function ops(fake: ShellFakeEditor): string[] {
  return leaves(fake).map((m) => m.op);
}

/** The last tool preview the handler published (`null` = cleared). */
export function lastPreview(
  fake: ShellFakeEditor,
): Record<string, unknown> | null {
  return fake.currentPreview() as Record<string, unknown> | null;
}

/** Every non-null preview in order. */
export function previews(
  fake: ShellFakeEditor,
): Array<Record<string, unknown>> {
  return fake
    .previews()
    .filter((p) => p !== null && !Array.isArray(p)) as unknown as Array<
    Record<string, unknown>
  >;
}

/** Round to 6 decimals (the maths is f64; assertions compare values). */
export const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const rb = (b: readonly number[]) => b.map(r6);

/** Silence the handlers' refusal warnings in a test that provokes them. */
export function quietWarnings(): () => void {
  const warn = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = warn;
  };
}
