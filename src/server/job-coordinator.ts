/**
 * Backend-only transcription job lifecycle coordination.
 *
 * The coordinator is the only layer that combines request validation, the
 * credential store, the Soniox gateway, and the process-local repository. It
 * returns public status objects but never stores or returns credentials,
 * provider handles, provider payloads, or raw exceptions.
 */

import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDiarizedTranscript,
  isJobId,
  isTranscriptionSettings,
  normalizeTranscriptionSettings,
  type JobId,
  type PublicFailureMessage,
  type StatusUpdate,
  type TranscriptionSettings,
} from '../shared/transcription.js';
import { getAcceptedAudioFile } from './request-validation.js';
import {
  GENERIC_PUBLIC_FAILURE_MESSAGE,
  REJECTED_REQUEST_FAILURE_MESSAGE,
  SUBMISSION_FAILED_FAILURE_MESSAGE,
  SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE,
  mapPublicStatus,
  sanitizePublicFailureMessage,
} from './public-status.js';
import {
  InMemoryJobRepository,
  type JobLifecyclePatch,
  type JobRepository,
  type StoredTranscriptionJob,
} from './job-repository.js';
import type {
  ProviderFailureContext,
  ProviderOutcome,
  SonioxCredential,
  SonioxCredentialStore,
  SonioxGateway,
  SonioxProviderHandle,
  SonioxSubmissionResult,
} from './soniox.js';
import {
  EnvironmentGroqCredentialStore,
  type GroqCredential,
  type GroqCredentialStore,
  type GroqGateway,
  type GroqSubmissionResult,
} from './groq.js';
import { GroqApiGateway } from './groq-api.js';
import type { SpeakerIdentificationService } from './speaker-identification.js';

export interface AcceptedTranscriptionResult {
  readonly accepted: true;
  readonly status: StatusUpdate;
}

export interface RejectedTranscriptionResult {
  readonly accepted: false;
  readonly failureMessage: PublicFailureMessage;
}

export type CreateTranscriptionResult = AcceptedTranscriptionResult | RejectedTranscriptionResult;

export type JobIdGenerator = () => string;
export type BackendClock = () => number;

export interface JobCoordinatorOptions {
  readonly repository: JobRepository;
  readonly credentialStore: SonioxCredentialStore;
  readonly gateway: SonioxGateway;
  readonly clock?: BackendClock | undefined;
  readonly jobIdGenerator?: JobIdGenerator | undefined;
  readonly speakerService?: SpeakerIdentificationService | undefined;
  readonly groqCredentialStore?: GroqCredentialStore | undefined;
  readonly groqGateway?: GroqGateway | undefined;
}

function defaultJobIdGenerator(): string {
  return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUsableCredential(value: unknown): value is SonioxCredential {
  return typeof value === 'string' && value.trim().length > 0;
}

function isProviderOutcome(value: unknown): value is ProviderOutcome {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return false;
  }

  switch (value.status) {
    case 'queued':
    case 'processing':
      return true;
    case 'completed':
      return typeof value.transcriptText === 'string';
    case 'failed':
      return isRecord(value.context);
    default:
      return false;
  }
}

function isSubmissionResult(value: unknown): value is SonioxSubmissionResult {
  return isRecord(value) && isProviderOutcome(value.outcome);
}

function providerFailureMessage(outcome: Extract<ProviderOutcome, { readonly status: 'failed' }>): unknown {
  const context = outcome.context as ProviderFailureContext;
  return typeof context.message === 'string' ? context.message : undefined;
}

function publicStatus(job: StoredTranscriptionJob): StatusUpdate {
  const mapped = mapPublicStatus({
    jobId: job.jobId,
    status: job.status,
    transcriptText: job.transcriptText ?? undefined,
    confidenceScore: job.confidenceScore ?? undefined,
    tokens: job.tokens ?? undefined,
    failureMessage: job.failureMessage ?? undefined,
  });

  // Repository invariants make this unreachable. Keeping the guard here means
  // a future repository implementation cannot accidentally return an unsafe
  // or malformed public object.
  if (mapped === null) {
    throw new Error('Stored transcription job could not be mapped to public status.');
  }
  return mapped;
}

