/**
 * Process-local backend job storage.
 *
 * This module is server-only. A stored job deliberately contains neither the
 * source credential nor provider error/cause data. Provider handles remain in
 * this backend-private record solely so the coordinator can refresh a job.
 */

import {
  isJobId,
  isTranscriptionSettings,
  isTranscriptToken,
  type JobId,
  type PublicFailureMessage,
  type TranscriptText,
  type TranscriptToken,
  type TranscriptionSettings,
  type TranscriptionStatus,
} from '../shared/transcription.js';
import {
  GENERIC_PUBLIC_FAILURE_MESSAGE,
  sanitizePublicFailureMessage,
} from './public-status.js';
import type { SonioxProviderHandle } from './soniox.js';

export interface StoredTranscriptionJob {
  readonly jobId: JobId;
  readonly settings: TranscriptionSettings;
  readonly status: TranscriptionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providerHandle: SonioxProviderHandle | null;
  readonly transcriptText: TranscriptText | null;
  readonly confidenceScore?: number | null;
  readonly tokens?: readonly TranscriptToken[] | null;
  readonly failureMessage: PublicFailureMessage | null;
}

export interface CreateStoredJobInput {
  readonly jobId: JobId;
  readonly settings: TranscriptionSettings;
  readonly createdAt: number;
}

/**
 * A lifecycle patch contains only fields that are safe for the repository to
 * retain. The coordinator sanitizes provider context before passing a failed
 * patch, and the repository sanitizes again as a defense in depth.
 */
export type JobLifecyclePatch =
  | {
      readonly status: 'queued' | 'processing';
      readonly providerHandle?: SonioxProviderHandle | null;
    }
  | {
      readonly status: 'completed';
      readonly transcriptText?: unknown;
      readonly confidenceScore?: unknown;
      readonly tokens?: unknown;
      readonly providerHandle?: SonioxProviderHandle | null;
    }
  | {
      readonly status: 'failed';
      readonly failureMessage?: unknown;
      readonly providerHandle?: SonioxProviderHandle | null;
    };

export interface JobRepository {
  create(input: CreateStoredJobInput): StoredTranscriptionJob;
  find(jobId: JobId): StoredTranscriptionJob | null;
  update(jobId: JobId, patch: JobLifecyclePatch, updatedAt: number): StoredTranscriptionJob | null;
  count(): number;
}

function cloneJob(job: StoredTranscriptionJob): StoredTranscriptionJob {
  return { ...job };
}

function normalizeProviderHandle(value: SonioxProviderHandle | null | undefined): SonioxProviderHandle | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * An in-memory repository suitable for a single backend process and local
 * tests. Replacing this class with durable storage does not change the public
 * coordinator contract.
 */
export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<JobId, StoredTranscriptionJob>();

  create(input: CreateStoredJobInput): StoredTranscriptionJob {
    if (!isJobId(input.jobId)) {
      throw new TypeError('A valid opaque job identifier is required.');
    }
    if (!isTranscriptionSettings(input.settings)) {
      throw new TypeError('A transcription setting is required.');
    }
    if (!Number.isFinite(input.createdAt)) {
      throw new TypeError('A finite creation timestamp is required.');
    }
    if (this.jobs.has(input.jobId)) {
      throw new Error('The job identifier is already in use.');
    }

    const job: StoredTranscriptionJob = {
      jobId: input.jobId,
      settings: input.settings,
      status: 'queued',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      providerHandle: null,
      transcriptText: null,
      confidenceScore: null,
      tokens: null,
      failureMessage: null,
    };

    this.jobs.set(job.jobId, job);
    return cloneJob(job);
  }

  find(jobId: JobId): StoredTranscriptionJob | null {
    const job = this.jobs.get(jobId);
    return job === undefined ? null : cloneJob(job);
  }

  update(jobId: JobId, patch: JobLifecyclePatch, updatedAt: number): StoredTranscriptionJob | null {
    const current = this.jobs.get(jobId);
    if (current === undefined) {
      return null;
    }
    if (!Number.isFinite(updatedAt)) {
      throw new TypeError('A finite update timestamp is required.');
    }

    // Terminal states are immutable. Returning a clone also prevents callers
    // from mutating the repository when they receive a stale update result.
    if (current.status === 'completed' || current.status === 'failed') {
      return cloneJob(current);
    }

    const providerHandle =
      patch.providerHandle === undefined
        ? current.providerHandle
        : normalizeProviderHandle(patch.providerHandle);

    let next: StoredTranscriptionJob;
    switch (patch.status) {
      case 'queued':
      case 'processing':
        next = {
          ...current,
          status: patch.status,
          updatedAt,
          providerHandle,
          transcriptText: null,
          confidenceScore: null,
          tokens: null,
          failureMessage: null,
        };
        break;
      case 'completed': {
        if (typeof patch.transcriptText !== 'string') {
          next = {
            ...current,
            status: 'failed',
            updatedAt,
            providerHandle,
            transcriptText: null,
            confidenceScore: null,
            tokens: null,
            failureMessage: GENERIC_PUBLIC_FAILURE_MESSAGE,
          };
          break;
        }
        const validConfidence =
          typeof patch.confidenceScore === 'number' && Number.isFinite(patch.confidenceScore)
            ? patch.confidenceScore
            : null;
        const validTokens =
          Array.isArray(patch.tokens) && patch.tokens.every(isTranscriptToken)
            ? (patch.tokens as readonly TranscriptToken[])
            : null;
        next = {
          ...current,
          status: 'completed',
          updatedAt,
          providerHandle,
          transcriptText: patch.transcriptText,
          confidenceScore: validConfidence,
          tokens: validTokens,
          failureMessage: null,
        };
        break;
      }
      case 'failed':
        next = {
          ...current,
          status: 'failed',
          updatedAt,
          providerHandle,
          transcriptText: null,
          confidenceScore: null,
          tokens: null,
          failureMessage: sanitizePublicFailureMessage(patch.failureMessage),
        };
        break;
    }

    this.jobs.set(jobId, next);
    return cloneJob(next);
  }

  count(): number {
    return this.jobs.size;
  }
}

/** Semantic alias for callers that use the full domain name. */
export const InMemoryTranscriptionJobRepository = InMemoryJobRepository;
