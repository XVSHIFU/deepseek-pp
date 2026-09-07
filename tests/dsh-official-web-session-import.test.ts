import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionSeq, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { afterEach, describe, expect, it } from "vitest";

import {
  ImportingJsonlSessionPersistence,
  recoverSessionImports,
} from "../packages/dsh-deepseek-web-official-plugin/src/session-import.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("T7 official completed-session import", () => {
  it("imports a completed root and required child atomically through official persistence", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await createCompleted(fixture.sourceContext, "child", fixture.workspace, "root");
      const receipt = await fixture.target.sessionImport.importCompleted(request(fixture, "root"));
      expect(receipt).toMatchObject({ rootSessionId: "root", imported: 2, idempotent: 0 });
      expect(receipt.sessionIds).toEqual(["root", "child"]);
      expect((await fixture.target.list()).map((header) => String(header.id)).sort()).toEqual(["child", "root"]);
      expect((await fixture.target.inspect(SessionId("root"))).events.at(-1)).toMatchObject({
        type: "turn/end", data: { reason: { kind: "completed" } },
      });
      const preparation = await fixture.target.prepare(SessionId("root"));
      const detach = fixture.targetContext.sessions.enter(preparation.session);
      fixture.targetContext.sessions.announce(preparation.session);
      preparation.session.append("turn/start", { turn: 2 });
      preparation.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
      await fixture.targetContext.sessions.flush(preparation.session);
      detach();
      preparation[Symbol.dispose]();
      expect((await fixture.target.inspect(SessionId("root"))).events.at(-1)).toMatchObject({
        type: "turn/end", data: { turn: 2, reason: { kind: "completed" } },
      });
      expect(fixture.target.sessionImport.isImportedSessionDenied("root")).toBe(true);
      expect(fixture.target.sessionImport.isImportedSessionDenied("child")).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("is idempotent only while the target has identical official content", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "same", fixture.workspace);
      await fixture.target.sessionImport.importCompleted(request(fixture, "same"));
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "same"))).resolves.toMatchObject({
        imported: 0, idempotent: 1,
      });
      await fixture.target.append(SessionId("same"), [event(2, "turn/start", { turn: 2 })]);
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "same")))
        .rejects.toThrow("SESSION_IMPORT_CONFLICT:same");
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects unfinished roots and any unfinished descendant as one group", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await createUnfinished(fixture.sourceContext, "child", fixture.workspace, "root");
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root")))
        .rejects.toThrow(/SESSION_IMPORT_(?:NOT_COMPLETED|AMBIGUOUS|UNFINISHED):child/u);
      expect(await fixture.target.list()).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects a live target identity before staging or target mutation", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      fixture.targetContext.sessions.create(SessionId("root"), { meta: { cwd: fixture.workspace } });
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root")))
        .rejects.toThrow("SESSION_IMPORT_TARGET_ACTIVE:root");
      expect(await physicalSessionFiles(fixture.targetRoot)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("requires the explicit stopped-process acknowledgement and refuses product leases", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await expect(fixture.target.sessionImport.importCompleted({
        sourceHome: fixture.oldHome,
        rootSessionId: "root",
        sourceProcessesStopped: false as true,
      })).rejects.toThrow("SESSION_IMPORT_SOURCE_STOP_CONFIRMATION_REQUIRED");
      await writeFile(join(fixture.oldHome, ".installation.lock"), "busy", "utf8");
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root")))
        .rejects.toThrow("SESSION_IMPORT_SOURCE_BUSY");
      await rm(join(fixture.oldHome, ".installation.lock"));
      await writeFile(join(fixture.oldHome, "state", "profiles", "deepseek-web-agent", "web-model-journal", "owner.lock"), "busy", "utf8");
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root")))
        .rejects.toThrow("SESSION_IMPORT_SOURCE_BUSY");
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps every prepared id hidden until the single committed marker is published", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({ afterPublish: ({ index }) => index === 0 ? blocked : undefined });
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await createCompleted(fixture.sourceContext, "child", fixture.workspace, "root");
      const importing = fixture.target.sessionImport.importCompleted(request(fixture, "root"));
      await waitFor(async () => (await physicalSessionFiles(fixture.targetRoot)).length === 1);
      await expect(open(join(fixture.oldHome, ".installation.lock"), "wx", 0o600)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fixture.target.list()).toEqual([]);
      release();
      await importing;
      expect((await fixture.target.list()).map((header) => String(header.id)).sort()).toEqual(["child", "root"]);
    } finally {
      release();
      await fixture.dispose();
    }
  });

  it("rolls back a partially published group on cancellation and leaves the source byte-identical", async () => {
    const controller = new AbortController();
    const fixture = await createFixture({ afterPublish: () => controller.abort(new Error("cancel import")) });
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await createCompleted(fixture.sourceContext, "child", fixture.workspace, "root");
      const before = await snapshotFiles(join(fixture.oldHome, "state", "sessions"));
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root"), controller.signal))
        .rejects.toThrow("cancel import");
      expect(await fixture.target.list()).toEqual([]);
      expect(await snapshotFiles(join(fixture.oldHome, "state", "sessions"))).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects a source revision change after staging without exposing a target", async () => {
    let sourceSession: Session | undefined;
    let fixture!: Fixture;
    fixture = await createFixture({
      beforePrepareJournal: async () => {
        sourceSession!.append("turn/start", { turn: 2 });
        await fixture.sourceContext.sessions.flush(sourceSession!);
      },
    });
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      sourceSession = fixture.sourceContext.sessions.get(SessionId("root"));
      await expect(fixture.target.sessionImport.importCompleted(request(fixture, "root")))
        .rejects.toThrow("SESSION_IMPORT_SOURCE_CHANGED:root");
      expect(await fixture.target.list()).toEqual([]);
      expect(await readdir(join(fixture.importRoot, "staging"))).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("startup recovery removes every matching leaf from an uncommitted prepared journal", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({ afterPublish: ({ index }) => index === 0 ? blocked : undefined });
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await createCompleted(fixture.sourceContext, "child", fixture.workspace, "root");
      const importing = fixture.target.sessionImport.importCompleted(request(fixture, "root"));
      await waitFor(async () => (await physicalSessionFiles(fixture.targetRoot)).length === 1);
      await recoverSessionImports(fixture.importRoot, fixture.targetRoot);
      expect(await physicalSessionFiles(fixture.targetRoot)).toEqual([]);
      release();
      await expect(importing).rejects.toThrow();
    } finally {
      release();
      await fixture.dispose();
    }
  });

  it("recovers a prepared crash before providing visibility and preserves committed deny tombstones", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await fixture.target.sessionImport.importCompleted(request(fixture, "root"));
      const denied = await recoverSessionImports(fixture.importRoot, fixture.targetRoot);
      expect(denied.has("root")).toBe(true);
      expect((await fixture.target.inspect(SessionId("root"))).events.at(-1)?.type).toBe("turn/end");
    } finally {
      await fixture.dispose();
    }
  });

  it("treats a durable committed marker as authoritative when POSIX-style cleanup left active linked", async () => {
    const fixture = await createFixture();
    try {
      await createCompleted(fixture.sourceContext, "root", fixture.workspace);
      await fixture.target.sessionImport.importCompleted(request(fixture, "root"));
      const [marker] = await readdir(join(fixture.importRoot, "committed"));
      await link(join(fixture.importRoot, "committed", marker!), join(fixture.importRoot, "active.json"));
      const denied = await recoverSessionImports(fixture.importRoot, fixture.targetRoot);
      expect(denied.has("root")).toBe(true);
      expect((await fixture.target.list()).map((header) => String(header.id))).toEqual(["root"]);
    } finally {
      await fixture.dispose();
    }
  });
});

