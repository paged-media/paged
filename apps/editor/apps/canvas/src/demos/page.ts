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

// The frame every demo page shares (docs/composable-editor-plan.md,
// workstream H): a header with the demo's title and a way back to the
// gallery, the element the editor is mounted in, and an aside for the
// host's own UI. Plain DOM: the demos are host pages, not editor code.

export interface DemoPage {
  /** Where the editor is mounted. */
  readonly stage: HTMLElement;
  /** The host's own UI beside the editor. */
  readonly aside: HTMLElement;
  /** Show a line of status in the header. */
  status(text: string): void;
}

export function demoPage(options: {
  title: string;
  intro: string;
  aside?: boolean;
}): DemoPage {
  document.title = `${options.title} · paged demos`;
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app");
  root.className = "demo";
  const header = document.createElement("header");
  header.className = "demo-header";
  const back = document.createElement("a");
  back.href = "./index.html";
  back.textContent = "← Demos";
  const h1 = document.createElement("h1");
  h1.textContent = options.title;
  const intro = document.createElement("p");
  intro.textContent = options.intro;
  const status = document.createElement("span");
  status.className = "demo-status";
  status.setAttribute("role", "status");
  header.append(back, h1, intro, status);
  const body = document.createElement("div");
  body.className = "demo-body";
  const stage = document.createElement("div");
  stage.className = "demo-stage";
  stage.setAttribute("data-demo-stage", "");
  const aside = document.createElement("aside");
  aside.className = "demo-aside";
  aside.hidden = !options.aside;
  body.append(stage, aside);
  root.append(header, body);
  return {
    stage,
    aside,
    status(text) {
      status.textContent = text;
    },
  };
}

/** A download link for `bytes`. */
export function downloadLink(
  bytes: Uint8Array,
  name: string,
  type: string,
): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  a.download = name;
  a.textContent = `Download ${name}`;
  return a;
}

/** A labelled element in the aside. */
export function section(aside: HTMLElement, title: string): HTMLElement {
  const s = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = title;
  s.append(h);
  aside.append(s);
  return s;
}
