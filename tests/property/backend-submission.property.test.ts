import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { JobCoordinator } from '../../src/server/job-coordinator';
import {
  InMemoryJobRepository,
  type CreateStoredJobInput,
  type JobLifecyclePatch,
  type JobRepository,
  type StoredTranscriptionJob,
} from '../../src/server/job-repository';
import type {
  AcceptedAudioFile,
  JobId,
  TranscriptionSettings,
} from '../../src/shared/transcription';
import type {
  SonioxCredential,
  SonioxCredentialStore,
  SonioxGateway,
  SonioxProviderHandle,
  SonioxSubmissionResult,
  SonioxGatewaySubmission,
} from '../../src/server/soniox';

interface AcceptedSubmissionCase {
  readonly file: AcceptedAudioFile;
  readonly settings: TranscriptionSettings;
  readonly credential: SonioxCredential;
  readonly providerHandle: SonioxProviderHandle;
}

interface InvalidSubmissionCase {
  readonly selection: unknown;
  readonly settings: unknown;
}

interface RepositoryCallCounts {
  create: number;
  find: number;
  update: number;
  count: number;
}

interface ObservedRepository {
  readonly repository: JobRepository;
  readonly inner: InMemoryJobRepository;
  readonly calls: RepositoryCallCounts;
}

const acceptedFilenameArbitrary = fc
  .string({ minLength: 1, maxLength: 255 })
  .map((name) => ({ name, type: 'audio/wav' }) as AcceptedAudioFile);
const settingsArbitrary = fc.string({ minLength: 1, maxLength: 48 }) as fc.Arbitrary<TranscriptionSettings>;
const credentialArbitrary = fc
  .string({ minLength: 0, maxLength: 48 })
  .map((value) => `secret:${value}` as SonioxCredential);
const providerHandleArbitrary = fc
  .string({ minLength: 0, maxLength: 48 })
  .map((value) => `handle:${value}` as SonioxProviderHandle);

const acceptedSubmissionArbitrary: fc.Arbitrary<AcceptedSubmissionCase> = fc.record({
  file: acceptedFilenameArbitrary,
  settings: settingsArbitrary,
  credential: credentialArbitrary,
  providerHandle: providerHandleArbitrary,
});

const invalidSelectionArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant([]),
  fc.constant([{ name: 'not-audio.txt', type: 'text/plain' }]),
  fc.constant([{ name: '', type: 'audio/wav' }]),
  fc.constant([{ name: 'a'.repeat(256), type: 'audio/wav' }]),
  fc.constant([
    { name: 'first.wav', type: 'audio/wav' },
    { name: 'second.wav', type: 'audio/wav' },
  ]),
  fc.constant(null),
  fc.constant(['not a browser file']),
);

const invalidSubmissionArbitrary: fc.Arbitrary<InvalidSubmissionCase> = fc.oneof(
  invalidSelectionArbitrary.map((selection) => ({ selection, settings: 'automatic' })),
  acceptedFilenameArbitrary.map((file) => ({ selection: [file], settings: '' })),
);

function createObservedRepository(): ObservedRepository {
  const inner = new InMemoryJobRepository();
  const calls: RepositoryCallCounts = { create: 0, find: 0, update: 0, count: 0 };
  const repository: JobRepository = {
    create(input: CreateStoredJobInput): StoredTranscriptionJob {
      calls.create += 1;
      return inner.create(input);
    },
    find(jobId: JobId): StoredTranscriptionJob | null {
      calls.find += 1;
      return inner.find(jobId);
    },
    update(jobId: JobId, patch: JobLifecyclePatch, updatedAt: number): StoredTranscriptionJob | null {
      calls.update += 1;
      return inner.update(jobId, patch, updatedAt);
    },
    count(): number {
      calls.count += 1;
      return inner.count();
    },
  };

  return { repository, inner, calls };
}

