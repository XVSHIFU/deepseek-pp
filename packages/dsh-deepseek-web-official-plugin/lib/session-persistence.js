// src/session-persistence.ts
import z from "@deepseek-ai/schemastery";

// src/session-import.ts
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import {
  SessionStore
} from "@deepseek-ai/dsh-session";
import {
  JsonlSessionPersistence
} from "@deepseek-ai/dsh-session-persistence-jsonl";
var JOURNAL_VERSION = 1;
var MAX_IMPORT_SESSIONS = 1e3;
var MAX_IMPORT_BYTES = 512 * 1024 * 1024;
var ACTIVE_JOURNAL = "active.json";
var ImportingJsonlSessionPersistence = class extends JsonlSessionPersistence {
  constructor(ctx, config, importRoot, deniedIds, testHooks) {
    super(ctx, config);
    this.importRoot = importRoot;
    this.testHooks = testHooks;
    this.deniedIds = new Set(deniedIds);
    this.sessionImport = Object.freeze({
      importCompleted: (request, signal) => this.serializeImport(() => withFileLock(
        join(this.importRoot, "transaction"),
        () => this.importCompleted(request, signal),
        { waitMs: 5e3 }
      )),
      isImportedSessionDenied: (sessionId) => this.preparedIds.has(sessionId) || this.deniedIds.has(sessionId)
    });
  }
  importRoot;
  testHooks;
  sessionImport;
  preparedIds = /* @__PURE__ */ new Set();
  deniedIds;
  importTail = Promise.resolve();
  async create(meta, inheritedEventCount) {
    await this.waitForPreparedId(String(meta.id));
    return super.create(meta, inheritedEventCount);
  }
  async ensureMaterialized(session) {
    await this.waitForPreparedId(String(session.id));
    return super.ensureMaterialized(session);
  }
  async append(id, events) {
    await this.waitForPreparedId(String(id));
    return super.append(id, events);
  }
  async prepare(id, signal) {
    await this.waitForPreparedId(String(id), signal);
    return super.prepare(id, signal);
  }
  async load(id) {
    await this.waitForPreparedId(String(id));
    return super.load(id);
  }
  async inspect(id, signal) {
    await this.waitForPreparedId(String(id), signal);
    return super.inspect(id, signal);
  }
  async borrowSession(id, signal) {
    await this.waitForPreparedId(String(id), signal);
    return super.borrowSession(id, signal);
  }
  async readFrom(id, fromSeq, signal) {
    await this.waitForPreparedId(String(id), signal);
    return super.readFrom(id, fromSeq, signal);
  }
  async readRaw(id, signal) {
    await this.waitForPreparedId(String(id), signal);
    return super.readRaw(id, signal);
  }
  async list(signal) {
    const headers = await super.list(signal);
    return headers.filter((header) => !this.preparedIds.has(String(header.id)));
  }
  async listSnapshots(signal) {
    const snapshots = await super.listSnapshots(signal);
    return snapshots.filter((snapshot) => !this.preparedIds.has(String(snapshot.header.id)));
  }
  async waitForPreparedId(id, signal) {
    while (this.preparedIds.has(id)) await abortable(this.importTail, signal);
  }
  serializeImport(operation) {
    const result = this.importTail.then(operation, operation);
    this.importTail = result.then(() => void 0, () => void 0);
    return result;
  }
  async importCompleted(request, signal) {
    validateRequest(request);
    signal?.throwIfAborted();
    const sourceLease = await validateStandaloneHome(request.sourceHome);
    const sourceSessionsRoot = sourceLease.sessionsRoot;
    const targetSessionsRoot = resolve(this.config.root);
    let source;
    const transactionId = randomUUID();
    const stagingSessionsRoot = join(this.importRoot, "staging", transactionId, "sessions");
    let staging;
    const claimedIds = [];
    try {
      await assertSeparateTrees(sourceSessionsRoot, targetSessionsRoot, this.importRoot);
      source = await openPersistence(sourceSessionsRoot, "none");
      const selected = await selectCompletedGroup(source.persistence, request.rootSessionId, signal);
      if (selected.length > MAX_IMPORT_SESSIONS) throw new Error("SESSION_IMPORT_GROUP_TOO_LARGE");
      for (const item of selected) {
        const id = String(item.inspection.meta.id);
        this.preparedIds.add(id);
        claimedIds.push(id);
      }
      assertNoTargetLiveSessions(this.ctx, selected);
      const targetSnapshots = new Map((await super.listSnapshots(signal)).map((item) => [String(item.header.id), item]));
      const targetInspections = /* @__PURE__ */ new Map();
      for (const sourceItem of selected) {
        const target = targetSnapshots.get(String(sourceItem.inspection.meta.id));
        if (target !== void 0) targetInspections.set(String(target.header.id), await super.inspect(target.header.id, signal));
      }
      staging = await openPersistence(stagingSessionsRoot, this.config.compression ?? "zstd");
      const entries = [];
      let importedBytes = 0;
      for (const sourceItem of selected) {
        signal?.throwIfAborted();
        const id = String(sourceItem.inspection.meta.id);
        const digest = inspectionDigest(sourceItem.inspection);
        const existing = targetInspections.get(id);
        if (existing !== void 0) {
          if (inspectionDigest(existing) !== digest) throw new Error(`SESSION_IMPORT_CONFLICT:${id}`);
          entries.push({
            id,
            digest,
            artifactDigest: await fileDigest(requireJsonlLocation(super.locate(sourceItem.inspection.meta)).path),
            finalArtifact: requireJsonlLocation(super.locate(sourceItem.inspection.meta)).path,
            stagingArtifact: "",
            sourceRevision: sourceItem.revision,
            idempotent: true
          });
          continue;
        }
        await staging.persistence.create(sourceItem.inspection.meta, sourceItem.inspection.inheritedEventCount);
        await staging.persistence.append(sourceItem.inspection.meta.id, sourceItem.inspection.events);
        const raw = await staging.persistence.readRaw(sourceItem.inspection.meta.id, signal);
        if (raw === void 0) throw new Error(`SESSION_IMPORT_STAGING_MISSING:${id}`);
        importedBytes += Buffer.byteLength(raw.content, "utf8");
        if (importedBytes > MAX_IMPORT_BYTES) throw new Error("SESSION_IMPORT_GROUP_TOO_LARGE");
        entries.push({
          id,
          digest,
          artifactDigest: createHash("sha256").update(await readFile(requireJsonlLocation(staging.persistence.locate(sourceItem.inspection.meta)).path)).digest("hex"),
          finalArtifact: requireJsonlLocation(super.locate(sourceItem.inspection.meta)).path,
          stagingArtifact: requireJsonlLocation(staging.persistence.locate(sourceItem.inspection.meta)).path,
          sourceRevision: sourceItem.revision,
          idempotent: false
        });
      }
      await assertSourceRevisions(source.persistence, entries, signal);
      const journal = {
        version: JOURNAL_VERSION,
        transactionId,
        sourceSessionsRoot,
        targetSessionsRoot,
        rootSessionId: request.rootSessionId,
        entries
      };
      await this.testHooks?.beforePrepareJournal?.();
      try {
        await writePreparedJournal(this.importRoot, journal);
        await assertSourceRevisions(source.persistence, entries, signal);
        let publishIndex = 0;
        for (const entry of entries) {
          if (entry.idempotent) continue;
          signal?.throwIfAborted();
          await publishSessionDirectory(entry, targetSessionsRoot);
          await this.testHooks?.afterPublish?.({ id: entry.id, index: publishIndex++ });
        }
        await publishCommittedMarker(this.importRoot, journal);
        for (const entry of entries) this.deniedIds.add(entry.id);
      } catch (error) {
        await recoverPreparedJournal(this.importRoot, targetSessionsRoot).catch((recoveryError) => {
          throw new AggregateError([error, recoveryError], "SESSION_IMPORT_RECOVERY_FAILED");
        });
        throw error;
      }
      for (const entry of entries) this.preparedIds.delete(entry.id);
      await rm(join(this.importRoot, "staging", transactionId), { recursive: true, force: true });
      return Object.freeze({
        transactionId,
        rootSessionId: request.rootSessionId,
        sessionIds: Object.freeze(entries.map((entry) => entry.id)),
        imported: entries.filter((entry) => !entry.idempotent).length,
        idempotent: entries.filter((entry) => entry.idempotent).length
      });
    } finally {
      for (const id of claimedIds) this.preparedIds.delete(id);
      const failures = [];
      for (const cleanup of [
        () => staging?.dispose() ?? Promise.resolve(),
        () => rm(join(this.importRoot, "staging", transactionId), { recursive: true, force: true }),
        () => source?.dispose() ?? Promise.resolve(),
        () => sourceLease.release()
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "SESSION_IMPORT_CLEANUP_FAILED");
    }
  }
};
async function selectCompletedGroup(persistence, rootId, signal) {
  const snapshots = await persistence.listSnapshots(signal);
  const byId = new Map(snapshots.map((item) => [String(item.header.id), item]));
  const root = byId.get(rootId);
  if (root === void 0) throw new Error("SESSION_IMPORT_ROOT_NOT_FOUND");
  if (root.header.parentSession !== void 0 || root.header.origin === "subagent") {
    throw new Error("SESSION_IMPORT_ROOT_REQUIRED");
  }
  const children = /* @__PURE__ */ new Map();
  for (const item of snapshots) {
    const parent = item.header.parentSession;
    if (parent === void 0) continue;
    const key = String(parent);
    const values = children.get(key) ?? [];
    values.push(String(item.header.id));
    children.set(key, values);
  }
  const ordered = [];
  const visiting = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("SESSION_IMPORT_LINEAGE_CYCLE");
    if (ordered.includes(id)) return;
    visiting.add(id);
    ordered.push(id);
    for (const child of (children.get(id) ?? []).sort()) visit(child);
    visiting.delete(id);
  };
  visit(rootId);
  const result = [];
  for (const id of ordered) {
    signal?.throwIfAborted();
    const snapshot = byId.get(id);
    if (snapshot === void 0) throw new Error(`SESSION_IMPORT_DESCENDANT_MISSING:${id}`);
    const inspection = await persistence.inspect(snapshot.header.id, signal);
    assertCompleted(inspection, id);
    result.push({ inspection, revision: String(snapshot.revision) });
  }
  return result;
}
function assertCompleted(inspection, id) {
  const events = inspection.events.filter((event) => event.type !== "session/end-seed");
  const last = events.at(-1);
  if (last?.type !== "turn/end" || last.data.reason.kind !== "completed") {
    throw new Error(`SESSION_IMPORT_NOT_COMPLETED:${id}`);
  }
  const openTurns = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.type === "turn/start") openTurns.add(event.data.turn);
    if (event.type === "turn/end") {
      openTurns.delete(event.data.turn);
      if (event.data.reason.kind === "interrupted") throw new Error(`SESSION_IMPORT_AMBIGUOUS:${id}`);
    }
  }
  if (openTurns.size > 0) throw new Error(`SESSION_IMPORT_UNFINISHED:${id}`);
}
async function assertSourceRevisions(persistence, entries, signal) {
  const current = new Map((await persistence.listSnapshots(signal)).map((item) => [String(item.header.id), String(item.revision)]));
  for (const entry of entries) {
    if (current.get(entry.id) !== entry.sourceRevision) throw new Error(`SESSION_IMPORT_SOURCE_CHANGED:${entry.id}`);
  }
}
function assertNoTargetLiveSessions(ctx, selected) {
  for (const item of selected) {
    if (ctx.sessions.get(item.inspection.meta.id) !== void 0) {
      throw new Error(`SESSION_IMPORT_TARGET_ACTIVE:${String(item.inspection.meta.id)}`);
    }
  }
}
function inspectionDigest(value) {
  return createHash("sha256").update(stableJson({
    meta: value.meta,
    inheritedEventCount: value.inheritedEventCount,
    events: value.events
  })).digest("hex");
}
async function openPersistence(root, compression) {
  const context = new Context();
  const fibers = [];
  try {
    fibers.push(await context.plugin(SessionStore));
    fibers.push(await context.plugin(JsonlSessionPersistence, { root, compression, packChunks: false }));
    return {
      context,
      persistence: context.sessionPersistence,
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose();
      }
    };
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    throw error;
  }
}
async function recoverSessionImports(importRoot, targetSessionsRoot) {
  const resolvedImportRoot = resolve(importRoot);
  const resolvedTargetRoot = resolve(targetSessionsRoot);
  await mkdir(join(resolvedImportRoot, "committed"), { recursive: true });
  await mkdir(join(resolvedImportRoot, "staging"), { recursive: true });
  await recoverPreparedJournal(resolvedImportRoot, resolvedTargetRoot);
  const denied = /* @__PURE__ */ new Set();
  const { readdir } = await import("node:fs/promises");
  for (const filename of await readdir(join(resolvedImportRoot, "committed"))) {
    if (!filename.endsWith(".json")) continue;
    const journal = parseJournal(await readFile(join(resolvedImportRoot, "committed", filename), "utf8"));
    if (journal.targetSessionsRoot !== resolvedTargetRoot) throw new Error("SESSION_IMPORT_TARGET_ROOT_CHANGED");
    for (const entry of journal.entries) denied.add(entry.id);
    await rm(join(resolvedImportRoot, "staging", journal.transactionId), { recursive: true, force: true });
  }
  return denied;
}
async function recoverPreparedJournal(importRoot, targetSessionsRoot) {
  const activePath = join(importRoot, ACTIVE_JOURNAL);
  let journal;
  try {
    journal = parseJournal(await readFile(activePath, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (journal.targetSessionsRoot !== resolve(targetSessionsRoot)) throw new Error("SESSION_IMPORT_TARGET_ROOT_CHANGED");
  const committedPath = join(importRoot, "committed", `${journal.transactionId}.json`);
  try {
    const committed = parseJournal(await readFile(committedPath, "utf8"));
    if (stableJson(committed) !== stableJson(journal)) throw new Error("SESSION_IMPORT_COMMIT_MARKER_CONFLICT");
    await unlink(activePath);
    if (process.platform !== "win32") await syncDirectory(importRoot);
    await rm(join(importRoot, "staging", journal.transactionId), { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  for (const entry of [...journal.entries].reverse()) {
    if (entry.idempotent) continue;
    assertWithin(targetSessionsRoot, entry.finalArtifact);
    assertWithin(importRoot, entry.stagingArtifact);
    try {
      const raw = await readFile(entry.finalArtifact);
      const digest = createHash("sha256").update(raw).digest("hex");
      if (digest !== entry.artifactDigest) {
        throw new Error(`SESSION_IMPORT_ROLLBACK_CONFLICT:${entry.id}`);
      }
      await rm(dirname(entry.finalArtifact), { recursive: true, force: false });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  await rm(join(importRoot, "staging", journal.transactionId), { recursive: true, force: true });
  await unlink(activePath);
}
async function writePreparedJournal(importRoot, journal) {
  await mkdir(join(importRoot, "committed"), { recursive: true });
  await mkdir(join(importRoot, "staging"), { recursive: true });
  const activePath = join(importRoot, ACTIVE_JOURNAL);
  try {
    await lstat(activePath);
    throw new Error("SESSION_IMPORT_RECOVERY_REQUIRED");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporary = join(importRoot, `.active.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 384);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await durableRenameNoReplace(temporary, activePath);
  } catch (error) {
    await unlink(temporary).catch(() => void 0);
    throw error;
  }
}
async function publishSessionDirectory(entry, targetRoot) {
  assertWithin(targetRoot, entry.finalArtifact);
  const targetDirectory = dirname(entry.finalArtifact);
  await assertNoSymlinkPath(targetRoot);
  await mkdir(dirname(targetDirectory), { recursive: true });
  await assertNoSymlinkPath(dirname(targetDirectory));
  try {
    await lstat(targetDirectory);
    throw new Error(`SESSION_IMPORT_TARGET_CHANGED:${entry.id}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await mkdir(targetDirectory);
  try {
    await link(entry.stagingArtifact, entry.finalArtifact);
    const artifact = await open(entry.finalArtifact, "r+");
    try {
      await artifact.sync();
    } finally {
      await artifact.close();
    }
    if (process.platform !== "win32") await syncDirectory(targetDirectory);
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true });
    throw error;
  }
}
async function publishCommittedMarker(importRoot, journal) {
  const activePath = join(importRoot, ACTIVE_JOURNAL);
  const committedPath = join(importRoot, "committed", `${journal.transactionId}.json`);
  await durableRenameNoReplace(activePath, committedPath);
}
async function durableRenameNoReplace(source, destination) {
  await link(source, destination);
  if (process.platform !== "win32") await syncDirectory(dirname(destination));
  await unlink(source);
  if (process.platform !== "win32" && dirname(source) !== dirname(destination)) {
    await syncDirectory(dirname(source));
  }
}
async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function fileDigest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function requireJsonlLocation(location) {
  if (location?.kind !== "jsonl" || !isAbsolute(location.path)) throw new Error("SESSION_IMPORT_JSONL_REQUIRED");
  return location;
}
function validateRequest(request) {
  if (!isAbsolute(request.sourceHome)) throw new Error("SESSION_IMPORT_SOURCE_HOME_ABSOLUTE_REQUIRED");
  if (request.sourceProcessesStopped !== true) throw new Error("SESSION_IMPORT_SOURCE_STOP_CONFIRMATION_REQUIRED");
  if (request.rootSessionId.length === 0 || request.rootSessionId.length > 256) throw new Error("SESSION_IMPORT_SESSION_ID_INVALID");
}
async function assertSeparateTrees(source, target, importRoot) {
  const canonical = async (value) => {
    try {
      return await realpath(value);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      return resolve(value);
    }
  };
  const [sourcePath, targetPath, transactionPath] = await Promise.all([canonical(source), canonical(target), canonical(importRoot)]);
  if (overlaps(sourcePath, targetPath) || overlaps(sourcePath, transactionPath) || overlaps(targetPath, transactionPath)) {
    throw new Error("SESSION_IMPORT_PATHS_OVERLAP");
  }
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isDirectory()) throw new Error("SESSION_IMPORT_SOURCE_NOT_DIRECTORY");
  await Promise.all([assertNoSymlinkPath(target), assertNoSymlinkPath(importRoot)]);
  const [targetDevice, importDevice] = await Promise.all([stat(target), stat(importRoot)]);
  if (targetDevice.dev !== importDevice.dev) throw new Error("SESSION_IMPORT_CROSS_VOLUME_DENIED");
}
async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("SESSION_IMPORT_LINK_PATH_DENIED");
  }
}
async function validateStandaloneHome(sourceHome) {
  const home = resolve(sourceHome);
  await assertNoLinks(home, [
    ".deepseek-web-agent-owner.json",
    "active.json",
    ".versions",
    "state",
    "state/sessions",
    "state/profiles/deepseek-web-agent/web-model-journal"
  ]);
  const owner = await readJsonObject(join(home, ".deepseek-web-agent-owner.json"));
  if (!exactKeys(owner, ["schema_version", "product"]) || owner.schema_version !== 1 || owner.product !== "deepseek-pp-web-agent") {
    throw new Error("SESSION_IMPORT_SOURCE_NOT_STANDALONE");
  }
  const active = await readJsonObject(join(home, "active.json"));
  if (!exactKeys(active, ["schema_version", "distribution_sha256", "version_directory"]) || active.schema_version !== 1 || typeof active.distribution_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(active.distribution_sha256) || typeof active.version_directory !== "string" || !/^[a-f0-9]{64}-[a-f0-9]{16}$/u.test(active.version_directory) || !active.version_directory.startsWith(`${active.distribution_sha256}-`)) {
    throw new Error("SESSION_IMPORT_SOURCE_ACTIVE_INVALID");
  }
  const versionRoot = join(home, ".versions", active.version_directory);
  await assertNoLinks(home, [
    `.versions/${active.version_directory}`,
    `.versions/${active.version_directory}/owner.json`,
    `.versions/${active.version_directory}/runtime`,
    `.versions/${active.version_directory}/runtime/distribution.json`
  ]);
  const versionOwner = await readJsonObject(join(versionRoot, "owner.json"));
  if (!exactKeys(versionOwner, ["schema_version", "product"]) || versionOwner.schema_version !== 1 || versionOwner.product !== "deepseek-pp-web-agent") {
    throw new Error("SESSION_IMPORT_SOURCE_VERSION_NOT_OWNED");
  }
  const distributionBytes = await readFile(join(versionRoot, "runtime", "distribution.json"));
  const distribution = JSON.parse(distributionBytes.toString("utf8"));
  if (!isRecord(distribution) || distribution.schema_version !== 1 || distribution.harness_version !== "0.1.2-rc.1" || createHash("sha256").update(distributionBytes).digest("hex") !== active.distribution_sha256) {
    throw new Error("SESSION_IMPORT_SOURCE_DISTRIBUTION_INVALID");
  }
  for (const lockPath of [join(home, "state", "profiles", "deepseek-web-agent", "web-model-journal", "owner.lock")]) {
    try {
      await lstat(lockPath);
      throw new Error("SESSION_IMPORT_SOURCE_BUSY");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  const sessionsRoot = join(home, "state", "sessions");
  if (!(await stat(sessionsRoot)).isDirectory()) throw new Error("SESSION_IMPORT_SOURCE_SESSIONS_INVALID");
  const canonicalSessionsRoot = await realpath(sessionsRoot);
  const installationLock = join(home, ".installation.lock");
  let handle;
  try {
    handle = await open(installationLock, "wx", 384);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new Error("SESSION_IMPORT_SOURCE_BUSY", { cause: error });
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      schema_version: 1,
      product: "deepseek-pp-web-agent",
      pid: process.pid,
      operation: "session-import"
    })}
`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(installationLock).catch(() => void 0);
    throw error;
  }
  const lockIdentity = await handle.stat({ bigint: true });
  let released = false;
  return {
    sessionsRoot: canonicalSessionsRoot,
    release: async () => {
      if (released) return;
      released = true;
      await handle.close();
      const current = await lstat(installationLock, { bigint: true });
      if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
        throw new Error("SESSION_IMPORT_SOURCE_LOCK_REPLACED");
      }
      await unlink(installationLock);
    }
  };
}
async function assertNoLinks(home, children) {
  const root = parse(home).root;
  for (const child of ["", ...children]) {
    const candidate = child === "" ? home : join(home, child);
    let current = root;
    for (const part of relative(root, candidate).split(/[\\/]/u).filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("SESSION_IMPORT_SOURCE_LINK_DENIED");
    }
  }
}
async function readJsonObject(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("SESSION_IMPORT_SOURCE_METADATA_INVALID", { cause: error });
  }
  if (!isRecord(value)) throw new Error("SESSION_IMPORT_SOURCE_METADATA_INVALID");
  return value;
}
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function overlaps(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || !leftToRight.startsWith("..") && !isAbsolute(leftToRight) || !rightToLeft.startsWith("..") && !isAbsolute(rightToLeft);
}
function assertWithin(root, candidate) {
  const delta = relative(resolve(root), resolve(candidate));
  if (delta === "" || delta.startsWith("..") || isAbsolute(delta)) throw new Error("SESSION_IMPORT_TARGET_OUTSIDE_ROOT");
}
function parseJournal(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("SESSION_IMPORT_JOURNAL_INVALID", { cause: error });
  }
  if (!isRecord(value) || !exactKeys(value, ["version", "transactionId", "sourceSessionsRoot", "targetSessionsRoot", "rootSessionId", "entries"]) || value.version !== JOURNAL_VERSION || typeof value.transactionId !== "string" || !/^[a-f0-9-]{36}$/u.test(value.transactionId) || typeof value.sourceSessionsRoot !== "string" || typeof value.targetSessionsRoot !== "string" || !isAbsolute(value.sourceSessionsRoot) || !isAbsolute(value.targetSessionsRoot) || typeof value.rootSessionId !== "string" || value.rootSessionId.length === 0 || !Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > MAX_IMPORT_SESSIONS) {
    throw new Error("SESSION_IMPORT_JOURNAL_INVALID");
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["id", "digest", "artifactDigest", "finalArtifact", "stagingArtifact", "sourceRevision", "idempotent"]) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 256 || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.digest) || typeof entry.artifactDigest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.artifactDigest) || typeof entry.finalArtifact !== "string" || typeof entry.stagingArtifact !== "string" || !isAbsolute(entry.finalArtifact) || !entry.idempotent && !isAbsolute(entry.stagingArtifact) || typeof entry.sourceRevision !== "string" || typeof entry.idempotent !== "boolean") {
      throw new Error("SESSION_IMPORT_JOURNAL_INVALID");
    }
    return entry;
  });
  return { ...value, version: 1, entries };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function abortable(promise, signal) {
  if (signal === void 0) return promise;
  signal.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort));
  });
}

// src/session-persistence.ts
var inject = ["sessions"];
var Config = z.object({
  root: z.string().required(),
  importRoot: z.string().required(),
  compression: z.union([z.const("none"), z.const("zstd")]).default("zstd"),
  packChunks: z.boolean().default(true),
  preparedSessionCacheSize: z.number().step(1).min(1).default(5),
  writeBatchMaxDelayMs: z.number().step(1).min(1).default(200)
});
async function apply(ctx, config) {
  const denied = await recoverSessionImports(config.importRoot, config.root);
  const persistence = new ImportingJsonlSessionPersistence(ctx, {
    root: config.root,
    compression: config.compression ?? "zstd",
    packChunks: config.packChunks ?? true,
    preparedSessionCacheSize: config.preparedSessionCacheSize ?? 5,
    writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? 200
  }, config.importRoot, denied);
  const unprovide = ctx.provide("deepseekWebSessionImport", persistence.sessionImport);
  return async () => {
    await unprovide();
  };
}
export {
  Config,
  apply,
  inject
};
