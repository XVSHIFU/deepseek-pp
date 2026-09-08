import type { ToolDescriptor } from '../types';
import {
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
} from '../tool';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from '../tool/xml-tags';
import {
  LEGACY_TOOL_CALLS_CLOSE_TAG,
  LEGACY_TOOL_CALLS_OPEN_TAG,
} from './tool-parser';

export interface StreamingToolTextAccumulator {
  append(chunk: string): string;
  flush(): string;
  getVisibleText(): string;
}

export function createStreamingToolTextAccumulator(
  descriptors: readonly ToolDescriptor[],
  options: { readonly stopTextAtToolCall?: boolean } = {},
): StreamingToolTextAccumulator {
  const catalog = createToolInvocationCatalog(descriptors);
  return new ToolTextAccumulator(catalog.invocationNames, options.stopTextAtToolCall === true);
}

class ToolTextAccumulator implements StreamingToolTextAccumulator {
  private readonly suppressionTargets: Array<{ key: string; openTag: string; closeTag: string }>;
  private readonly targetByOpenTag = new Map<string, { key: string; openTag: string; closeTag: string }>();
  private readonly xmlTargets = new Map<string, { key: string; openTag: string; closeTag: string }>();
  private readonly xmlTargetNames: ReadonlySet<string>;
  private readonly openPrefixes: Set<string>;
  private readonly closePrefixesByTarget = new Map<string, Set<string>>();
  private readonly maxOpenPrefixLength: number;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private currentTarget: { key: string; name?: string; closeTag: string } | null = null;
  private pendingNormal = '';
  private pendingSuppressed = '';
  private visibleText = '';
  private textStopped = false;

  constructor(invocationNames: readonly string[], private readonly stopTextAtToolCall = false) {
    this.suppressionTargets = invocationNames.map((tool) => ({
      key: `xml:${tool}`,
      openTag: getToolOpenTag(tool),
      closeTag: getToolCloseTag(tool),
    }));
    this.suppressionTargets.push({
      key: 'legacy:dsml-tool-calls',
      openTag: LEGACY_TOOL_CALLS_OPEN_TAG,
      closeTag: LEGACY_TOOL_CALLS_CLOSE_TAG,
    });
    for (const target of this.suppressionTargets) {
      this.targetByOpenTag.set(target.openTag, target);
    }
    for (const target of this.suppressionTargets.filter((target) => target.key.startsWith('xml:'))) {
      const name = target.key.slice('xml:'.length);
      this.xmlTargets.set(name, target);
    }
    this.xmlTargetNames = new Set(this.xmlTargets.keys());
    this.openPrefixes = createPrefixSet(this.suppressionTargets.map((entry) => entry.openTag));
    this.maxOpenPrefixLength = Math.max(0, ...this.suppressionTargets.map((entry) => entry.openTag.length - 1));

    for (const target of this.suppressionTargets) {
      this.closePrefixesByTarget.set(target.key, createPrefixSet([target.closeTag]));
    }
  }

  append(chunk: string): string {
    if (this.textStopped) return this.visibleText;
    if (!chunk || this.suppressionTargets.length === 0) {
      this.visibleText += chunk;
      return this.visibleText;
    }

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining = this.state === 'SUPPRESSING'
        ? this.consumeSuppressedText(remaining)
        : this.consumeNormalText(remaining);
    }

