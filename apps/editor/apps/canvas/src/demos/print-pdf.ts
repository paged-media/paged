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

// Demo: print-ready PDF with validation. A filled business card checked
// before it goes to print (the template's own findings, the fields' values,
// and paged.publish's PDF preflight for PDF/X-4), then exported through
// paged.publish's typed exporter when Submit reaches the host. An error
// blocks the export; warnings are listed and the PDF still comes.
//
// PDF/X-4 names an output intent: the press condition's CMYK profile. A host
// registers its printer's profile; this demo registers a stand-in computed
// by scripts/demo-files.ts (a naive ink model, not a measured condition).

// `?url`: the build emits the files and the demo fetches them there.
import cardUrl from "../../demos/assets/business-card.paged?url";
import profileUrl from "../../demos/assets/demo-cmyk.icc?url";

import { createEditor, type EditorHandle } from "../embed";
import { demoPage, downloadLink, section } from "./page";

const PROFILE = "Demo CMYK";
const PUBLISH = "media.paged.publish";

interface Finding {
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
}

const page = demoPage({
  title: "Print-ready PDF",
  intro:
    "Checked before it prints: the template, the fields and a PDF/X-4 preflight, then the PDF.",
  aside: true,
});
const fetchBytes = async (url: string) =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());

const checks = section(page.aside, "Checks");
const list = document.createElement("ul");
list.setAttribute("data-demo-findings", "");
const verdict = document.createElement("p");
verdict.setAttribute("data-demo-verdict", "");
const run = document.createElement("button");
run.textContent = "Check";
run.setAttribute("data-demo-check", "");
checks.append(run, verdict, list);
const output = section(page.aside, "PDF");
const result = document.createElement("p");
result.setAttribute("data-demo-pdf", "");
result.textContent = "Submit checks the card and exports it.";
output.append(result);

const pdfOptions = {
  standard: "pdfx4",
  outputIntentProfile: PROFILE,
  outputCondition: "Demo CMYK (naive ink model)",
  title: "Business card",
};

/** Every finding: the template's (its author's problems), the fields' (a
 *  required value missing, text that does not fit) and the PDF exporter's. */
async function check(editor: EditorHandle): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const f of await editor.client.templateFindings())
    out.push({
      severity: f.severity === "error" ? "error" : "warning",
      source: "template",
      message: f.message,
    });
  for (const row of await editor.fields()) {
    const label = row.field.label ?? row.field.name;
    const empty =
      !row.value || (row.value.kind === "text" && row.value.text.trim() === "");
    if (row.field.required && empty)
      out.push({
        severity: "error",
        source: "fields",
        message: `${label} is required`,
      });
    if (row.overset)
      out.push({
        severity: "error",
        source: "fields",
        message: `${label} does not fit`,
      });
  }
  const pdf = (await editor.objects.invoke(
    `${PUBLISH}.preflight`,
    pdfOptions,
  )) as {
    findings: {
      severity: Finding["severity"];
      message: string;
      page: number;
    }[];
  };
  for (const f of pdf.findings)
    out.push({
      severity: f.severity,
      source: "PDF/X-4",
      message: f.page > 0 ? `${f.message} (page ${f.page})` : f.message,
    });
  return out;
}

function show(findings: readonly Finding[]): boolean {
  list.replaceChildren(
    ...findings.map((f) => {
      const li = document.createElement("li");
      li.setAttribute("data-demo-finding", f.severity);
      li.textContent = `${f.severity} · ${f.source}: ${f.message}`;
      return li;
    }),
  );
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  verdict.textContent = errors
    ? `${errors} error(s): fix them before printing`
    : warnings
      ? `ready to print, with ${warnings} warning(s)`
      : "ready to print: no problems";
  return errors === 0;
}

let editor: EditorHandle;
editor = await createEditor(page.stage, {
  profile: {
    extends: "template-fill",
    regions: {
      "actions-bar": { items: [{ kind: "spacer" }, "paged.host.submit"] },
    },
  },
  document: {
    bytes: await fetchBytes(cardUrl),
    name: "card.paged",
  },
  actions: {
    // The host's export: check, then write the PDF through paged.publish.
    async submit() {
      if (!show(await check(editor))) {
        result.textContent = "Not exported: the checks found errors.";
        return;
      }
      const pdf = (await editor.objects.invoke(
        `${PUBLISH}.exportPdf`,
        pdfOptions,
      )) as {
        bytes: Uint8Array;
        pageCount: number;
      };
      result.textContent = `PDF/X-4, ${pdf.pageCount} page(s), ${pdf.bytes.byteLength.toLocaleString("en")} bytes. `;
      result.append(
        downloadLink(pdf.bytes, "business-card.pdf", "application/pdf"),
      );
    },
  },
});
await editor.client.registerColorProfile(PROFILE, await fetchBytes(profileUrl));
await editor.setRole("filler");
run.addEventListener("click", async () => void show(await check(editor)));
page.status("ready: fill the card, Check, then Submit");