interface Fixture {
  readonly oldHome: string;
  readonly workspace: string;
  readonly sourceContext: Context;
  readonly targetContext: Context;
  readonly target: ImportingJsonlSessionPersistence;
  readonly targetRoot: string;
  readonly importRoot: string;
  dispose(): Promise<void>;
}

async function createFixture(hooks?: ConstructorParameters<typeof ImportingJsonlSessionPersistence>[4]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "t7-import-"));
  roots.push(root);
  const oldHome = join(root, "old");
  const targetRoot = join(root, "target-sessions");
  const importRoot = join(root, "import-transactions");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(targetRoot, { recursive: true }), mkdir(importRoot, { recursive: true })]);
  await createStandaloneMetadata(oldHome);

  const sourceContext = new Context();
  const sourceFibers = [await sourceContext.plugin(SessionStore)];
  sourceFibers.push(await sourceContext.plugin(JsonlSessionPersistence, {
    root: join(oldHome, "state", "sessions"), compression: "none", packChunks: false,
  }));

  const targetContext = new Context();
  const targetFibers = [await targetContext.plugin(SessionStore)];
  const denied = await recoverSessionImports(importRoot, targetRoot);
  let target!: ImportingJsonlSessionPersistence;
  const provider = await targetContext.plugin({
    inject: ["sessions"],
    apply(ctx: Context) {
      target = new ImportingJsonlSessionPersistence(ctx, {
        root: targetRoot, compression: "none", packChunks: false,
      }, importRoot, denied, hooks);
    },
  });
  targetFibers.push(provider);
  return {
    oldHome, workspace, sourceContext, targetContext, target, targetRoot, importRoot,
    async dispose() {
      for (const fiber of targetFibers.reverse()) await fiber.dispose();
      for (const fiber of sourceFibers.reverse()) await fiber.dispose();
    },
  };
}

