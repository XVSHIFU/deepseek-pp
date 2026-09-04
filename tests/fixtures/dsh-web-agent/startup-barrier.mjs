import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const name = "fake-browser-ready-barrier";

const POLL_INTERVAL_MS = 20;
const TIMEOUT_MS = 15_000;

export async function apply() {
  const releaseFile = process.env.DSH_WEB_FAKE_RELEASE_FILE;
  if (releaseFile === undefined || !isAbsolute(releaseFile)) {
    throw new Error("FAKE_STARTUP_BARRIER_REQUIRES_ABSOLUTE_RELEASE_FILE");
  }
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    try {
      await access(releaseFile);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("FAKE_STARTUP_BARRIER_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
