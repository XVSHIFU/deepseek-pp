const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Product input grammar, not an agent/session engine. */
export function validateStartInput({ task, resume }) {
  if (task !== undefined && (typeof task !== "string" || !task.trim() || task.length > 262144)) fail("START_TASK_REQUIRED");
  if (resume !== undefined && (typeof resume !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(resume))) fail("START_RESUME_ID_INVALID");
  if (task !== undefined && resume !== undefined) fail("START_TASK_RESUME_CONFLICT");
  return { interactive: task === undefined, resume };
}

export function parseTerminalArguments(args) {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== "--resume") fail("START_TERMINAL_ARGUMENTS_INVALID");
  validateStartInput({ resume: args[1] });
  return { resume: args[1] };
}

/** Terminal control sequences from model/tool text are display data, not UI commands. */
export function terminalText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}