/**
 * Coordinates one accepted upload from creation through provider refreshes.
 * The default repository is process-local; callers can inject another
 * repository without changing the lifecycle or public response contract.
 */
export class JobCoordinator {
  private readonly repository: JobRepository;
  private readonly credentialStore: SonioxCredentialStore;
  private readonly gateway: SonioxGateway;
  private readonly clock: BackendClock;
  private readonly jobIdGenerator: JobIdGenerator;
  private readonly speakerService: SpeakerIdentificationService | undefined;
  private readonly groqCredentialStore: GroqCredentialStore;
  private readonly groqGateway: GroqGateway;
  private readonly audioFiles = new Map<string, { readonly path: string; readonly mimeType: string; readonly filename: string }>();

  constructor(options: JobCoordinatorOptions) {
    this.repository = options.repository;
    this.credentialStore = options.credentialStore;
    this.gateway = options.gateway;
    this.clock = options.clock ?? Date.now;
    this.jobIdGenerator = options.jobIdGenerator ?? defaultJobIdGenerator;
    this.speakerService = options.speakerService;
    this.groqCredentialStore = options.groqCredentialStore ?? new EnvironmentGroqCredentialStore();
    this.groqGateway = options.groqGateway ?? new GroqApiGateway();
  }

  /**
   * Validates before any repository, credential-store, or gateway side effect.
   * An accepted request creates exactly one job, including when provider work
   * later fails, so every failure remains correlated to a job identifier.
   */
  async create(selection: unknown, settings: unknown): Promise<CreateTranscriptionResult> {
    const file = getAcceptedAudioFile(selection);
    if (file === null || !isTranscriptionSettings(settings)) {
      return {
        accepted: false,
        failureMessage: sanitizePublicFailureMessage(REJECTED_REQUEST_FAILURE_MESSAGE),
      };
    }

    const parsedSettings = normalizeTranscriptionSettings(settings);
    const jobId = this.createUniqueJobId();
    const created = this.repository.create({
      jobId,
      settings,
      createdAt: this.clock(),
    });

    if (file && typeof (file as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
      try {
        const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.wav';
        const tempPath = join(tmpdir(), `job-${jobId}${ext}`);
        await writeFile(tempPath, Buffer.from(await file.arrayBuffer()));
        this.audioFiles.set(jobId, {
          path: tempPath,
          mimeType: file.type || 'audio/wav',
          filename: file.name,
        });
      } catch {
        // audio cache failure does not fail transcription
      }
    }

    if (parsedSettings.provider === 'groq') {
      let groqCredential: GroqCredential;
      try {
        groqCredential = await this.groqCredentialStore.getCredential();
        if (!isUsableCredential(groqCredential)) {
          return this.acceptedFailure(
            created.jobId,
            'Groq credential is unavailable. Please set GROQ_API_KEY in your .env file.',
          );
        }
      } catch {
        return this.acceptedFailure(
          created.jobId,
          'Groq credential is unavailable. Please set GROQ_API_KEY in your .env file.',
        );
      }

      let submission: GroqSubmissionResult;
      try {
        submission = await this.groqGateway.submit({ file, settings }, groqCredential);
      } catch {
        return this.acceptedFailure(created.jobId, SUBMISSION_FAILED_FAILURE_MESSAGE);
      }

      let outcome = submission.outcome;
      if (outcome.status === 'completed' && parsedSettings.enableDiarization && this.speakerService) {
        const audioEntry = this.audioFiles.get(created.jobId);
        if (audioEntry && outcome.tokens && outcome.tokens.length > 0) {
          try {
            const diarized = await this.speakerService.diarize(audioEntry.path, outcome.tokens);
            if (diarized && diarized.tokens && diarized.tokens.length > 0) {
              outcome = {
                ...outcome,
                tokens: diarized.tokens,
                transcriptText: formatDiarizedTranscript(diarized.tokens),
              };
            }
          } catch {
            // Keep raw tokens if diarization fails
          }
        }
      }

      const updated = this.applyProviderOutcome(created.jobId, outcome, null);
      return { accepted: true, status: publicStatus(updated) };
    }

    let credential: SonioxCredential;
    try {
      credential = await this.credentialStore.getCredential();
      if (!isUsableCredential(credential)) {
        return this.acceptedFailure(
          created.jobId,
          SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE,
        );
      }
    } catch {
      return this.acceptedFailure(
        created.jobId,
        SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE,
      );
    }

    let submission: SonioxSubmissionResult;
    try {
      const result: unknown = await this.gateway.submit({ file, settings }, credential);
      if (!isSubmissionResult(result)) {
        return this.acceptedFailure(created.jobId, SUBMISSION_FAILED_FAILURE_MESSAGE);
      }
      submission = result;
    } catch {
      return this.acceptedFailure(created.jobId, SUBMISSION_FAILED_FAILURE_MESSAGE);
    }

    const providerHandle =
      typeof submission.providerHandle === 'string' && submission.providerHandle.length > 0
        ? submission.providerHandle
        : null;
    const processedOutcome = await this.relabelOutcomeIfDiarized(created.jobId, submission.outcome);
    const updated = this.applyProviderOutcome(created.jobId, processedOutcome, providerHandle);

    return { accepted: true, status: publicStatus(updated) };
  }

  /** Semantic aliases for API handlers and callers using domain-specific names. */
  async createTranscription(selection: unknown, settings: unknown): Promise<CreateTranscriptionResult> {
    return this.create(selection, settings);
  }

  async createJob(selection: unknown, settings: unknown): Promise<CreateTranscriptionResult> {
    return this.create(selection, settings);
  }

  /**
   * Returns the latest public status. Non-terminal jobs are refreshed through
   * the backend-only gateway; terminal jobs are returned from storage without
   * another credential lookup or provider call.
   */
  async getStatus(jobId: unknown): Promise<StatusUpdate | null> {
    if (!isJobId(jobId)) {
      return null;
    }

    const current = this.repository.find(jobId);
    if (current === null) {
      return null;
    }
    if (current.status === 'completed' || current.status === 'failed' || current.providerHandle === null) {
      return publicStatus(current);
    }

    let credential: SonioxCredential;
    try {
      credential = await this.credentialStore.getCredential();
      if (!isUsableCredential(credential)) {
        return publicStatus(this.markFailed(jobId, SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE));
      }
    } catch {
      return publicStatus(this.markFailed(jobId, SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE));
    }

    let outcome: ProviderOutcome;
    try {
      const refreshed: unknown = await this.gateway.refresh(current.providerHandle, credential);
      if (!isProviderOutcome(refreshed)) {
        return publicStatus(this.markFailed(jobId, SUBMISSION_FAILED_FAILURE_MESSAGE));
      }
      outcome = refreshed;
    } catch {
      return publicStatus(this.markFailed(jobId, SUBMISSION_FAILED_FAILURE_MESSAGE));
    }

    const processedOutcome = await this.relabelOutcomeIfDiarized(jobId, outcome);
    const updated = this.applyProviderOutcome(jobId, processedOutcome);
    return publicStatus(updated);
  }

  private async relabelOutcomeIfDiarized(jobId: JobId, outcome: ProviderOutcome): Promise<ProviderOutcome> {
    if (outcome.status !== 'completed' || !this.speakerService) {
      return outcome;
    }
    const audioEntry = this.audioFiles.get(jobId);
    if (!audioEntry || !outcome.tokens || !outcome.tokens.some((t) => Boolean(t.speaker))) {
      return outcome;
    }
    try {
      const speakers = await this.speakerService.list();
      if (speakers.length > 0) {
        const relabeled = await this.speakerService.relabel(audioEntry.path, outcome.tokens);
        if (relabeled && Object.keys(relabeled.speaker_mapping).length > 0) {
          return {
            ...outcome,
            tokens: relabeled.tokens,
            transcriptText: formatDiarizedTranscript(relabeled.tokens),
          };
        }
      }
    } catch {
      // Gracefully fall back to Soniox tokens
    }
    return outcome;
  }

  cleanupAudio(jobId: JobId): void {
    const audioEntry = this.audioFiles.get(jobId);
    if (audioEntry) {
      this.audioFiles.delete(jobId);
      void unlink(audioEntry.path).catch(() => undefined);
    }
  }

  async getAudio(jobId: unknown): Promise<{ readonly path: string; readonly mimeType: string; readonly filename: string } | null> {
    if (!isJobId(jobId)) {
      return null;
    }
    return this.audioFiles.get(jobId) ?? null;
  }

  async getJob(jobId: unknown): Promise<StoredTranscriptionJob | null> {
    if (!isJobId(jobId)) {
      return null;
    }
    return this.repository.find(jobId);
  }

  async getJobStatus(jobId: unknown): Promise<StatusUpdate | null> {
    return this.getStatus(jobId);
  }

  private createUniqueJobId(): JobId {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.jobIdGenerator();
      if (isJobId(candidate) && this.repository.find(candidate) === null) {
        return candidate;
      }

      // A caller-supplied generator is useful in tests, but production IDs
      // must remain cryptographically strong and collision-resistant.
      const fallback = defaultJobIdGenerator();
      if (this.repository.find(fallback) === null) {
        return fallback;
      }
    }

    throw new Error('Unable to allocate a unique transcription job identifier.');
  }

