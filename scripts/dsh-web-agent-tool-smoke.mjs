import { runDshToolLoop } from "../tests/fixtures/dsh-web-agent/tool-loop/run-tool-loop.ts";

try {
  const read = await runDshToolLoop("read");
  const error = await runDshToolLoop("read-error");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scope: "fake-browser-readonly-tool-loop",
    route: "dsh->agent-loop->fake-browser->official-read->fake-browser",
    scenarios: [read.mode, error.mode],
    modelRequestsPerScenario: 2,
    durable: true,
    cleanup: true,
    productAcceptance: false,
    realWebModel: false,
  })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "DSH_WEB_AGENT_TOOL_SMOKE_FAILED" })}\n`);
  process.exitCode = 1;
}
