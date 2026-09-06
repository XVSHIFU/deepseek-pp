import { cli, reportFailure } from "../packages/dsh-web-agent-bundle/bin/install-runtime.mjs";

try { await cli(); } catch (error) { reportFailure(error); }
