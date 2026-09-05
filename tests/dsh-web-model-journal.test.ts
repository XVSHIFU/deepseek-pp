import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestJournal } from "../packages/dsh-web-model-transport/src/journal.ts";
import { type RequestAction, type RequestRecord } from "../packages/dsh-web-model-transport/src/request-state.ts";
import { DeepSeekWebModelHost } from "../packages/dsh-web-model-transport/src/host.ts";
import { FakeBrowserPeer, FAKE_EXTENSION_ORIGIN } from "./fixtures/harness-bridge/fake-peer/index.ts";
import { generateRequest, helloRequest, pairingToken } from "./fixtures/harness-bridge/protocol-v1/frames.ts";
import { decodeWebModelFrame, encodeWebModelFrame, validateWebModelFrame, type WebModelFrame } from "../packages/web-model-protocol/src/index.ts";

const directories: string[] = [];
const journals: RequestJournal[] = [];
const hosts: DeepSeekWebModelHost[] = [];
const peers: FakeBrowserPeer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(peers.splice(0).map(peer => peer.close()));
  await Promise.all(hosts.splice(0).map(host => host.stop()));
  await Promise.all(journals.splice(0).map(journal => journal.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-journal-")); directories.push(value); return value; }
async function open(location = directory(), maximum = 1024) {
  const journal = new RequestJournal(location, maximum);
  journals.push(journal);
  await journal.open();
  return { journal, location };
}
function apply(journal: RequestJournal, action: RequestAction): RequestRecord {
  const record = journal.get("request-1")!;
  return journal.apply(record.requestId, record.generation, record.revision, action);
}
function plan(journal: RequestJournal) { return journal.plan("request-1", "a".repeat(64), "session-1"); }
async function hostAt(journalPath: string) {
  const host = new DeepSeekWebModelHost({ journalPath, pairingToken, allowedOrigins: [FAKE_EXTENSION_ORIGIN], rpcTimeoutMs: 500 });
  hosts.push(host); await host.start();
  const peer = await FakeBrowserPeer.connect({ address: host.address, pairingToken }); peers.push(peer);
  return { host, peer };
}
async function collect(host: DeepSeekWebModelHost) {
  const request = validateWebModelFrame(structuredClone(generateRequest));
  if (!("method" in request) || request.method !== "model.generate") throw new Error("EXPECTED_GENERATE");
  const { schema_version: _version, ...input } = request.params;
  const events = [];
  for await (const event of host.generate(input)) events.push(event);
  return events;
}

describe("durable Host request journal", () => {
  it.each(["completed", "failed", "aborted", "ambiguous"] as const)("commits legal lifecycle and %s without any streamed body", async terminal => {
    const { journal, location } = await open();
    plan(journal);
    expect(apply(journal, { type: "dispatch" }).state).toBe("dispatched");
    expect(apply(journal, { type: "accept" }).state).toBe("accepted");
    expect(apply(journal, { type: "event", sequence: 1, event: { type: "text_delta", text: "PRIVATE_TEXT" } }).state).toBe("streaming");
    const event = terminal === "completed" ? { type: terminal, finish_reason: "stop" as const }
      : terminal === "failed" ? { type: terminal, error: { code: "PRIVATE_CODE", message: "PRIVATE_MESSAGE", retryable: false as const, external_outcome: "started" as const } }
      : { type: terminal, reason: "PRIVATE_REASON" };
    expect(apply(journal, { type: "event", sequence: 2, event }).state).toBe(terminal);
    const raw = fs.readFileSync(path.join(location, "journal.json"), "utf8");
    expect(raw).not.toContain("PRIVATE_");
    expect(JSON.parse(raw).records[0]).toMatchObject({ sequence: 2, remoteStatus: terminal, terminalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => apply(journal, { type: "event", sequence: 3, event: { type: "completed", finish_reason: "stop" } })).toThrow("JOURNAL_INVALID_TRANSITION");
  });

  it("rejects generation, revision, sequence and backwards transitions without changing durable bytes", async () => {
    const { journal, location } = await open();
    const planned = plan(journal);
    const raw = fs.readFileSync(path.join(location, "journal.json"), "utf8");
    expect(() => journal.apply(planned.requestId, 2, 0, { type: "dispatch" })).toThrow("JOURNAL_CAS_MISMATCH");
    expect(() => journal.apply(planned.requestId, 1, 1, { type: "dispatch" })).toThrow("JOURNAL_CAS_MISMATCH");
    expect(() => apply(journal, { type: "accept" })).toThrow("JOURNAL_INVALID_TRANSITION");
    expect(fs.readFileSync(path.join(location, "journal.json"), "utf8")).toBe(raw);
    apply(journal, { type: "dispatch" }); apply(journal, { type: "accept" });
    expect(() => apply(journal, { type: "event", sequence: 2, event: { type: "text_delta", text: "gap" } })).toThrow("JOURNAL_SEQUENCE_MISMATCH");
    expect(() => apply(journal, { type: "dispatch" })).toThrow("JOURNAL_INVALID_TRANSITION");
  });

  it.each(["planned", "dispatched", "accepted", "streaming", "completed"] as const)("reopens %s without inventing recovered stream content", async phase => {
    const { journal, location } = await open();
    plan(journal);
    if (phase !== "planned") apply(journal, { type: "dispatch" });
    if (["accepted", "streaming", "completed"].includes(phase)) apply(journal, { type: "accept" });
    if (["streaming", "completed"].includes(phase)) apply(journal, { type: "event", sequence: 1, event: { type: "text_delta", text: "lost" } });
    if (phase === "completed") apply(journal, { type: "event", sequence: 2, event: { type: "completed", finish_reason: "stop" } });
    await journal.close();
    const reopened = (await open(location)).journal;
    expect(reopened.get("request-1")?.state).toBe(phase === "completed" ? "completed" : "ambiguous");
    expect(() => plan(reopened)).toThrow("JOURNAL_REQUEST_EXISTS");
  });

  it("retains unknown and completed query metadata as ambiguous after lost streaming", async () => {
    const { journal } = await open(); plan(journal); apply(journal, { type: "dispatch" }); apply(journal, { type: "accept" });
    apply(journal, { type: "disconnect" });
    const base = { schema_version: 1 as const, type: "model.status" as const, request_id: "request-1", request_digest: "a".repeat(64) };
    expect(apply(journal, { type: "query", result: { ...base, status: "unknown", last_sequence: 0 } }).state).toBe("ambiguous");
    expect(apply(journal, { type: "query", result: { ...base, status: "completed", last_sequence: 20, terminal: { type: "completed", finish_reason: "stop" } } }).state).toBe("ambiguous");
    expect(() => plan(journal)).toThrow("JOURNAL_REQUEST_EXISTS");
  });

  it("matches terminal snapshots independently of JSON property insertion order", async () => {
    const { journal } = await open(); plan(journal); apply(journal, { type: "dispatch" }); apply(journal, { type: "accept" });
    apply(journal, { type: "event", sequence: 1, event: { type: "completed", finish_reason: "stop" } });
    expect(apply(journal, { type: "query", result: { schema_version: 1, type: "model.status", request_id: "request-1",
      request_digest: "a".repeat(64), status: "completed", last_sequence: 1, terminal: { finish_reason: "stop", type: "completed" } } }).state).toBe("completed");
  });

  it("quarantines a terminal observed only through query and can reopen its valid metadata", async () => {
    const { journal, location } = await open(); plan(journal); apply(journal, { type: "dispatch" }); apply(journal, { type: "accept" });
    expect(apply(journal, { type: "query", result: { schema_version: 1, type: "model.status", request_id: "request-1",
      request_digest: "a".repeat(64), status: "completed", last_sequence: 1, terminal: { type: "completed", finish_reason: "stop" } } }).state).toBe("ambiguous");
    await journal.close();
    expect((await open(location)).journal.get("request-1")).toMatchObject({ state: "ambiguous", remoteStatus: "completed", sequence: 1 });
  });

  it("permits a new generation only after explicit not_started and refuses a full ledger", async () => {
    const { journal } = await open(undefined, 1); plan(journal); apply(journal, { type: "dispatch" });
    apply(journal, { type: "not_started" });
    expect(plan(journal).generation).toBe(2);
    expect(() => journal.plan("request-2", "b".repeat(64), "session-2")).toThrow("JOURNAL_FULL");
    expect(journal.size).toBe(1);
  });

  it("persists cancellation intent and acknowledgment idempotently", async () => {
    const { journal, location } = await open(); plan(journal); apply(journal, { type: "dispatch" });
    const first = apply(journal, { type: "cancel" });
    expect(apply(journal, { type: "cancel" })).toBe(first);
    apply(journal, { type: "cancel_ack", status: "cancel_requested" });
    await journal.close();
    expect((await open(location)).journal.get("request-1")).toMatchObject({ state: "ambiguous", cancelRequested: true, cancelStatus: "cancel_requested" });
  });

  it.each(['{"schema_version":99,"records":[]}', '{"schema_version":1,"records":[],"checksum":"bad"}', '{broken'])("preserves corrupt or future files: %s", async raw => {
    const location = directory(); fs.writeFileSync(path.join(location, "journal.json"), raw);
    await expect(open(location)).rejects.toThrow();
    expect(fs.readFileSync(path.join(location, "journal.json"), "utf8")).toBe(raw);
  });

  it("refuses a live owner and a stale reclaim guard without deleting either", async () => {
    const { location } = await open();
    await expect(open(location)).rejects.toThrow("JOURNAL_OWNED");
    expect(fs.existsSync(path.join(location, "owner.lock"))).toBe(true);
    const other = directory(); fs.writeFileSync(path.join(other, "owner-reclaim.guard"), "preserve");
    await expect(open(other)).rejects.toThrow();
    expect(fs.readFileSync(path.join(other, "owner-reclaim.guard"), "utf8")).toBe("preserve");
  });

  it("reclaims only a proven exited process owner under the acquisition guard", async () => {
    const location = directory();
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 2000, windowsHide: true });
    expect(exited.status).toBe(0);
    fs.writeFileSync(path.join(location, "owner.lock"), JSON.stringify({ pid: exited.pid, nonce: "00000000-0000-0000-0000-000000000000" }));
    await expect(open(location)).resolves.toHaveProperty("journal");
  });

  it("does not publish an in-memory transition after fsync failure, and poisons later sends", async () => {
    const { journal, location } = await open(); plan(journal);
    const raw = fs.readFileSync(path.join(location, "journal.json"), "utf8");
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("DISK_FAILURE"); });
    expect(() => apply(journal, { type: "dispatch" })).toThrow("DISK_FAILURE");
    expect(journal.get("request-1")?.state).toBe("planned");
    expect(fs.readFileSync(path.join(location, "journal.json"), "utf8")).toBe(raw);
    expect(() => apply(journal, { type: "dispatch" })).toThrow("JOURNAL_UNAVAILABLE");
  });

  it("persists dispatched before real socket delivery and terminal before exposing success", async () => {
    const location = directory(); const { host, peer } = await hostAt(location);
    peer.enqueueGeneration(() => {
      expect(JSON.parse(fs.readFileSync(path.join(location, "journal.json"), "utf8")).records[0].state).toBe("dispatched");
      return { events: [{ type: "text_delta", text: "PRIVATE_RESULT" }, { type: "completed", finish_reason: "stop" }] };
    });
    await expect(collect(host)).resolves.toHaveLength(2);
    const raw = fs.readFileSync(path.join(location, "journal.json"), "utf8");
    expect(JSON.parse(raw).records[0]).toMatchObject({ state: "completed", sequence: 2 });
    expect(raw).not.toContain("PRIVATE_RESULT");
  });

  it("blocks a disk failure before dispatch and leaves the browser with no generate", async () => {
    const location = directory(); const { host, peer } = await hostAt(location);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("DISK_FAILURE"); });
    await expect(collect(host)).rejects.toMatchObject({ code: "JOURNAL_UNAVAILABLE", externalOutcome: "not_started" });
    expect(peer.observedGenerateRequests).toEqual([]);
  });

  it("automatically queries the original ID on restart and keeps unknown quarantined without replay", async () => {
    const { journal, location } = await open(); plan(journal); apply(journal, { type: "dispatch" }); apply(journal, { type: "accept" });
    await journal.close();
    const { host, peer } = await hostAt(location);
    await vi.waitFor(() => expect(host.hasAuthenticatedPeer).toBe(true));
    expect(peer.queryRequestCount).toBe(1);
    expect(peer.observedGenerateRequests).toEqual([]);
    await expect(collect(host)).rejects.toMatchObject({ code: "REQUEST_ALREADY_EXISTS", externalOutcome: "unknown" });
    expect(JSON.parse(fs.readFileSync(path.join(location, "journal.json"), "utf8")).records[0]).toMatchObject({ requestId: "request-1", state: "ambiguous" });
  });

  it("returns one ambiguous stream terminal when a real socket query observes completion ahead of the active stream", async () => {
    const location = directory();
    const host = new DeepSeekWebModelHost({ journalPath: location, pairingToken, allowedOrigins: [FAKE_EXTENSION_ORIGIN] });
    hosts.push(host); await host.start();
    const socket = new WebSocket(host.address.url, host.address.subprotocol, { origin: FAKE_EXTENSION_ORIGIN });
    sockets.push(socket);
    const frames: WebModelFrame[] = [];
    socket.on("message", data => frames.push(decodeWebModelFrame(data.toString())));
    socket.on("error", () => undefined);
    await once(socket, "open", { signal: AbortSignal.timeout(1000) });
    socket.send(encodeWebModelFrame(helloRequest));
    await vi.waitFor(() => expect(host.hasAuthenticatedPeer).toBe(true));
    const stream = collect(host);
    await vi.waitFor(() => expect(frames.some(frame => "method" in frame && frame.method === "model.generate")).toBe(true));
    const generate = frames.find(frame => "method" in frame && frame.method === "model.generate")!;
    if (!("method" in generate) || generate.method !== "model.generate") throw new Error("EXPECTED_GENERATE");
    const identity = { request_id: generate.params.request_id, request_digest: generate.params.request_digest };
    socket.send(encodeWebModelFrame({ jsonrpc: "2.0", id: generate.id, result: { schema_version: 1, type: "model.accepted", ...identity, status: "accepted" } }));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(location, "journal.json"), "utf8")).records[0].state).toBe("accepted"));
    const status = host.query(identity);
    await vi.waitFor(() => expect(frames.some(frame => "method" in frame && frame.method === "model.query")).toBe(true));
    const query = frames.find(frame => "method" in frame && frame.method === "model.query")!;
    if (!("method" in query) || query.method !== "model.query") throw new Error("EXPECTED_QUERY");
    socket.send(encodeWebModelFrame({ jsonrpc: "2.0", id: query.id, result: { schema_version: 1, type: "model.status", ...identity,
      status: "completed", last_sequence: 1, terminal: { type: "completed", finish_reason: "stop" } } }));
    await expect(status).resolves.toMatchObject({ status: "completed" });
    await expect(stream).resolves.toEqual([{ type: "ambiguous", reason: "status_without_stream" }]);
    socket.send(encodeWebModelFrame({ jsonrpc: "2.0", method: "model.event", params: { schema_version: 1, request_id: identity.request_id,
      sequence: 1, event: { type: "completed", finish_reason: "stop" } } }));
    await vi.waitFor(() => expect(host.hasAuthenticatedPeer).toBe(false));
    expect(JSON.parse(fs.readFileSync(path.join(location, "journal.json"), "utf8")).records[0]).toMatchObject({ state: "ambiguous", remoteStatus: "completed" });
  });
});
