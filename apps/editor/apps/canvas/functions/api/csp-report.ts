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

// The Trusted Types report sink (ADR 240): the deployed editor sends its
// policy report-only, and the browser posts each violation here
// (`report-uri /api/csp-report`, src/boot/trusted-types.ts). A violation is
// logged as one line to the Pages project's logs (`wrangler pages
// deployment tail`) and answered 204; nothing is stored. The body is capped:
// a report is a few hundred bytes.

const MAX_BODY = 16 * 1024;

interface Context {
  request: Request;
}

export async function onRequestPost({ request }: Context): Promise<Response> {
  const text = (await request.text()).slice(0, MAX_BODY);
  let report: unknown = text;
  try {
    report = JSON.parse(text);
  } catch {
    // not JSON: log the text as it came
  }
  const body =
    (report as { "csp-report"?: Record<string, unknown> })?.["csp-report"] ??
    report;
  const r = body as Record<string, unknown>;
  console.log(
    `csp-report ${String(r["violated-directive"] ?? r["effective-directive"] ?? "?")} ` +
      `${String(r["blocked-uri"] ?? "")} ${String(r["source-file"] ?? "")}:${String(r["line-number"] ?? "")} ` +
      `${String(r["script-sample"] ?? "").slice(0, 120)}`,
  );
  return new Response(null, { status: 204 });
}
