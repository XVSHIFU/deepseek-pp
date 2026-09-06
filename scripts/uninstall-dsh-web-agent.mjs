import { cli, reportFailure } from "../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";

try { await cli(process.argv.slice(2), "uninstall"); } catch (error) { reportFailure(error); }
