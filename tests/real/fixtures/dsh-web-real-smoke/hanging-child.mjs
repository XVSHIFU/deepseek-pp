import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (typeof pidFile !== "string" || pidFile === "") process.exit(2);
writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
setInterval(() => undefined, 1_000);
