import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { transitionRequest, type RequestAction, type RequestRecord } from "./request-state.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const RECORD_KEYS = new Set(["requestId", "requestDigest", "sessionId", "generation", "revision", "state", "outcome", "sequence", "remoteStatus", "terminalDigest", "cancelRequested", "cancelStatus"]);
const PHASES = ["planned", "dispatched", "accepted", "streaming", "completed", "failed", "aborted", "ambiguous"];

/** One bounded authoritative ledger. Synchronous commits precede every observable socket effect. */
export class RequestJournal {
  private records = new Map<string, RequestRecord>();
  private directory: string | undefined;
  private owner: number | undefined;
  private ownerIdentity: string | undefined;
  private poisoned = false;
  private opened = false;
  private readonly journalPath: string | undefined;
  private readonly maximum: number;

  constructor(journalPath?: string, maximum = 1024) {
    this.journalPath = journalPath;
    this.maximum = maximum;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024) throw new Error("INVALID_JOURNAL_LIMIT");
    if (journalPath !== undefined && !path.isAbsolute(journalPath)) throw new Error("JOURNAL_PATH_REQUIRED");
  }

  get size(): number { return this.records.size; }
  get(requestId: string): RequestRecord | undefined { return this.records.get(requestId); }
  recoverable(): readonly RequestRecord[] { return [...this.records.values()].filter(record => record.state === "ambiguous"); }

  async open(): Promise<void> {
    if (this.opened) throw new Error("JOURNAL_ALREADY_OPEN");
    if (this.journalPath !== undefined) {
      fs.mkdirSync(this.journalPath, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(this.journalPath).isSymbolicLink()) throw new Error("JOURNAL_SYMLINK");
      this.directory = fs.realpathSync(this.journalPath);
      try {
        this.acquireOwner();
        const filename = path.join(this.directory, "journal.json");
        if (fs.existsSync(filename)) {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("JOURNAL_INVALID");
          this.records = decodeJournal(fs.readFileSync(filename, "utf8"), this.maximum);
        }
      } catch (error) {
        await this.close();
        throw new Error(error instanceof Error && error.message.startsWith("JOURNAL_") ? error.message : "JOURNAL_UNAVAILABLE");
      }
    }
    this.opened = true;
    // Durable stream bytes are intentionally absent. Even planned records are
    // quarantined after a crash; only an explicit peer not_started permits retry.
    const recovered = new Map(this.records);
    for (const [id, record] of recovered) recovered.set(id, transitionRequest(record, record.generation, record.revision, { type: "disconnect" }));
    this.commit(recovered);
  }

  plan(requestId: string, requestDigest: string, sessionId: string): RequestRecord {
    this.assertReady();
    const previous = this.records.get(requestId);
    if (previous && (previous.requestDigest !== requestDigest || previous.sessionId !== sessionId)) throw new Error("JOURNAL_IDENTITY_MISMATCH");
    if (previous && (previous.state !== "failed" || previous.outcome !== "not_started")) throw new Error("JOURNAL_REQUEST_EXISTS");
    if (!previous && this.records.size >= this.maximum) throw new Error("JOURNAL_FULL");
    const record: RequestRecord = { requestId, requestDigest, sessionId, generation: (previous?.generation ?? 0) + 1,
      revision: 0, state: "planned", outcome: "not_started", sequence: 0, cancelRequested: false };
    validateRecord(record);
    const next = new Map(this.records);
    next.set(requestId, Object.freeze(record));
    this.commit(next);
    return this.records.get(requestId)!;
  }

  apply(requestId: string, generation: number, revision: number, action: RequestAction): RequestRecord {
    this.assertReady();
    const current = this.records.get(requestId);
    if (!current) throw new Error("JOURNAL_UNKNOWN_REQUEST");
    const updated = transitionRequest(current, generation, revision, action);
    if (updated === current) return current;
    const next = new Map(this.records);
    next.set(requestId, Object.freeze(updated));
    this.commit(next);
    return this.records.get(requestId)!;
  }

  async close(): Promise<void> {
    if (this.owner !== undefined) {
      fs.closeSync(this.owner);
      this.owner = undefined;
      this.withOwnerGuard(() => {
        const filename = path.join(this.directory!, "owner.lock");
        if (fs.readFileSync(filename, "utf8") !== this.ownerIdentity) throw new Error("JOURNAL_OWNER_CHANGED");
        fs.unlinkSync(filename);
      });
    }
    this.opened = false;
  }

  private withOwnerGuard(action: () => void): void {
    const guardPath = path.join(this.directory!, "owner-reclaim.guard");
    // A crash during this short critical section deliberately leaves the guard:
    // never steal an unknown/live owner's lock based on elapsed wall time.
    let guard: number;
    try { guard = fs.openSync(guardPath, "wx", 0o600); }
    catch { throw new Error("JOURNAL_OWNER_GUARD_UNAVAILABLE"); }
    try { action(); } finally { fs.closeSync(guard); fs.unlinkSync(guardPath); }
  }

  private acquireOwner(): void {
    this.withOwnerGuard(() => {
      const filename = path.join(this.directory!, "owner.lock");
      if (fs.existsSync(filename)) {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("JOURNAL_OWNER_INVALID");
        const before = fs.readFileSync(filename, "utf8");
        const owner: unknown = JSON.parse(before);
        if (!owner || typeof owner !== "object" || !("pid" in owner) || !("nonce" in owner)
          || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.nonce !== "string"
          || !/^[a-f0-9-]{36}$/.test(owner.nonce)) throw new Error("JOURNAL_OWNER_INVALID");
        let dead = false;
        try { process.kill(Number(owner.pid), 0); } catch (error) {
          dead = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
        if (!dead) throw new Error("JOURNAL_OWNED");
        if (fs.readFileSync(filename, "utf8") !== before) throw new Error("JOURNAL_OWNER_CHANGED");
        fs.unlinkSync(filename);
      }
      this.owner = fs.openSync(filename, "wx", 0o600);
      this.ownerIdentity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
      fs.writeFileSync(this.owner, this.ownerIdentity);
      fs.fsyncSync(this.owner);
    });
  }

  private assertReady(): void {
    if (!this.opened || this.poisoned) throw new Error("JOURNAL_UNAVAILABLE");
  }

  private commit(records: Map<string, RequestRecord>): void {
    this.assertReady();
    if (this.directory) {
      const payload = { schema_version: 1, records: [...records.values()] };
      const encoded = JSON.stringify({ ...payload, checksum: digest(JSON.stringify(payload)) });
      if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw new Error("JOURNAL_FULL");
      const temporary = path.join(this.directory, `journal-${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(descriptor, encoded, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, path.join(this.directory, "journal.json"));
        // Windows does not expose directory fsync through Node. The file itself
        // is flushed before atomic rename; Linux also flushes the directory.
        if (process.platform !== "win32") {
          const directory = fs.openSync(this.directory, "r");
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
      } catch (error) {
        this.poisoned = true;
        throw error;
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
    this.records = records;
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validateRecord(value: unknown): asserts value is RequestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOURNAL_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !RECORD_KEYS.has(key))) throw new Error("JOURNAL_INVALID");
  for (const key of ["requestId", "sessionId"]) if (typeof record[key] !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(record[key])) throw new Error("JOURNAL_INVALID");
  if (typeof record.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.requestDigest)) throw new Error("JOURNAL_INVALID");
  for (const key of ["generation", "revision", "sequence"]) if (!Number.isSafeInteger(record[key]) || Number(record[key]) < (key === "generation" ? 1 : 0)) throw new Error("JOURNAL_INVALID");
  if (!PHASES.includes(String(record.state)) || !["not_started", "started", "unknown"].includes(String(record.outcome)) || typeof record.cancelRequested !== "boolean") throw new Error("JOURNAL_INVALID");
  if (record.remoteStatus !== undefined && !PHASES.slice(2).includes(String(record.remoteStatus))) throw new Error("JOURNAL_INVALID");
  if (record.terminalDigest !== undefined && (typeof record.terminalDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.terminalDigest))) throw new Error("JOURNAL_INVALID");
  if (record.cancelStatus !== undefined && !["cancel_requested", "already_terminal", "not_found"].includes(String(record.cancelStatus))) throw new Error("JOURNAL_INVALID");
  if (record.cancelStatus !== undefined && !record.cancelRequested) throw new Error("JOURNAL_INVALID");
  if (record.state === "planned" && (record.outcome !== "not_started" || record.sequence !== 0 || record.remoteStatus !== undefined)) throw new Error("JOURNAL_INVALID");
  if (record.state === "dispatched" && (record.outcome !== "unknown" || record.sequence !== 0 || record.remoteStatus !== undefined)) throw new Error("JOURNAL_INVALID");
  if (record.state === "accepted" && (record.outcome !== "started" || record.sequence !== 0 || record.remoteStatus !== "accepted")) throw new Error("JOURNAL_INVALID");
  if (record.state === "streaming" && (record.outcome !== "started" || Number(record.sequence) < 1 || record.remoteStatus !== "streaming")) throw new Error("JOURNAL_INVALID");
  if (record.outcome === "not_started" && record.state !== "planned" && (record.state !== "failed" || record.sequence !== 0 || record.remoteStatus !== undefined)) throw new Error("JOURNAL_INVALID");
  if (["completed", "failed", "aborted"].includes(String(record.state)) && record.outcome !== "not_started"
    && (record.outcome !== "started" || record.remoteStatus !== record.state || record.terminalDigest === undefined || Number(record.sequence) < 1)) throw new Error("JOURNAL_INVALID");
  if (record.remoteStatus === "accepted" && record.sequence !== 0) throw new Error("JOURNAL_INVALID");
  if (record.remoteStatus === "streaming" && Number(record.sequence) < 1) throw new Error("JOURNAL_INVALID");
  if (["completed", "failed", "aborted", "ambiguous"].includes(String(record.remoteStatus)) && (record.terminalDigest === undefined || Number(record.sequence) < 1)) throw new Error("JOURNAL_INVALID");
}
function decodeJournal(encoded: string, maximum: number): Map<string, RequestRecord> {
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOURNAL_INVALID");
  const envelope = value as Record<string, unknown>;
  if (envelope.schema_version !== 1) throw new Error("JOURNAL_UNSUPPORTED_VERSION");
  if (Object.keys(envelope).sort().join() !== "checksum,records,schema_version" || !Array.isArray(envelope.records) || envelope.records.length > maximum) throw new Error("JOURNAL_INVALID");
  if (envelope.checksum !== digest(JSON.stringify({ schema_version: 1, records: envelope.records }))) throw new Error("JOURNAL_CHECKSUM_MISMATCH");
  const records = new Map<string, RequestRecord>();
  for (const entry of envelope.records) {
    validateRecord(entry);
    if (records.has(entry.requestId)) throw new Error("JOURNAL_INVALID");
    records.set(entry.requestId, Object.freeze(entry));
  }
  return records;
}