  private applyProviderOutcome(
    jobId: JobId,
    outcome: ProviderOutcome,
    providerHandle?: SonioxProviderHandle | null,
  ): StoredTranscriptionJob {
    let patch: JobLifecyclePatch;
    switch (outcome.status) {
      case 'queued':
        patch = providerHandle === undefined ? { status: 'queued' } : { status: 'queued', providerHandle };
        break;
      case 'processing':
        patch = providerHandle === undefined ? { status: 'processing' } : { status: 'processing', providerHandle };
        break;
      case 'completed':
        patch = {
          status: 'completed',
          transcriptText: outcome.transcriptText,
          confidenceScore: outcome.confidenceScore,
          tokens: outcome.tokens,
          ...(providerHandle !== undefined ? { providerHandle } : {}),
        };
        break;
      case 'failed': {
        const failureMessage = sanitizePublicFailureMessage(
          providerFailureMessage(outcome),
          GENERIC_PUBLIC_FAILURE_MESSAGE,
        );
        patch =
          providerHandle === undefined
            ? { status: 'failed', failureMessage }
            : { status: 'failed', failureMessage, providerHandle };
        break;
      }
    }

    const updated = this.repository.update(jobId, patch, this.clock());
    if (updated === null) {
      throw new Error('The transcription job no longer exists.');
    }
    return updated;
  }

  private markFailed(jobId: JobId, failureMessage: unknown): StoredTranscriptionJob {
    const updated = this.repository.update(
      jobId,
      {
        status: 'failed',
        failureMessage: sanitizePublicFailureMessage(failureMessage),
      },
      this.clock(),
    );
    if (updated === null) {
      throw new Error('The transcription job no longer exists.');
    }
    return updated;
  }

  private acceptedFailure(jobId: JobId, failureMessage: unknown): AcceptedTranscriptionResult {
    this.cleanupAudio(jobId);
    return {
      accepted: true,
      status: publicStatus(this.markFailed(jobId, failureMessage)),
    };
  }
}

/** Creates a coordinator with the process-local repository for simple deployments. */
export function createInMemoryJobCoordinator(options: Omit<JobCoordinatorOptions, 'repository'> & {
  readonly repository?: JobRepository;
}): JobCoordinator {
  return new JobCoordinator({
    ...options,
    repository: options.repository ?? new InMemoryJobRepository(),
  });
}
