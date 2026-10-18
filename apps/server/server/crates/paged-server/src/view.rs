/*
 * This file is part of paged (https://paged.media): paged.server, the optional
 * remote for paged repositories.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! The MCP Apps view (`ui://paged/view`, `text/html;profile=mcp-app`): shown next
//! to a tool's result in the model client. It speaks the extension's handshake
//! (`ui/initialize`, then `ui/notifications/initialized`), draws the result of
//! `describe_document`, `history`, `list_changes` and `render_page`, and can ask
//! the host for a download link. It never approves or merges: a call from here
//! is the model's, and those are a person's to make.
//!
//! Self-contained (no external script, style or font), so it needs nothing
//! beyond the default CSP.

pub const HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>paged</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1f; --muted: #6b6b75; --line: #e3e3e8; --accent: #c2185b; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #9a9aa6; --line: #2c2c33; --bg: #141418; } }
  body { margin: 0; padding: 12px 14px; font: 13px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
  .muted { color: var(--muted); }
  .mono { font: 11px ui-monospace, monospace; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 5px 0; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 10px; }
  .tag { font: 10px ui-monospace, monospace; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--line); }
  .agent { color: var(--accent); border-color: var(--accent); }
  img { max-width: 100%; border: 1px solid var(--line); }
  button { font: 11px ui-monospace, monospace; background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
</style>
</head>
<body>
<div id="root"><p class="muted">Waiting for a result…</p></div>
<script>
(() => {
  let next = 1;
  const waiting = new Map();
  let input = {};
  const root = document.getElementById("root");
  const send = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const when = (ts) => ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";
  const size = () => send({ method: "ui/notifications/size-changed", params: { width: document.body.scrollWidth, height: document.body.scrollHeight } });

  function draw(result) {
    const s = result.structuredContent;
    const image = (result.content || []).find((c) => c.type === "image");
    if (image) {
      root.innerHTML = `<h1>Page ${esc(input.page ?? 1)}</h1><img alt="Rendered page" src="data:${esc(image.mimeType)};base64,${image.data}">`;
    } else if (s && s.parts) {
      const refs = Object.entries(s.refs || {});
      root.innerHTML = `<h1>${esc(input.document)}</h1>
        <p class="muted mono">version ${esc(String(s.version).slice(0, 12))} · ${refs.length} ref${refs.length === 1 ? "" : "s"}</p>
        <ul>${s.parts.map((p) => `<li><span class="mono">${esc(p.path)}</span><span class="muted mono">${Number(p.size).toLocaleString()} B</span></li>`).join("")}</ul>
        <p><button id="dl">Download this version</button></p>`;
      document.getElementById("dl").onclick = async () => {
        const r = await request("tools/call", { name: "download_link", arguments: { document: input.document, ref: input.ref } });
        const url = r?.structuredContent?.url;
        if (url) request("ui/open-link", { url });
      };
    } else if (s && s.versions) {
      root.innerHTML = `<h1>History · ${esc(input.document)} · ${esc(input.ref || "main")}</h1>
        <ul>${s.versions.map((v) => `<li><span>${esc(v.message)} ${v.agent ? `<span class="tag agent">agent for ${esc(v.for)}</span>` : ""}</span>
          <span class="muted mono">${esc(String(v.version).slice(0, 10))} · ${esc(when(v.ts))}</span></li>`).join("")}</ul>`;
    } else if (Array.isArray(s)) {
      root.innerHTML = `<h1>Change requests · ${esc(input.document)}</h1>
        <ul>${s.map((c) => `<li><span>#${esc(c.id)} ${esc(c.title)} <span class="tag">${esc(c.status)}</span></span>
          <span class="muted mono">${esc(c.source)} → ${esc(c.target)} · ${(c.approvals || []).length} approval${(c.approvals || []).length === 1 ? "" : "s"}</span></li>`).join("")}</ul>
        <p class="muted">Approving and merging is done by a person with review rights, not from here.</p>`;
    } else {
      const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      root.innerHTML = `<pre class="mono">${esc(text)}</pre>`;
    }
    size();
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); m.error ? w.reject(m.error) : w.resolve(m.result); }
      return;
    }
    if (m.method === "ui/notifications/tool-input") input = m.params?.arguments || {};
    if (m.method === "ui/notifications/tool-result") draw(m.params || {});
    if (m.method === "ui/notifications/tool-cancelled") root.innerHTML = `<p class="muted">Cancelled.</p>`;
    if (m.method === "ui/resource-teardown" || m.method === "ping") send({ id: m.id, result: {} });
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appCapabilities: {},
    capabilities: {},
    clientInfo: { name: "paged view", version: "1" },
  }).then(() => send({ method: "ui/notifications/initialized", params: {} }), () => {});
})();
</script>
</body>
</html>"##;
