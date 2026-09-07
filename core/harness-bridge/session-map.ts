export type WebModelRequestPhase =
  | 'reserved'
  | 'accepted'
  | 'dispatched'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'ambiguous';

export type WebModelTerminalPhase = Extract<
  WebModelRequestPhase,
  'completed' | 'aborted' | 'failed' | 'ambiguous'
>;

export interface WebPageSessionBinding {
  readonly chatSessionId: string;
  readonly parentMessageId: number | null;
  readonly messageCount: number;
  readonly quarantined: boolean;
}

export interface VerifiedWebPageTurn {
  readonly chatSessionId: string;
  readonly requestMessageId: number;
  readonly responseMessageId: number;
  readonly nextParentMessageId: number;
  readonly assistantMessageId: number;
  readonly assistantParentMessageId: number;
  readonly requestParentMessageId: number | null;
  readonly messageCount: number;
  readonly verifiedAt: number;
}

export interface WebModelRequestSnapshot {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly phase: WebModelRequestPhase;
  readonly webpage?: {
    readonly chatSessionId: string;
    readonly parentMessageIdAtDispatch: number | null;
    readonly requestMessageId?: number;
    readonly responseMessageId?: number;
  };
}

export interface WebModelSessionMapSnapshot {
  readonly sessionCount: number;
  readonly requestCount: number;
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly chatSessionId: string;
    readonly parentMessageId: number | null;
    readonly messageCount: number;
    readonly quarantined: boolean;
  }>;
  readonly requests: readonly WebModelRequestSnapshot[];
}

export type WebModelSessionMapErrorCode =
  | 'DUPLICATE_REQUEST'
  | 'SESSION_BUSY'
  | 'SESSION_QUARANTINED'
  | 'SESSION_CAPACITY_EXCEEDED'
  | 'REQUEST_CAPACITY_EXCEEDED'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_IDENTITY_MISMATCH'
  | 'REQUEST_PHASE_INVALID'
  | 'SESSION_BINDING_INVALID'
  | 'CHAIN_UNVERIFIED';

export class WebModelSessionMapError extends Error {
  readonly code: WebModelSessionMapErrorCode;

  constructor(code: WebModelSessionMapErrorCode) {
    super(code);
    this.name = 'WebModelSessionMapError';
    this.code = code;
  }
}

export interface WebModelSessionMapLimits {
  readonly maxSessions: number;
  readonly maxRequests: number;
}

const DEFAULT_LIMITS: WebModelSessionMapLimits = Object.freeze({
  maxSessions: 64,
  maxRequests: 1_024,
});

interface MutableRequestRecord {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  phase: WebModelRequestPhase;
  chatSessionId?: string;
  parentMessageIdAtDispatch?: number | null;
  requestMessageId?: number;
  responseMessageId?: number;
  createdSession?: boolean;
}

/**
 * Bounded, fail-closed correlation state for harness sessions and DeepSeek
 * webpage chains.  Completed request IDs are retained as tombstones so a
 * transport reconnect cannot accidentally replay an already-started turn.
 */
export class WebModelSessionMap {
  private readonly limits: WebModelSessionMapLimits;
  private readonly sessions = new Map<string, WebPageSessionBinding>();
  private readonly requests = new Map<string, MutableRequestRecord>();
  private readonly activeRequestBySession = new Map<string, string>();

  constructor(limits: Partial<WebModelSessionMapLimits> = {}) {
    this.limits = Object.freeze({
      maxSessions: boundedLimit(limits.maxSessions, DEFAULT_LIMITS.maxSessions),
      maxRequests: boundedLimit(limits.maxRequests, DEFAULT_LIMITS.maxRequests),
    });
  }

  reserve(requestId: string, requestDigest: string, sessionId: string): WebPageSessionBinding | undefined {
    if (this.requests.has(requestId)) throw new WebModelSessionMapError('DUPLICATE_REQUEST');
    const binding = this.sessions.get(sessionId);
    if (binding?.quarantined) throw new WebModelSessionMapError('SESSION_QUARANTINED');
    if (this.requests.size >= this.limits.maxRequests) throw new WebModelSessionMapError('REQUEST_CAPACITY_EXCEEDED');
    if (this.activeRequestBySession.has(sessionId)) throw new WebModelSessionMapError('SESSION_BUSY');
    if (!binding && this.sessions.size >= this.limits.maxSessions) {
      throw new WebModelSessionMapError('SESSION_CAPACITY_EXCEEDED');
    }

    this.requests.set(requestId, {
      requestId,
      requestDigest,
      sessionId,
      phase: 'reserved',
      ...(binding ? {
        chatSessionId: binding.chatSessionId,
        parentMessageIdAtDispatch: binding.parentMessageId,
      } : {}),
    });
    this.activeRequestBySession.set(sessionId, requestId);
    return binding;
  }