describe('backend submission isolation properties', () => {
  it('preserves accepted submissions while keeping invalid requests and backend-private values isolated', async () => {
    // Feature: soniox-audio-transcription, Property 2: For every accepted audio file A, selected setting S, arbitrary credential C, and finite sequence of non-rejected submissions executed with local gateway and credential-store fakes, the Browser Client makes exactly one backend request containing A and S and no direct provider request. The Backend Service obtains C only from the credential-store fake, submits A and S through the gateway using C, assigns pairwise-unique job identifiers, and exposes no C or server-internal error detail in client-visible requests, responses, state, or rendered output.
    let executedCases = 0;

    await fc.assert(
      fc.asyncProperty(
        invalidSubmissionArbitrary,
        fc.array(acceptedSubmissionArbitrary, { minLength: 1, maxLength: 8 }),
        async (invalidSubmission, acceptedSubmissions) => {
          executedCases += 1;
          const observedRepository = createObservedRepository();
          const credentialReads: SonioxCredential[] = [];
          const submitted: Array<{
            readonly submission: SonioxGatewaySubmission;
            readonly credential: SonioxCredential;
          }> = [];

          const credentialStore: SonioxCredentialStore = {
            async getCredential(): Promise<SonioxCredential> {
              const request = acceptedSubmissions[credentialReads.length];
              if (request === undefined) {
                throw new Error('Unexpected credential read in local fake.');
              }
              credentialReads.push(request.credential);
              return request.credential;
            },
          };

          const gateway: SonioxGateway = {
            async submit(
              submission: SonioxGatewaySubmission,
              credential: SonioxCredential,
            ): Promise<SonioxSubmissionResult> {
              const request = acceptedSubmissions[submitted.length];
              if (request === undefined) {
                throw new Error('Unexpected provider submission in local fake.');
              }
              submitted.push({ submission, credential });
              return {
                providerHandle: request.providerHandle,
                outcome: { status: 'queued' },
              };
            },
            async refresh(): Promise<never> {
              throw new Error('Refresh must not occur during submission isolation.');
            },
          };

          const coordinator = new JobCoordinator({
            repository: observedRepository.repository,
            credentialStore,
            gateway,
            clock: () => 1,
          });

          const invalidResult = await coordinator.create(
            invalidSubmission.selection,
            invalidSubmission.settings,
          );
          expect(invalidResult).toEqual({
            accepted: false,
            failureMessage: 'Exactly one audio file is required.',
          });
          expect(observedRepository.calls).toEqual({ create: 0, find: 0, update: 0, count: 0 });
          expect(observedRepository.inner.count()).toBe(0);
          expect(credentialReads).toHaveLength(0);
          expect(submitted).toHaveLength(0);

          const results = [];
          for (const request of acceptedSubmissions) {
            const result = await coordinator.create([request.file], request.settings);
            expect(result.accepted).toBe(true);
            if (!result.accepted) {
              throw new Error('The generated accepted request was rejected.');
            }
            results.push({ request, result });
          }

          expect(credentialReads).toEqual(acceptedSubmissions.map(({ credential }) => credential));
          expect(submitted).toHaveLength(acceptedSubmissions.length);
          expect(observedRepository.calls.create).toBe(acceptedSubmissions.length);
          expect(observedRepository.calls.update).toBe(acceptedSubmissions.length);
          expect(observedRepository.inner.count()).toBe(acceptedSubmissions.length);

          for (const [index, { request, result }] of results.entries()) {
            const providerCall = submitted[index];
            if (providerCall === undefined) {
              throw new Error('The local provider fake did not record a submission.');
            }

            expect(providerCall.submission.file).toBe(request.file);
            expect(providerCall.submission.file.name).toBe(request.file.name);
            expect(providerCall.submission.settings).toBe(request.settings);
            expect(providerCall.credential).toBe(request.credential);

            expect(result.status).toEqual({
              jobId: expect.any(String),
              status: 'queued',
            });
            expect(Object.keys(result.status).sort()).toEqual(['jobId', 'status']);
            expect(JSON.stringify(result.status)).not.toContain(request.credential);
            expect(JSON.stringify(result.status)).not.toContain(request.providerHandle);

            const stored = observedRepository.inner.find(result.status.jobId);
            expect(stored).toMatchObject({
              jobId: result.status.jobId,
              settings: request.settings,
              status: 'queued',
              providerHandle: request.providerHandle,
              transcriptText: null,
              failureMessage: null,
            });
            expect(Object.keys(stored ?? {})).not.toContain('credential');
          }

          const jobIds = results.map(({ result }) => result.status.jobId);
          expect(new Set(jobIds).size).toBe(jobIds.length);
          for (const jobId of jobIds) {
            expect(jobId).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(jobId.length).toBeGreaterThan(0);
            expect(jobId.length).toBeLessThanOrEqual(256);
          }
        },
      ),
      { numRuns: 100 },
    );

    expect(executedCases).toBeGreaterThanOrEqual(100);
  });
});
