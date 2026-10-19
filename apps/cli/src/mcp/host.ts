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

// `paged mcp`'s host: the paged MCP tools over a disk library and the wasm
// engine, the TypeScript twin of the Rust CLI's `LocalHost`
// (engine/core/crates/paged-cli/src/mcp.rs). Store tools read and write the
// library's repositories; engine tools run the engine here, in the CLI's own
// headless session; `lookup_api` searches the engine's catalog.
//
// Writes are an agent's, as on paged.server: `agent:local` acting for
// `user:local`, on `agent/<run>/…` branches, with provenance; the library's
// owner merges them (the editor, or the Rust `paged`).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveCanvasWasm } from "@paged-media/plugin-sdk";

import {
  cliVersion,
  openSession,
  packageRoot,
  type CliSession,
  type SessionOptions,
} from "../session";
import { lookup } from "./catalog";
import {
  DiskLibrary,
  LOCAL_OWNER,
  loadRepositoryWasm,
  validName,
  type WasmRepository,
} from "./library";
import { error, json, type Host, type Outcome } from "./protocol";
import { ENGINE, REFERENCE, select, STORE, type Tool } from "./tools";

const AGENT = "agent:local";
const CLIENT = "paged mcp";
const HEX = /^[0-9a-f]{64}$/;

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : "";
const reference = (args: Record<string, unknown>, key: string): string =>
  str(args, key) || "main";
const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

interface Opened {
  document: string;
  version: string;
  /** The ref it was opened from; an agent/ branch is saved onto directly. */
  ref: string;
  branch: string | null;
  session: CliSession;
  pageIds: string[];
  pageSizesPt: [number, number][];
}

export interface LocalHostOptions {
  library: string;
  session: SessionOptions;
}

export class LocalHost implements Host {
  private opened: Opened | null = null;
  private readonly run = `local-${(Date.now() % 2 ** 40).toString(16)}`;
  private readonly scratch = join(tmpdir(), `paged-mcp-${process.pid}`);
  private seq = 0;

  private constructor(
    private readonly lib: DiskLibrary,
    private readonly catalog: Record<string, unknown>,
    private readonly options: SessionOptions,
  ) {}

  /** The library at `options.library`, over the engine the session options find. */
  static async create(options: LocalHostOptions): Promise<LocalHost> {
    const { dir } = await resolveCanvasWasm(
      options.session.engineFrom ??
        process.env["PAGED_ENGINE_FROM"] ??
        packageRoot(),
    );
    const mod = await loadRepositoryWasm(dir);
    const catalog = JSON.parse(
      readFileSync(join(dir, "introspect", "catalog.json"), "utf8"),
    ) as Record<string, unknown>;
    return new LocalHost(
      new DiskLibrary(options.library, mod),
      catalog,
      options.session,
    );
  }

