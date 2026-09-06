// @vitest-environment node
import { once } from "node:events";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createPairingToken, type BrokerGenerateRequest } from "@deepseek-pp/dsh-web-model-transport";
import { MAX_FRAME_BYTES, encodeWebModelFrame } from "@deepseek-pp/web-model-protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import * as WorkspaceFiles from "../../packages/dsh-web-agent-bundle/src/workspace-files-policy";
import { createMutationFixture } from "../fixtures/dsh-web-agent/mutation/runtime";
import { FAKE_EXTENSION_ORIGIN } from "../fixtures/harness-bridge/fake-peer/index";
import { helloRequest, generateRequest } from "../fixtures/harness-bridge/protocol-v1/frames";
import { authenticate, collect, openSocket, securityHost } from "../fixtures/harness-bridge/security/host";

const { assertPayloadPolicy, checkDistributionPolicy, main: policyMain } = await import(
  new URL("../../scripts/harness-release-policy-check.mjs", import.meta.url).href,
) as {
  assertPayloadPolicy(path: string, bytes: Buffer): number;
  checkDistributionPolicy(directory: string): Promise<unknown>;
  main(args: string[], output: { write(line: string): void }): Promise<number>;
};

const hosts: Awaited<ReturnType<typeof securityHost>>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const entry of hosts.splice(0)) await entry.host.stop();
});
async function setup() { const entry = await securityHost(); hosts.push(entry); return entry; }

describe("release broker trust-boundary assertions", () => {
  it.each([
    ["origin", { origin: "https://page.invalid" }],
    ["host", { headers: { Host: "localhost:43123" } }],
    ["query credential", { suffix: "?token=synthetic-must-not-reflect" }],
  ] as const)("rejects untrusted %s in the actual loopback upgrade", async (_label, change) => {
    const { address, host } = await setup();
    expect(address.host).toBe("127.0.0.1");
    const socket = new WebSocket(address.url + ("suffix" in change ? change.suffix : ""), address.subprotocol, {
      origin: FAKE_EXTENSION_ORIGIN, ...change,
    });
    sockets.push(socket);
    socket.on("error", () => undefined);
    const rejected = new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      socket.terminate();
    }));
    expect(await rejected).toBe(403);
    expect(host.hasAuthenticatedPeer).toBe(false);
  });

  it("does not dispatch before authentication or reflect an invalid pairing token", async () => {
    const { host, address } = await setup();
    const socket = await openSocket(address);
    sockets.push(socket);
    const frames: string[] = [];
    socket.on("message", (frame) => frames.push(frame.toString()));
    const { schema_version: _version, ...input } = generateRequest.params;
    await expect(collect(host.generate(JSON.parse(JSON.stringify(input)) as BrokerGenerateRequest)))
      .rejects.toMatchObject({ code: "WAITING_FOR_BROWSER", externalOutcome: "not_started" });
    const token = createPairingToken();
    const closed = once(socket, "close");
    socket.send(encodeWebModelFrame({ ...helloRequest, params: { ...helloRequest.params, pairing_token: token } }));
    const [code, reason] = await closed;
    expect([code, reason.toString()]).toEqual([1008, "AUTH_FAILED"]);
    expect(frames).toEqual([]);
    expect(reason.toString()).not.toContain(token);
  });

  it.each(["oversized", "binary", "extra credential"])("fails closed on %s frames with a bounded public error", async (kind) => {
    const { address, token, host } = await setup();
    const socket = await openSocket(address);
    sockets.push(socket);
    await authenticate(socket, token);
    const closed = once(socket, "close");
    if (kind === "oversized") socket.send("x".repeat(MAX_FRAME_BYTES + 1));
    else if (kind === "binary") socket.send(Buffer.from("{}"), { binary: true });
    else socket.send(JSON.stringify({ ...helloRequest, authorization: "Bearer synthetic-secret" }));
    const [code, reason] = await closed;
    expect(code).toBe(kind === "oversized" ? 1009 : kind === "binary" ? 1003 : 1008);
    expect(reason.toString()).not.toMatch(/synthetic|Bearer|[A-Z]:\\|\/home\//);
    expect(host.hasAuthenticatedPeer).toBe(false);
  });

  it("uses the official file runtime and admission fence for junction escapes and unauthorized mutation", async () => {
    const fixture = await createMutationFixture();
    try {
      await fixture.editor.dispose();
      await fixture.ctx.plugin(WorkspaceFiles, { workspaceRoot: fixture.workspace, maxOutputChars: 512 });
      const approved = join(fixture.workspace, "approved.txt");
      expect((await fixture.execute("create", approved, { file_text: "owned tool fixture" })).isError).toBe(false);
      expect(await readFile(approved, "utf8")).toBe("owned tool fixture");
      const link = join(fixture.workspace, "outside-link");
      await symlink(fixture.outsideDir, link, process.platform === "win32" ? "junction" : "dir");
      const escaped = join(link, "unapproved.txt");
      const denied = await fixture.execute("create", escaped, { file_text: "never write" });
      expect(denied.isError).toBe(true);
      const deniedText = denied.content.flatMap((block) => block.type === "text" ? block.text : []).join("\n");
      expect(deniedText).toContain("WORKSPACE_FILES_WORKSPACE_ACCESS_DENIED");
      expect(deniedText).not.toContain(fixture.root);
      await expect(readFile(join(fixture.outsideDir, "unapproved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const unknown = await fixture.ctx.tools.execute({
        callId: ToolCallId("unauthorized-shell"), name: "bash", arguments: { command: "never execute" },
        agent: fixture.agent, signal: new AbortController().signal,
      });
      expect(unknown.isError).toBe(true);
      expect(await readFile(fixture.outside, "utf8")).toBe("outside fixture content\n");
    } finally { await fixture.dispose(); }
  });
});

