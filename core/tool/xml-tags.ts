const PARTIAL_TAG_WHITESPACE_LIMIT = 8;
const UNKNOWN_TAG_NAME_LIMIT = 128;

export interface XmlToolTagMatch {
  index: number;
  endIndex: number;
  name: string;
  raw: string;
  closing: boolean;
}

export function findFirstXmlToolTag(
  text: string,
  // null is an explicit opt-in to scan bare XML names outside a tool catalog.
  toolNames: ReadonlySet<string> | null,
  options: { closing: boolean; fromIndex?: number },
): XmlToolTagMatch | null {
  if (!text || toolNames?.size === 0) return null;

  let searchFrom = Math.max(0, options.fromIndex ?? 0);
  // Adversarial input such as a long run of '<' closed by a single '>' would
  // re-scan the '>' from scratch for every '<' (quadratic). Once a '<' is
  // found inside the same tag region, the closing '>' cannot move, so carry
  // it forward instead of searching again.
  let knownTagEnd = -1;
  while (searchFrom < text.length) {
    const index = text.indexOf('<', searchFrom);
    if (index === -1) return null;

    const tagEnd = knownTagEnd > index ? knownTagEnd : text.indexOf('>', index + 1);
    if (tagEnd === -1) return null;

    const parsed = parseCompleteXmlToolTag(text, index, tagEnd, toolNames);
    if (parsed && parsed.closing === options.closing) return parsed;

    const nextLt = text.indexOf('<', index + 1);
    if (nextLt !== -1 && nextLt < tagEnd) {
      // Another '<' inside the same '<'-run: the closing '>' stays the same.
      knownTagEnd = tagEnd;
      searchFrom = nextLt;
    } else {
      knownTagEnd = -1;
      searchFrom = tagEnd + 1;
    }
  }

  return null;
}

export function getPartialXmlToolTagTailLength(
  text: string,
  toolNames: ReadonlySet<string> | null,
  options: { closing: boolean },
): number {
  if (!text || toolNames?.size === 0) return 0;

  const names = toolNames === null ? null : Array.from(toolNames);
  const maxNameLength = names === null
    ? UNKNOWN_TAG_NAME_LIMIT
    : Math.max(0, ...names.map((name) => name.length));
  const limit = Math.min(
    text.length,
    2 + maxNameLength + PARTIAL_TAG_WHITESPACE_LIMIT * 2,
  );

  for (let length = limit; length > 0; length -= 1) {
    if (isPartialXmlToolTag(text.slice(-length), names, options.closing)) return length;
  }
  return 0;
}

function parseCompleteXmlToolTag(
  text: string,
  index: number,
  tagEnd: number,
  toolNames: ReadonlySet<string> | null,
): XmlToolTagMatch | null {
  let cursor = index + 1;
  cursor = skipWhitespace(text, cursor, tagEnd);

  let closing = false;
  if (text[cursor] === '/') {
    closing = true;
    cursor += 1;
    cursor = skipWhitespace(text, cursor, tagEnd);
  }

  if (!isToolNameStart(text[cursor])) return null;
  const nameStart = cursor;
  cursor += 1;
  while (cursor < tagEnd && isToolNameChar(text[cursor])) {
    cursor += 1;
  }

  const name = text.slice(nameStart, cursor);
  if (toolNames !== null && !toolNames.has(name)) return null;

  cursor = skipWhitespace(text, cursor, tagEnd);
  if (cursor !== tagEnd) return null;

  return {
    index,
    endIndex: tagEnd + 1,
    name,
    raw: text.slice(index, tagEnd + 1),
    closing,
  };
}

function isPartialXmlToolTag(
  value: string,
  toolNames: readonly string[] | null,
  closing: boolean,
): boolean {
  if (!value.startsWith('<')) return false;
  let cursor = 1;

  const beforeSlash = skipLimitedWhitespace(value, cursor);
  if (beforeSlash === value.length) return true;
  cursor = beforeSlash;

  if (value[cursor] === '/') {
    if (!closing) return false;
    cursor += 1;
    const beforeName = skipLimitedWhitespace(value, cursor);
    if (beforeName === value.length) return true;
    cursor = beforeName;
  } else if (closing) {
    return false;
  }

  if (!isToolNameStart(value[cursor])) return false;
  const nameStart = cursor;
  cursor += 1;
  while (cursor < value.length && isToolNameChar(value[cursor])) {
    cursor += 1;
  }

  const typedName = value.slice(nameStart, cursor);
  if (toolNames !== null && !toolNames.some((name) => name.startsWith(typedName))) return false;

  const afterName = skipLimitedWhitespace(value, cursor);
  return afterName === value.length;
}

function skipWhitespace(text: string, cursor: number, end: number): number {
  while (cursor < end && isWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipLimitedWhitespace(text: string, cursor: number): number {
  let count = 0;
  while (
    cursor < text.length &&
    count < PARTIAL_TAG_WHITESPACE_LIMIT &&
    isWhitespace(text[cursor])
  ) {
    cursor += 1;
    count += 1;
  }
  return cursor;
}

function isWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f';
}

function isToolNameStart(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z_]/.test(value));
}

function isToolNameChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_.:-]/.test(value));
}