  name(): string {
    return "paged (local)";
  }
  version(): string {
    return cliVersion();
  }
  tools(): Tool[] {
    return select(STORE, REFERENCE, ENGINE);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Outcome> {
    if (tool === "lookup_api")
      return json(lookup(this.catalog, str(args, "query"), 12));
    if ((ENGINE as readonly string[]).includes(tool))
      return this.engineTool(tool, args);
    return this.storeTool(tool, args);
  }

  dispose(): void {
    this.opened?.session.dispose();
    this.opened = null;
    rmSync(this.scratch, { recursive: true, force: true });
  }

  // ------------------------------------------------------------- helpers

  private file(ext: string): string {
    mkdirSync(this.scratch, { recursive: true });
    return join(this.scratch, `${this.run}-${Date.now()}-${this.seq++}.${ext}`);
  }

  private document(args: Record<string, unknown>): {
    name: string;
    repo: WasmRepository;
  } {
    const d = str(args, "document");
    if (!validName(d))
      throw new Error(`\`${d}\` is not a document name in this library`);
    return { name: d, repo: this.lib.open(d) };
  }

  /** A ref's head or a commit address, as an address. */
  private static version(repo: WasmRepository, r: string): string | null {
    const refs = JSON.parse(repo.refs()) as Record<string, string>;
    return refs[r] ?? (HEX.test(r) ? r : null);
  }

  private exportVersion(
    name: string,
    repo: WasmRepository,
    target: string,
  ): Uint8Array {
    this.lib.prepareExport(name, repo, target);
    const bytes = this.lib.run(name, repo, () =>
      repo.export(target, false, AGENT, Date.now()),
    );
    this.lib.persist(name, repo);
    return bytes;
  }

  // --------------------------------------------------------- store tools

  private storeTool(tool: string, args: Record<string, unknown>): Outcome {
    if (tool === "list_documents") {
      try {
        return json({ documents: this.lib.list(), library: this.lib.root });
      } catch (e) {
        return error(message(e));
      }
    }
    let name: string;
    let repo: WasmRepository;
    try {
      ({ name, repo } = this.document(args));
    } catch (e) {
      return error(message(e));
    }
    try {
      return json(this.storeOp(tool, args, name, repo));
    } catch (e) {
      return error(message(e));
    } finally {
      repo.free();
    }
  }

  private storeOp(
    tool: string,
    args: Record<string, unknown>,
    name: string,
    repo: WasmRepository,
  ): unknown {
    const at = (key: string): string => {
      const v = LocalHost.version(repo, reference(args, key));
      if (!v) throw new Error("no such ref");
      return v;
    };
    switch (tool) {
      case "describe_document": {
        const version = at("ref");
        const parts = JSON.parse(
          this.lib.run(name, repo, () => repo.tree(version)),
        );
        return { version, refs: JSON.parse(repo.refs()), parts };
      }
      case "read_part": {
        const version = at("ref");
        const path = str(args, "path");
        const bytes = this.lib.run(name, repo, () =>
          repo.readPart(version, path),
        );
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return { path, bytes: bytes.byteLength, text: false };
        }
      }
      case "history": {
        const log = JSON.parse(
          this.lib.run(name, repo, () => repo.log(reference(args, "ref"))),
        ) as Array<{
          hash: string;
          message: string;
          author: string;
          agent: boolean;
          ts: number;
        }>;
        return {
          versions: log.map((c) => ({
            version: c.hash,
            message: c.message,
            author: c.author,
            agent: c.agent,
            ts: c.ts,
            // A local library's agents act for its one owner.
            for: c.agent ? LOCAL_OWNER : null,
          })),
        };
      }
      case "diff": {
        const [a, b] = [at("from"), at("to")];
        const changes = JSON.parse(
          this.lib.run(name, repo, () => repo.diff(a, b)),
        ) as [string, string][];
        return changes.map(([path, change]) => ({ path, change }));
      }
      case "create_branch": {
        const short = str(args, "name");
        if (!validName(short))
          throw new Error("a branch name is lowercase letters, digits and '-'");
        const to = `agent/${this.run}/${short}`;
        const head = this.lib.run(name, repo, () =>
          repo.branchAgent(
            reference(args, "from"),
            to,
            AGENT,
            CLIENT,
            this.run,
            LOCAL_OWNER,
            Date.now(),
          ),
        );
        this.lib.persist(name, repo);
        return { ref: to, at: head };
      }
      case "commit_parts": {
        const branch = str(args, "branch");
        const manifest: unknown[] = [];
        const chunks: Uint8Array[] = [];
        let offset = 0;
        const parts = Array.isArray(args["parts"])
          ? (args["parts"] as Record<string, unknown>[])
          : [];
        for (const p of parts) {
          const path = str(p, "path");
          if (p["delete"] === true) {
            manifest.push({ path, delete: true });
            continue;
          }
          let bytes: Uint8Array;
          if (typeof p["text"] === "string")
            bytes = new TextEncoder().encode(p["text"]);
          else if (typeof p["base64"] === "string")
            bytes = Uint8Array.from(
              Buffer.from((p["base64"] as string).trim(), "base64"),
            );
          else throw new Error(`\`${path}\` needs text, base64 or delete`);
          manifest.push({ path, offset, len: bytes.byteLength });
          chunks.push(bytes);
          offset += bytes.byteLength;
        }
        const all = new Uint8Array(offset);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.byteLength;
        }
        const head = this.lib.run(name, repo, () =>
          repo.commitParts(
            branch,
            JSON.stringify(manifest),
            all,
            AGENT,
            CLIENT,
            this.run,
            LOCAL_OWNER,
            str(args, "message"),
            Date.now(),
          ),
        );
        this.lib.persist(name, repo);
        return { ref: branch, at: head };
      }
      case "propose_change":
      case "list_changes": {
        const path = join(this.lib.root, "repos", name, "changes.json");
        let list: Record<string, unknown>[] = [];
        try {
          list = JSON.parse(readFileSync(path, "utf8")) as Record<
            string,
            unknown
          >[];
        } catch {
          /* none yet */
        }
        if (tool === "list_changes") return list;
        const source = str(args, "branch");
        if (!LocalHost.version(repo, source) || HEX.test(source))
          throw new Error(`no such branch ${source}`);
        const cr = {
          id: list.length + 1,
          source,
          target: reference(args, "target"),
          title: args["title"] ?? null,
          author: AGENT,
          status: "open",
          created: Date.now(),
        };
        list.push(cr);
        writeFileSync(path, JSON.stringify(list, null, 2));
        return {
          change_request: cr,
          next: "The library's owner reviews and merges it; it is not on main yet.",
        };
      }
      case "download_link": {
        const version = at("ref");
        const bytes = this.exportVersion(name, repo, version);
        const out = join(
          this.lib.root,
          "exports",
          `${name}-${version.slice(0, 12)}.paged`,
        );
        mkdirSync(join(this.lib.root, "exports"), { recursive: true });
        writeFileSync(out, bytes);
        return { url: pathToFileURL(resolve(out)).href };
      }
      default:
        throw new Error(`no tool ${tool}`);
    }
  }

  // -------------------------------------------------------- engine tools

  private async engineTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Outcome> {
    try {
      switch (tool) {
        case "open_document":
          return json(await this.openDocument(args));
        case "run_script": {
          const o = this.requireOpen();
          const r = await o.session.h.runScript(str(args, "source"));
          return {
            ...json({ result: r }),
            isError: typeof r.error === "string",
          };
        }
        case "render_page": {
          const o = this.requireOpen();
          const n = Math.max(
            1,
            Number.isInteger(args["page"]) ? (args["page"] as number) : 1,
          );
          const pageId = o.pageIds[n - 1];
          if (!pageId)
            throw new Error(
              `no page ${n}: the document has ${o.pageIds.length}`,
            );
          // 96 dpi, as the Rust CLI renders.
          const widthPt = o.pageSizesPt[n - 1]?.[0] ?? 612;
          const widthPx = Math.max(
            1,
            Math.min(8192, Math.round((widthPt * 96) / 72)),
          );
          const shot = await o.session.driver.render.snapshot(pageId, {
            widthPx,
          });
          if (!shot) throw new Error(`page ${n} did not render`);
          return {
            content: [
              {
                type: "image",
                data: Buffer.from(shot.png).toString("base64"),
                mimeType: "image/png",
              },
            ],
            isError: false,
          };
        }
        case "save_document":
          return json(await this.saveDocument(args));
        default:
          throw new Error(`no tool ${tool}`);
      }
    } catch (e) {
      return error(message(e));
    }
  }

  private requireOpen(): Opened {
    if (!this.opened) throw new Error("open a document first");
    return this.opened;
  }

  private async openDocument(args: Record<string, unknown>): Promise<unknown> {
    const { name, repo } = this.document(args);
    let bytes: Uint8Array;
    let version: string;
    const ref = reference(args, "ref");
    try {
      const v = LocalHost.version(repo, ref);
      if (!v) throw new Error(`no such ref ${ref}`);
      version = v;
      bytes = this.exportVersion(name, repo, v);
    } finally {
      repo.free();
    }
    const path = this.file("paged");
    writeFileSync(path, bytes);
    this.opened?.session.dispose();
    this.opened = null;
    const session = await openSession(null, {
      ...this.options,
      cwd: this.options.cwd ?? process.cwd(),
    });
    let sizes: [number, number][] = [];
    const sub = session.driver.document.onDidOpen((e) => {
      sizes = e.pageSizesPt;
    });
    let pageIds: string[];
    try {
      pageIds = await session.h.load(readFileSync(path));
    } catch (e) {
      session.dispose();
      throw e;
    } finally {
      sub.dispose();
    }
    this.opened = {
      document: name,
      version,
      ref,
      branch: ref.startsWith("agent/") ? ref : null,
      session,
      pageIds,
      pageSizesPt: sizes,
    };
    return { document: name, version, loaded: { pages: pageIds.length } };
  }

  private async saveDocument(args: Record<string, unknown>): Promise<unknown> {
    const o = this.requireOpen();
    const { bytes } = await o.session.exportBytes("paged");
    const repo = this.lib.open(o.document);
    try {
      const branch =
        o.branch ?? `agent/${this.run}/edit-${o.version.slice(0, 8)}`;
      if (!o.branch && HEX.test(o.ref))
        throw new Error(
          "this version was opened by its address: open a branch or release to save",
        );
      const head = this.lib.run(o.document, repo, () =>
        repo.saveAgent(
          bytes,
          branch,
          o.ref,
          AGENT,
          CLIENT,
          this.run,
          LOCAL_OWNER,
          str(args, "message") || "Save",
          Date.now(),
        ),
      );
      this.lib.persist(o.document, repo);
      o.branch = branch;
      o.version = head;
      return {
        ref: branch,
        at: head,
        next: "On your branch; propose_change asks for it to reach main.",
      };
    } finally {
      repo.free();
    }
  }
}