    return this.visibleText;
  }

  flush(): string {
    if (this.textStopped) return this.visibleText;
    if (this.state === 'NORMAL' && this.pendingNormal) {
      this.visibleText += this.pendingNormal;
    }

    this.state = 'NORMAL';
    this.currentTarget = null;
    this.pendingNormal = '';
    this.pendingSuppressed = '';
    return this.visibleText;
  }

  getVisibleText(): string {
    return this.visibleText;
  }

  private consumeNormalText(input: string): string {
    const text = this.pendingNormal + input;
    this.pendingNormal = '';

    const found = this.findFirstOpenTag(text);
    if (!found) {
      const legacyTailLength = getPartialTailLength(text, this.openPrefixes, this.maxOpenPrefixLength);
      const xmlTailLength = getPartialXmlToolTagTailLength(text, this.xmlTargetNames, { closing: false });
      const tailLength = Math.max(legacyTailLength, xmlTailLength);
      const emitLength = text.length - tailLength;
      if (emitLength > 0) this.visibleText += text.slice(0, emitLength);
      this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    if (found.index > 0) {
      this.visibleText += text.slice(0, found.index);
    }

    // Mode A executes tools only after the verified model turn completes.
    // Text after a tool opening cannot yet be grounded in that tool's result.
    // The independent parser still consumes and validates the complete stream.
    if (this.stopTextAtToolCall) {
      this.textStopped = true;
      return '';
    }

    this.state = 'SUPPRESSING';
    this.currentTarget = {
      key: found.key,
      name: found.name,
      closeTag: found.closeTag,
    };
    this.pendingSuppressed = '';
    return text.slice(found.endIndex);
  }

  private consumeSuppressedText(input: string): string {
    const target = this.currentTarget;
    if (!target) {
      this.state = 'NORMAL';
      return input;
    }

    const closeTag = target.closeTag;
    const text = this.pendingSuppressed + input;
    this.pendingSuppressed = '';

    const closeMatch = target.name
      ? findFirstXmlToolTag(text, new Set([target.name]), { closing: true })
      : null;
    const closeIndex = closeMatch?.index ?? text.indexOf(closeTag);
    if (closeIndex === -1) {
      const legacyPrefixes = this.closePrefixesByTarget.get(target.key) ?? new Set<string>();
      const legacyTailLength = getPartialTailLength(text, legacyPrefixes, closeTag.length - 1);
      const xmlTailLength = target.name
        ? getPartialXmlToolTagTailLength(text, new Set([target.name]), { closing: true })
        : 0;
      const tailLength = Math.max(legacyTailLength, xmlTailLength);
      this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    this.state = 'NORMAL';
    this.currentTarget = null;
    return text.slice(closeMatch?.endIndex ?? closeIndex + closeTag.length);
  }

  private findFirstOpenTag(text: string): { key: string; name?: string; openTag: string; closeTag: string; index: number; endIndex: number } | null {
    const xmlMatch = findFirstXmlToolTag(text, this.xmlTargetNames, { closing: false });
    const legacyMatch = this.findFirstExactOpenTag(text);
    if (!xmlMatch) return legacyMatch;
    const target = this.xmlTargets.get(xmlMatch.name);
    if (!target) return legacyMatch;

    const xmlTarget = {
      ...target,
      name: xmlMatch.name,
      openTag: xmlMatch.raw,
      index: xmlMatch.index,
      endIndex: xmlMatch.endIndex,
    };
    if (!legacyMatch || xmlTarget.index <= legacyMatch.index) return xmlTarget;
    return legacyMatch;
  }

  private findFirstExactOpenTag(text: string): { key: string; openTag: string; closeTag: string; index: number; endIndex: number } | null {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const index = text.indexOf('<', searchFrom);
      if (index === -1) return null;

      const tagEnd = text.indexOf('>', index + 1);
      if (tagEnd === -1) return null;
      const candidate = text.slice(index, tagEnd + 1);
      const target = this.targetByOpenTag.get(candidate);
      if (target) return { ...target, index, endIndex: tagEnd + 1 };

      searchFrom = candidate.includes('<', 1) ? index + 1 : tagEnd + 1;
    }
    return null;
  }
}

function createPrefixSet(tags: readonly string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const tag of tags) {
    for (let length = 1; length < tag.length; length++) {
      prefixes.add(tag.slice(0, length));
    }
  }
  return prefixes;
}

function getPartialTailLength(text: string, prefixes: Set<string>, maxLength: number): number {
  const limit = Math.min(text.length, maxLength);
  for (let length = limit; length > 0; length--) {
    if (prefixes.has(text.slice(-length))) return length;
  }
  return 0;
}
