import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DISTRIBUTION = "Ubuntu";
const LINUX_NODE = "/home/worker/.nvm/versions/node/v24.18.0/bin/node";
const WSL_EXE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");

// In-memory Linux program. No profile, browser, token, shell or filesystem I/O.
// Both this process and its independent Linux timeout bound the listener.
const LINUX_PROGRAM = String.raw`
import { createServer } from "node:net";
const payload = process.argv[1];
const sockets = new Set();
const accepted = Promise.withResolvers();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setTimeout(2000, () => socket.destroy());
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (input.length > 256) return socket.destroy();
    if (!input.endsWith("\n")) return;
    if (input !== payload + "\n") return socket.destroy();
    socket.end("echo:" + payload + "\n", () => accepted.resolve());
  });
});
const timer = setTimeout(() => accepted.reject(new Error("LINUX_PROBE_DEADLINE")), 20000);
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  while (server.address().port === 43123) {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
  }
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ stage: "ready", host: "127.0.0.1", port }) + "\n");
  await accepted.promise;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const verifier = createServer();
  await new Promise((resolve, reject) => {
    verifier.once("error", reject);
    verifier.listen({ host: "127.0.0.1", port }, resolve);
  });
  await new Promise((resolve) => verifier.close(resolve));
  process.stdout.write(JSON.stringify({ stage: "closed", linux_port_released: true }) + "\n");
} finally {
  clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
`;

async function runProbe() {
  assert.equal(process.platform, "win32", "Run this probe from Windows Node, not inside WSL");
  const payload = `dsh-loopback-${randomBytes(16).toString("hex")}`;
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let childClosed = false;
  let linuxClosed = false;
  let output = "";
  let diagnostics = "";
  const child = spawn(WSL_EXE, [
    "--distribution", DISTRIBUTION, "--exec", "/usr/bin/timeout",
    "--signal=TERM", "--kill-after=2s", "30s", LINUX_NODE,
    "--input-type=module", "-e", LINUX_PROGRAM, payload,
  ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = setTimeout(() => {
    ready.reject(new Error("WINDOWS_PROBE_DEADLINE"));
    exited.reject(new Error("WINDOWS_PROBE_DEADLINE"));
    child.kill();
  }, 45_000);
  void ready.promise.catch(() => {});
  void exited.promise.catch(() => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 8192) {
      ready.reject(new Error("LINUX_PROBE_OUTPUT_LIMIT"));
      child.kill();
      return;
    }
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.stage === "ready") ready.resolve(message);
        else if (message.stage === "closed" && message.linux_port_released === true) linuxClosed = true;
        else throw new Error("LINUX_PROBE_UNEXPECTED_MESSAGE");
      } catch (error) {
        ready.reject(error);
      }
    }
  });
  child.once("error", (error) => { ready.reject(error); exited.reject(error); });
  child.once("close", (code) => {
    childClosed = true;
    if (code !== 0) ready.reject(new Error(`LINUX_PROBE_EXIT_${code}`));
    exited.resolve(code);
  });
  try {
    const address = await ready.promise;
    assert.equal(address.host, "127.0.0.1");
    assert.ok(Number.isInteger(address.port) && address.port > 0 && address.port < 65536);
    assert.notEqual(address.port, 43123);
    const start = Date.now();
    let connected = false;
    while (Date.now() - start < 12_000 && !childClosed) {
      try {
        await sendProbe(address.port, payload);
        connected = true;
        break;
      } catch (error) {
        if (error?.code !== "ECONNREFUSED" && error?.message !== "WINDOWS_CONNECT_TIMEOUT") throw error;
        await delay(100);
      }
    }
    assert.equal(connected, true, "Windows could not reach the WSL loopback-only listener");
    assert.equal(await exited.promise, 0, diagnostics);
    assert.equal(linuxClosed, true);
    let windowsPortReleased = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      windowsPortReleased = await canBindWindowsLoopback(address.port);
      if (windowsPortReleased) break;
      await delay(100);
    }
    return {
      schema_version: 1,
      ok: true,
      direction: "windows_to_wsl",
      distribution: DISTRIBUTION,
      linux_node: LINUX_NODE,
      bind_host: address.host,
      allocated_port: address.port,
      echo_verified: true,
      linux_port_released: linuxClosed,
      // WSL owns any forwarding reservation, not this probe. Linux listener
      // release is proven independently by rebinding in the same namespace.
      windows_port_bind_available: windowsPortReleased,
      child_closed: childClosed,
    };
  } finally {
    clearTimeout(deadline);
    // Linux timeout survives a killed wsl.exe caller and is the final bound.
    // Normal completion reaches here after the Linux child and listener exit.
    if (!childClosed) {
      await Promise.race([exited.promise.catch(() => {}), delay(32_000)]);
      if (!childClosed) child.kill();
    }
  }
}

function sendProbe(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(500, () => { socket.destroy(new Error("WINDOWS_CONNECT_TIMEOUT")); });
    socket.once("error", reject);
    socket.once("connect", () => { socket.write(`${payload}\n`); });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 256) return socket.destroy(new Error("WINDOWS_PROBE_OUTPUT_LIMIT"));
      if (!response.endsWith("\n")) return;
      socket.end();
      if (response !== `echo:${payload}\n`) return reject(new Error("WINDOWS_PROBE_RESPONSE_MISMATCH"));
      resolve();
    });
    socket.once("close", () => { if (!response.endsWith("\n")) reject(new Error("WINDOWS_PROBE_CLOSED_EARLY")); });
  });
}

async function canBindWindowsLoopback(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port }, resolve);
    });
    return true;
  } catch (error) {
    if (error?.code === "EADDRINUSE") return false;
    throw error;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

try {
  process.stdout.write(`${JSON.stringify(await runProbe())}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema_version: 1, ok: false, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
