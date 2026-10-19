#!/usr/bin/env node
// Read-only pre-check for retiring the @paged-media packages that PM-0008
// (amendment 3) leaves behind: may npm's unpublish policy allow `npm
// unpublish`, and in which order? docs/migration/npm-release-runbook.md, §5.
//
//   node tooling/release/retire-precheck.mjs [--json]
//
// For every package of the scope's inventory it asks the registry (GET only,
// no credential) for: the versions, the maintainers, when it was first
// published, the downloads of the last week
// (api.npmjs.org/downloads/point/last-week/<package>), and which other
// @paged-media packages depend on it in ANY published version (dependencies,
// peer and optional dependencies). npm lets an owner unpublish a package
// older than 72 hours only when no other public package depends on it, it had
// fewer than 300 downloads in the last week, and it has a single owner; this
// prints each condition it can see. Dependents outside the scope are not
// visible from here: the npmjs.com "Dependents" tab of each package says.
// `npm access list collaborators <package>` (the owner's own login) shows the
// organization's grants; it is printed as a command, not run.
//
// Exit 0 always: it reports, the owner decides.

const SCOPE = "@paged-media";
/** The scope's inventory on 2026-10-19 (docs/migration/npm.md). */
export const ACTIVE = ["paged", "viewer", "plugin-sdk"];
export const REPLACED = {
  "idml-viewer": "@paged-media/viewer",
  sdk: "@paged-media/viewer/session",
  "canvas-wasm": "@paged-media/paged",
  "introspect-wasm": "@paged-media/paged/introspect",
  "plugin-api": "@paged-media/plugin-sdk/api",
  "plugin-cli": "the paged-plugin bin of @paged-media/plugin-sdk",
};
export const BUNDLES = [
  "data",
  "draw",
  "image",
  "pdf",
  "publish",
  "sheet",
  "web",
];
export const INTERNAL = [
  "data-bundle",
  "draw-bundle",
  "image-glue",
  "sheet-bundle",
  "web-bundle",
  "data-host-model",
  "draw-geometry",
  "draw-tools",
  "image-manifest",
  "sheet-host-model",
  "web-model",
];
const ALL = [...ACTIVE, ...Object.keys(REPLACED), ...BUNDLES, ...INTERNAL];

async function get(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

const rows = [];
const dependents = new Map(ALL.map((p) => [`${SCOPE}/${p}`, new Set()]));
for (const p of ALL) {
  const name = `${SCOPE}/${p}`;
  const doc = await get(`https://registry.npmjs.org/${SCOPE}%2f${p}`);
  if (!doc) {
    rows.push({ name, onNpm: false });
    continue;
  }
  for (const [v, m] of Object.entries(doc.versions ?? {}))
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const dep of Object.keys(m[field] ?? {}))
        if (dependents.has(dep) && dep !== name)
          dependents.get(dep).add(`${name}@${v}`);
  const dl = await get(
    `https://api.npmjs.org/downloads/point/last-week/${SCOPE}/${p}`,
  );
  rows.push({
    name,
    onNpm: true,
    versions: Object.keys(doc.versions ?? {}).length,
    distTags: doc["dist-tags"] ?? {},
    maintainers: (doc.maintainers ?? []).map((m) => m.name),
    created: doc.time?.created ?? null,
    deprecated: doc.versions?.[doc["dist-tags"]?.latest]?.deprecated ?? null,
    lastWeek: dl?.downloads ?? null,
  });
}
for (const r of rows) {
  const deps = [...(dependents.get(r.name) ?? [])];
  const pkgs = [
    ...new Set(deps.map((d) => d.slice(0, d.lastIndexOf("@")))),
  ].sort();
  r.dependentsInScope = pkgs;
  const short = r.name.slice(SCOPE.length + 1);
  r.role = ACTIVE.includes(short)
    ? "active"
    : short in REPLACED
      ? `deprecate → ${REPLACED[short]}`
      : BUNDLES.includes(short)
        ? "retire (bundle)"
        : "retire (internal)";
  if (r.onNpm && r.role.startsWith("retire")) {
    const why = [];
    if (r.lastWeek === null || r.lastWeek >= 300)
      why.push(`downloads last week ${r.lastWeek}`);
    if (r.maintainers.length !== 1)
      why.push(`${r.maintainers.length} maintainers`);
    if (pkgs.length) why.push(`depended on by ${pkgs.join(", ")}`);
    r.unpublish = why.length
      ? `not now: ${why.join("; ")}`
      : "allowed by what this sees";
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    if (!r.onNpm) {
      console.log(`${r.name.padEnd(30)} not on npm  (${r.role})`);
      continue;
    }
    console.log(
      `${r.name.padEnd(30)} ${String(r.versions).padStart(3)} versions  ${String(r.lastWeek).padStart(5)}/week  maintainers ${r.maintainers.join(",")}  ${r.role}` +
        (r.dependentsInScope.length
          ? `  dependents: ${r.dependentsInScope.join(", ")}`
          : "") +
        (r.unpublish ? `  → unpublish: ${r.unpublish}` : ""),
    );
  }
  console.log(
    `\nCollaborators (the owner's login, read-only): for p in ${[...BUNDLES, ...INTERNAL].join(" ")}; do npm access list collaborators "${SCOPE}/$p"; done`,
  );
}
