# Architecture decision records

Decisions that span the repository are recorded here as `PM-NNNN`. A decision that belongs to
one component stays with it, in that component's `docs/adr/`, numbered in the range it has
always used:

| Range | Component |
|---|---|
| 001–035 | from before the split, kept with the component that owns them |
| 100–199 | `engine/core` |
| 200–299 | `apps/editor` |
| 300–349 | `platform/extensions` |
| 350–749 | `modules/*` |
| 950–999 | `apps/server` |
| 1000–1099 | `engine/core` (from 2026-10-22, PM-0012; its records 200–209 keep their numbers) |

A PM record may supersede or amend a component record; it names it, and the component record
keeps its text.

| Record | Decision |
|---|---|
| [PM-0001](PM-0001-scope-home-and-licence.md) | Scope, home and licence: one public repository, AGPL-3.0-only OR PMEL |
| [PM-0002](PM-0002-built-ins-and-extensions.md) | Built-in modules share internal code; extensions see only the public contract (amended by PM-0014 and PM-0015) |
| [PM-0003](PM-0003-one-lint-config.md) | One root lint config: bun lint, with the import boundaries and the Rules of React enforced |
| [PM-0005](PM-0005-workspace-policy.md) | Separate Cargo workspaces, one JS workspace, the IDML crates in the engine |
| [PM-0006](PM-0006-proto-moon-mcp.md) | proto, Moon and the Moon MCP server |
| [PM-0008](PM-0008-npm-packages-and-release.md) | Four public npm packages, one release workflow; three since amendment 3 (viewer, paged, plugin-sdk), four since PM-0013 |
| [PM-0010](PM-0010-history-import.md) | The repository was assembled from twelve repositories, with their history |
| [PM-0011](PM-0011-dependency-updates-and-supply-chain.md) | Dependency updates by Renovate; licences and advisories checked daily over every workspace |
| [PM-0012](PM-0012-engine-adr-range.md) | The engine's records continue at 1000–1099; its 200–209 keep their numbers |
| [PM-0013](PM-0013-editor-package.md) | A fourth public package, `@paged-media/editor`: the editor bundled, the engine from `@paged-media/paged`, React a peer |
| [PM-0014](PM-0014-capability-layering.md) | A capability lives at the lowest layer every consumer can reach; modules may path-depend on engine crates |
| [PM-0015](PM-0015-data-and-actions-are-platform-layers.md) | Data and actions are platform layers: bindings in the engine, `data@1` and `actions@1`, Turso replaces DuckDB, one script interpreter |
