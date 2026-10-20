/**
 * Backend-to-browser public status mapping.
 *
 * Provider payloads, credentials, exceptions, and diagnostics may exist on the
 * backend input, but the mapper constructs each public object field-by-field
 * and therefore cannot copy those private values into a browser response.
 */

import {
  INVALID_AUDIO_SELECTION_MESSAGE,
  MAX_PUBLIC_FAILURE_MESSAGE_CHARACTERS,
  isJobId,
  isTranscriptToken,
  type FailedStatusUpdate,
  type JobId,
  type PublicFailureMessage,
  type StatusUpdate,
  type TranscriptText,
  type TranscriptToken,
  type TranscriptionStatus,
} from '../shared/transcription.js';

export const GENERIC_PUBLIC_FAILURE_MESSAGE = 'Transcription failed.';
export const SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE = 'Transcription submission could not occur.';
export const SUBMISSION_FAILED_FAILURE_MESSAGE = 'Transcription submission failed.';
export const REJECTED_REQUEST_FAILURE_MESSAGE = INVALID_AUDIO_SELECTION_MESSAGE;

/**
 * Internal status input. Extra backend-private fields are allowed by the
 * boundary type so callers can pass provider context, but the mapper never
 * serializes them. Only `publicFailureMessage` or `failureMessage` is eligible
 * to become user-visible text.
 */
export interface BackendStatusInput {
  readonly jobId: JobId;
  readonly status: TranscriptionStatus;
  readonly transcriptText?: unknown;
  readonly confidenceScore?: unknown;
  readonly tokens?: unknown;
  readonly publicFailureMessage?: unknown;
  readonly failureMessage?: unknown;
  readonly credential?: unknown;
  readonly providerHandle?: unknown;
  readonly providerPayload?: unknown;
  readonly error?: unknown;
  readonly stack?: unknown;
  readonly [privateField: string]: unknown;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedFallback(value: unknown): PublicFailureMessage {
  if (typeof value !== 'string') {
    return GENERIC_PUBLIC_FAILURE_MESSAGE;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return GENERIC_PUBLIC_FAILURE_MESSAGE;
  }

  return Array.from(normalized).slice(0, MAX_PUBLIC_FAILURE_MESSAGE_CHARACTERS).join('');
}

function containsSensitiveFailureMaterial(value: string): boolean {
  // A public message must never be used as a vehicle for a credential or raw
  // exception. Structured JSON is treated as provider/internal payload data.
  if (/^\s*[\[{]/u.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        return true;
      }
    } catch {
      // A non-JSON message beginning with punctuation may still be a valid
      // human message; the explicit sensitive-token checks below still apply.
    }
  }

  if (/\b(?:api[_ -]?key|credential|secret|password|authorization|bearer|token)\b\s*[:=]\s*\S+/iu.test(value)) {
    return true;
  }

  // Keep only a single public line. A second line beginning like a stack frame
  // is never exposed; messages that begin like raw Error objects are generic.
  return /(?:^|\n)\s*at\s+[^\n]+/u.test(value) || /^\s*(?:[A-Za-z]*Error|Exception)\s*:/u.test(value);
}

/**
 * Converts backend-created failure text into a non-empty, <=500-code-point
 * public message. Internal error/provider fields are intentionally not
 * accepted by this function; callers should pass only a backend-approved
 * public message candidate.
 */
export function sanitizePublicFailureMessage(
  value: unknown,
  fallback: unknown = GENERIC_PUBLIC_FAILURE_MESSAGE,
): PublicFailureMessage {
  const safeFallback = boundedFallback(fallback);
  if (typeof value !== 'string') {
    return safeFallback;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || containsSensitiveFailureMaterial(normalized)) {
    return safeFallback;
  }

  return Array.from(normalized).slice(0, MAX_PUBLIC_FAILURE_MESSAGE_CHARACTERS).join('');
}

/** Short name for backend callers and tests. */
export const sanitizeFailureMessage = sanitizePublicFailureMessage;

/** Creates a public failed update with no private fields. */
export function mapPublicFailure(
  jobId: JobId,
  failureMessage?: unknown,
  fallback: unknown = GENERIC_PUBLIC_FAILURE_MESSAGE,
): FailedStatusUpdate {
  return {
    jobId,
    status: 'failed',
    failureMessage: sanitizePublicFailureMessage(failureMessage, fallback),
  };
}

/**
 * Maps an internal backend/provider outcome into the browser-safe contract.
 * Invalid job IDs or status envelopes return null so an API handler can choose
 * its generic server-error path without serializing malformed internals.
 */
export function mapPublicStatus(input: unknown): StatusUpdate | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const candidate = input as Partial<BackendStatusInput>;
  if (!isJobId(candidate.jobId) || typeof candidate.status !== 'string') {
    return null;
  }

  switch (candidate.status) {
    case 'queued':
      return { jobId: candidate.jobId, status: 'queued' };
    case 'processing':
      return { jobId: candidate.jobId, status: 'processing' };
    case 'completed': {
      if (typeof candidate.transcriptText !== 'string') {
        return mapPublicFailure(candidate.jobId, undefined, GENERIC_PUBLIC_FAILURE_MESSAGE);
      }
      const validConfidence =
        typeof candidate.confidenceScore === 'number' && Number.isFinite(candidate.confidenceScore)
          ? candidate.confidenceScore
          : undefined;
      const validTokens =
        Array.isArray(candidate.tokens) && candidate.tokens.every(isTranscriptToken)
          ? (candidate.tokens as readonly TranscriptToken[])
          : undefined;
      return {
        jobId: candidate.jobId,
        status: 'completed',
        transcriptText: candidate.transcriptText as TranscriptText,
        ...(validConfidence !== undefined ? { confidenceScore: validConfidence } : {}),
        ...(validTokens !== undefined ? { tokens: validTokens } : {}),
      };
    }
    case 'failed':
      return mapPublicFailure(
        candidate.jobId,
        candidate.publicFailureMessage ?? candidate.failureMessage,
        GENERIC_PUBLIC_FAILURE_MESSAGE,
      );
    default:
      return null;
  }
}

/** Semantic aliases for API/coordinator code. */
export const toPublicStatusUpdate = mapPublicStatus;
export const sanitizeStatusUpdate = mapPublicStatus;
