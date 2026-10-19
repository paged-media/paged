#!/usr/bin/env bun
// cargo deny + cargo audit over every Cargo workspace in the repository.
//
//   bun tooling/supply-chain/rust-audit.mjs [--only <dir>] [--allow-missing]
//
// The workspaces are found, not listed: every tracked Cargo.lock is one.
// For each:
//
//   cargo deny --locked check advisories licenses bans sources
//       with the deny.toml beside the lockfile (license policy of ADR
//       PM-0001, RUSTSEC advisories, duplicate/wildcard bans, the source
//       allowlist). A workspace without a deny.toml fails, unless EXEMPT
//       names it with a reason.
//   cargo audit --file Cargo.lock
//       RustSec's own scanner over the same lockfile. Its ignore list is
//       the deny.toml `[advisories] ignore` list, so an advisory is
//       triaged once, in one file.
//
// A missing tool fails (a skipped scan is not a clean one) unless
// --allow-missing, which reports it as `unavailable` instead. The CI job
// (.github/workflows/supply-chain.yml) installs pinned versions of both.
// docs/migration/renovate.md describes the policy.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Cargo workspaces that carry no deny.toml of their own, and the deny.toml
 * whose advisory ignores apply to their `cargo audit`. cargo deny does not
 * run on them: each is a satellite of a workspace that is fully checked.
 */
const EXEMPT = {
  "modules/sheet/fuzz": {
    advisoriesFrom: "modules/sheet/deny.toml",
    reason:
      "cargo-fuzz harness (nightly, never shipped) over the sheet crates, which modules/sheet checks",
  },
  "engine/core/spikes/blitz-wasm": {
    advisoriesFrom: "engine/core/deny.toml",
    reason:
      "the W0 Blitz spike, kept for reference and never shipped; web-render checks the Blitz stack that ships",
  },
};

const INSTALL = {
  "cargo-deny": "cargo install --locked cargo-deny --version 0.20.2",
  "cargo-audit": "cargo install --locked cargo-audit --version 0.22.2",
};

/** The `[advisories] ignore` ids of a deny.toml (strings or `{ id = … }`). */
export function ignoredAdvisories(tomlText) {
  const toml = Bun.TOML.parse(tomlText);
  return (toml.advisories?.ignore ?? [])
    .map((x) => (typeof x === "string" ? x : x?.id))
    .filter((x) => typeof x === "string");
}

function have(tool) {
  return (
    spawnSync("cargo", [tool.replace(/^cargo-/, ""), "--version"], {
      encoding: "utf8",
    }).status === 0
  );
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowMissing = args.includes("--allow-missing");
  const only = args.includes("--only")
    ? args[args.indexOf("--only") + 1]
    : null;
  const gha = !!process.env.GITHUB_ACTIONS;

  const workspaces = execFileSync("git", ["ls-files", "*Cargo.lock"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((f) => dirname(f))
    .filter((d) => !only || d === only)
    .sort();
  if (workspaces.length === 0) {
    console.error(
      only
        ? `no Cargo workspace at ${only}`
        : "no Cargo.lock found (a scan that reads nothing passes everything)",
    );
    process.exit(2);
  }

  const tools = {
    "cargo-deny": have("cargo-deny"),
    "cargo-audit": have("cargo-audit"),
  };
  const rows = [];
  let failed = false;
  for (const ws of workspaces) {
    const dir = join(ROOT, ws);
    const denyToml = join(dir, "deny.toml");
    const exempt = EXEMPT[ws];
    const row = { ws, deny: "", audit: "" };

    // cargo deny
    if (existsSync(denyToml)) {
      if (!tools["cargo-deny"]) row.deny = "unavailable";
      else {
        const r = run(
          "cargo",
          [
            "deny",
            "--locked",
            "--log-level",
            "error",
            "check",
            "advisories",
            "licenses",
            "bans",
            "sources",
          ],
          dir,
        );
        row.deny = r.ok ? "ok" : "FAILED";
        if (!r.ok) {
          failed = true;
          console.log(`\n--- cargo deny: ${ws}\n${r.out}`);
          if (gha)
            console.log(
              `::error title=cargo deny (${ws})::cargo deny check failed; see the log`,
            );
        }
      }
    } else if (exempt) row.deny = "exempt";
    else {
      row.deny = "NO deny.toml";
      failed = true;
      console.log(
        `\n--- ${ws}: no deny.toml (copy engine/core's policy, or name it in EXEMPT with a reason)`,
      );
    }

    // cargo audit
    const policy = existsSync(denyToml)
      ? denyToml
      : exempt
        ? join(ROOT, exempt.advisoriesFrom)
        : null;
    const ignores = policy
      ? ignoredAdvisories(readFileSync(policy, "utf8"))
      : [];
    if (!tools["cargo-audit"]) row.audit = "unavailable";
    else {
      const r = run(
        "cargo",
        [
          "audit",
          "--file",
          join(dir, "Cargo.lock"),
          "--json",
          ...ignores.flatMap((id) => ["--ignore", id]),
        ],
        dir,
      );
      let report = null;
      try {
        report = JSON.parse(r.stdout);
      } catch {
        report = null;
      }
      if (!report) {
        row.audit = "ERROR";
        failed = true;
        console.log(`\n--- cargo audit: ${ws} did not answer\n${r.out}`);
      } else {
        const vulns = report.vulnerabilities?.list ?? [];
        const warnings = Object.values(report.warnings ?? {}).flat();
        row.audit = vulns.length
          ? `FAILED (${vulns.length})`
          : warnings.length
            ? `ok, ${warnings.length} warning(s)`
            : "ok";
        if (vulns.length || !r.ok) {
          failed = true;
          for (const v of vulns) {
            const line = `${v.advisory?.id} ${v.package?.name} ${v.package?.version}: ${v.advisory?.title}`;
            console.log(`--- cargo audit: ${ws}: ${line}`);
            if (gha) console.log(`::error title=cargo audit (${ws})::${line}`);
          }
        }
        for (const w of warnings) {
          const line = `${w.kind} ${w.advisory?.id ?? ""} ${w.package?.name} ${w.package?.version}`;
          console.log(`--- cargo audit warning: ${ws}: ${line}`);
        }
      }
    }
    rows.push(row);
  }

  const missing = Object.entries(tools)
    .filter(([, ok]) => !ok)
    .map(([t]) => t);
  const md = [
    "### Rust supply chain (cargo deny + cargo audit)",
    "",
    "| workspace | cargo deny | cargo audit |",
    "|---|---|---|",
    ...rows.map((r) => `| ${r.ws} | ${r.deny} | ${r.audit} |`),
    "",
    ...missing.map((t) => `unavailable: ${t} (${INSTALL[t]})`),
    "",
  ].join("\n");
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (missing.length && !allowMissing) {
    console.error(
      `missing ${missing.join(", ")}: a skipped scan is not a clean one (--allow-missing reports it instead)`,
    );
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}