async function createStandaloneMetadata(home: string): Promise<void> {
  const distribution = `${JSON.stringify({
    schema_version: 1,
    kind: "local-development",
    node_major: 24,
    harness_version: "0.1.2-rc.1",
    source_commit: "0".repeat(40),
    files: [],
  })}\n`;
  const hash = createHash("sha256").update(distribution).digest("hex");
  const version = `${hash}-${"1".repeat(16)}`;
  await Promise.all([
    mkdir(join(home, "state", "sessions"), { recursive: true }),
    mkdir(join(home, "state", "profiles", "deepseek-web-agent", "web-model-journal"), { recursive: true }),
    mkdir(join(home, ".versions", version, "runtime"), { recursive: true }),
  ]);
  const owner = `${JSON.stringify({ schema_version: 1, product: "deepseek-pp-web-agent" }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(home, ".deepseek-web-agent-owner.json"), owner, "utf8"),
    writeFile(join(home, ".versions", version, "owner.json"), owner, "utf8"),
    writeFile(join(home, ".versions", version, "runtime", "distribution.json"), distribution, "utf8"),
    writeFile(join(home, "active.json"), `${JSON.stringify({ schema_version: 1, distribution_sha256: hash, version_directory: version })}\n`, "utf8"),
  ]);
}

async function createCompleted(ctx: Context, id: string, cwd: string, parentSession?: string): Promise<void> {
  const session = ctx.sessions.create(SessionId(id), {
    meta: { cwd, ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession), origin: "subagent" as const, delegationDepth: 1 }) },
  });
  session.append("turn/start", { turn: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  await ctx.sessions.flush(session);
}

async function createUnfinished(ctx: Context, id: string, cwd: string, parentSession: string): Promise<void> {
  const session = ctx.sessions.create(SessionId(id), {
    meta: { cwd, parentSession: SessionId(parentSession), origin: "subagent", delegationDepth: 1 },
  });
  session.append("turn/start", { turn: 1 });
  await ctx.sessions.flush(session);
}

function request(fixture: Fixture, rootSessionId: string) {
  return { sourceHome: fixture.oldHome, rootSessionId, sourceProcessesStopped: true as const };
}

function event(seq: number, type: "turn/start", data: { turn: number }) {
  return { seq: SessionSeq(seq), time: Date.now(), type, data } as const;
}

async function physicalSessionFiles(root: string): Promise<string[]> {
  return (await snapshotFiles(root)).filter(([name]) => /session\.jsonl/u.test(name)).map(([name]) => name);
}

async function snapshotFiles(root: string): Promise<Array<[string, string]>> {
  const output: Array<[string, string]> = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else output.push([name, createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex")]);
    }
  }
  await visit(root, "");
  return output.sort(([a], [b]) => a.localeCompare(b));
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("fixture wait timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