describe("explicit distribution payload policy", () => {
  it("does not invent a successful candidate when no explicit distribution exists", async () => {
    const lines: string[] = [];
    expect(await policyMain([], { write: (line: string) => { lines.push(line); } })).toBe(1);
    expect(lines).toEqual([`${JSON.stringify({ schema_version: 1, ok: false, error: "HARNESS_POLICY_DISTRIBUTION_REQUIRED" })}\n`]);
    await expect(checkDistributionPolicy("relative-directory")).rejects.toThrow("HARNESS_POLICY_DISTRIBUTION_REQUIRED");
  });

  it.each(["sessions/example.jsonl", ".env", ".env.production", "logs/output.txt", "some/test.db", "web-model-journal/records.json"])(
    "rejects private artifact entry %s", (name) => {
      expect(() => assertPayloadPolicy(name, Buffer.from("{}"))).toThrow("HARNESS_POLICY_PRIVATE_ENTRY");
    },
  );

  it.each([
    'const token = { pairingToken: "synthetic-secret-000000000000000000000" };',
    '{"DEEPSEEK_API_KEY":"synthetic-api-key-not-real-0000"}',
    '{"Cookie":"synthetic-session=not-real"}',
    'Authorization: Bearer synthetic-not-real-0000000000',
    '-----BEGIN PRIVATE KEY-----',
  ])("rejects credential literals without reflecting matched bytes", (source) => {
    expect(() => assertPayloadPolicy("packages/example/src/index.ts", Buffer.from(source))).toThrow("HARNESS_POLICY_CREDENTIAL_LITERAL");
  });

  it.each(['C:\\Users\\synthetic-user\\private-file', '/home/synthetic-user/private-file', '/Users/synthetic-user/private-file'])(
    "rejects user-home paths without reporting the path", (path) => {
      expect(() => assertPayloadPolicy("notes.txt", Buffer.from(path))).toThrow("HARNESS_POLICY_PRIVATE_HOME");
      expect(() => assertPayloadPolicy("notes.txt", Buffer.from(JSON.stringify({ path })))).toThrow("HARNESS_POLICY_PRIVATE_HOME");
    },
  );

  it("checks compressed payloads in memory and rejects malformed archives", () => {
    expect(() => assertPayloadPolicy("vendor/fixed.tgz", gzipSync('Cookie: "synthetic-session=not-real"')))
      .toThrow("HARNESS_POLICY_CREDENTIAL_LITERAL");
    expect(() => assertPayloadPolicy("vendor/fixed.tgz", Buffer.from("not an archive"))).toThrow("HARNESS_POLICY_ARCHIVE_INVALID");
  });

  it("permits configuration references, not credential values", () => {
    const source = Buffer.from("pairingToken: process.env.DSH_WEB_PAIRING_TOKEN\nconst names = ['DEEPSEEK_API_KEY'];");
    expect(assertPayloadPolicy("packages/example/src/index.ts", source)).toBe(source.length);
  });
});