  bindNewSession(requestId: string, chatSessionId: string): WebPageSessionBinding {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'reserved' || this.sessions.has(request.sessionId)) {
      throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    }
    if (!chatSessionId) throw new WebModelSessionMapError('SESSION_BINDING_INVALID');
    const binding = Object.freeze({
      chatSessionId,
      parentMessageId: null,
      messageCount: 0,
      quarantined: false,
    });
    this.sessions.set(request.sessionId, binding);
    request.chatSessionId = chatSessionId;
    request.parentMessageIdAtDispatch = null;
    request.createdSession = true;
    return binding;
  }

  markAccepted(requestId: string): void {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'reserved') throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    request.phase = 'accepted';
  }

  markDispatched(requestId: string): void {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'accepted') throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    request.phase = 'dispatched';
  }

  markStreaming(requestId: string): void {
    const request = this.requireRequest(requestId);
    if (request.phase === 'streaming') return;
    if (request.phase !== 'dispatched') throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    request.phase = 'streaming';
  }

  complete(requestId: string, verified: VerifiedWebPageTurn): void {
    const request = this.requireDispatchedRequest(requestId);
    const current = this.sessions.get(request.sessionId);
    if (!current || current.quarantined ||
        !isSafeMessageId(verified.requestMessageId) ||
        !isSafeMessageId(verified.responseMessageId) ||
        verified.chatSessionId !== current.chatSessionId ||
        verified.nextParentMessageId !== verified.responseMessageId ||
        verified.assistantMessageId !== verified.responseMessageId ||
        verified.assistantParentMessageId !== verified.requestMessageId ||
        verified.requestParentMessageId !== request.parentMessageIdAtDispatch ||
        verified.requestParentMessageId !== current.parentMessageId ||
        verified.requestMessageId === verified.responseMessageId ||
        verified.requestMessageId === current.parentMessageId ||
        !Number.isSafeInteger(verified.messageCount) || verified.messageCount !== current.messageCount + 2 ||
        !Number.isSafeInteger(verified.verifiedAt) || verified.verifiedAt < 0 ||
        current.parentMessageId === verified.responseMessageId) {
      throw new WebModelSessionMapError('CHAIN_UNVERIFIED');
    }
    request.requestMessageId = verified.requestMessageId;
    request.responseMessageId = verified.responseMessageId;
    this.sessions.set(request.sessionId, Object.freeze({
      chatSessionId: current.chatSessionId,
      parentMessageId: verified.responseMessageId,
      messageCount: verified.messageCount,
      quarantined: false,
    }));
    this.finishRequest(request, 'completed');
  }

  /** Complete one Harness request that used one bounded corrective webpage turn. */
  completeCorrection(
    requestId: string,
    first: VerifiedWebPageTurn,
    corrected: VerifiedWebPageTurn,
  ): void {
    const request = this.requireDispatchedRequest(requestId);
    const current = this.sessions.get(request.sessionId);
    if (!current || current.quarantined ||
        !validTurn(first, current.chatSessionId) || !validTurn(corrected, current.chatSessionId) ||
        first.requestParentMessageId !== request.parentMessageIdAtDispatch ||
        first.requestParentMessageId !== current.parentMessageId ||
        first.messageCount !== current.messageCount + 2 ||
        corrected.requestParentMessageId !== first.responseMessageId ||
        corrected.messageCount !== current.messageCount + 4 ||
        corrected.requestMessageId === first.responseMessageId ||
        corrected.responseMessageId === first.responseMessageId) {
      throw new WebModelSessionMapError('CHAIN_UNVERIFIED');
    }
    request.requestMessageId = corrected.requestMessageId;
    request.responseMessageId = corrected.responseMessageId;
    this.sessions.set(request.sessionId, Object.freeze({
      chatSessionId: current.chatSessionId,
      parentMessageId: corrected.responseMessageId,
      messageCount: corrected.messageCount,
      quarantined: false,
    }));
    this.finishRequest(request, 'completed');
  }

  markTerminal(requestId: string, phase: Exclude<WebModelTerminalPhase, 'completed'>): void {
    const request = this.requireActiveRequest(requestId);
    if (request.phase === 'dispatched' || request.phase === 'streaming') {
      const session = this.sessions.get(request.sessionId);
      // T1.2 intentionally has no reconciliation/unquarantine API. A later
      // recovery task must prove the webpage chain before this can be cleared.
      if (session) this.sessions.set(request.sessionId, Object.freeze({ ...session, quarantined: true }));
    }
    this.finishRequest(request, phase);
  }

  /** Remove only a request proved not to have reached model dispatch. */
  releaseUnstarted(requestId: string): void {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'reserved') throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    this.requests.delete(requestId);
    if (this.activeRequestBySession.get(request.sessionId) === requestId) {
      this.activeRequestBySession.delete(request.sessionId);
    }
    if (request.createdSession && this.sessions.get(request.sessionId)?.chatSessionId === request.chatSessionId) {
      this.sessions.delete(request.sessionId);
    }
  }

  getRequest(requestId: string): WebModelRequestSnapshot | undefined {
    const request = this.requests.get(requestId);
    return request ? freezeRequestSnapshot(request) : undefined;
  }

  getSession(sessionId: string): WebPageSessionBinding | undefined {
    return this.sessions.get(sessionId);
  }

  snapshot(): WebModelSessionMapSnapshot {
    return Object.freeze({
      sessionCount: this.sessions.size,
      requestCount: this.requests.size,
      sessions: Object.freeze([...this.sessions].map(([sessionId, session]) => Object.freeze({
        sessionId,
        ...session,
      }))),
      requests: Object.freeze([...this.requests.values()].map(freezeRequestSnapshot)),
    });
  }

  private requireRequest(requestId: string): MutableRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new WebModelSessionMapError('REQUEST_NOT_FOUND');
    return request;
  }

  private requireActiveRequest(requestId: string): MutableRequestRecord {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'accepted' && request.phase !== 'dispatched' && request.phase !== 'streaming') {
      throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    }
    return request;
  }

  private requireDispatchedRequest(requestId: string): MutableRequestRecord {
    const request = this.requireRequest(requestId);
    if (request.phase !== 'dispatched' && request.phase !== 'streaming') {
      throw new WebModelSessionMapError('REQUEST_PHASE_INVALID');
    }
    return request;
  }

  private finishRequest(request: MutableRequestRecord, phase: WebModelTerminalPhase): void {
    request.phase = phase;
    if (this.activeRequestBySession.get(request.sessionId) === request.requestId) {
      this.activeRequestBySession.delete(request.sessionId);
    }
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100_000) {
    throw new WebModelSessionMapError('SESSION_BINDING_INVALID');
  }
  return resolved;
}

function isSafeMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validTurn(turn: VerifiedWebPageTurn, chatSessionId: string): boolean {
  return isSafeMessageId(turn.requestMessageId) && isSafeMessageId(turn.responseMessageId) &&
    turn.chatSessionId === chatSessionId && turn.nextParentMessageId === turn.responseMessageId &&
    turn.assistantMessageId === turn.responseMessageId &&
    turn.assistantParentMessageId === turn.requestMessageId &&
    turn.requestMessageId !== turn.responseMessageId && Number.isSafeInteger(turn.messageCount) &&
    Number.isSafeInteger(turn.verifiedAt) && turn.verifiedAt >= 0;
}

function freezeRequestSnapshot(request: MutableRequestRecord): WebModelRequestSnapshot {
  return Object.freeze({
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    sessionId: request.sessionId,
    phase: request.phase,
    ...(request.chatSessionId === undefined ? {} : {
      webpage: Object.freeze({
        chatSessionId: request.chatSessionId,
        parentMessageIdAtDispatch: request.parentMessageIdAtDispatch ?? null,
        ...(request.requestMessageId === undefined ? {} : { requestMessageId: request.requestMessageId }),
        ...(request.responseMessageId === undefined ? {} : { responseMessageId: request.responseMessageId }),
      }),
    }),
  });
}
