import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { JobCoordinator } from '../../src/server/job-coordinator';
import { InMemoryJobRepository } from '../../src/server/job-repository';
import type {
  ProviderOutcome,
  SonioxCredential,
  SonioxCredentialStore,
  SonioxGateway,
  SonioxProviderHandle,
} from '../../src/server/soniox';
import {
  isJobId,
  type AcceptedAudioFile,
  type StatusUpdate,
} from '../../src/shared/transcription';

type ScenarioMode =
  | 'accepted-completed'
  | 'accepted-provider-failure'
  | 'missing-credential'
  | 'submission-failure'
  | 'rejected-request';

const scenarioArbitrary = fc.record({
  mode: fc.constantFrom<ScenarioMode>(
    'accepted-completed',
    'accepted-provider-failure',
    'missing-credential',
    'submission-failure',
    'rejected-request',
  ),
  initialStatus: fc.constantFrom<'queued' | 'processing'>('queued', 'processing'),
  credentialSeed: fc.string({ minLength: 1, maxLength: 32 }),
  diagnosticSeed: fc.string({ minLength: 1, maxLength: 32 }),
  transcriptSeed: fc.string({ maxLength: 80 }),
  settingsSeed: fc.string({ minLength: 1, maxLength: 24 }),
});

function audioFile(): AcceptedAudioFile {
  return { name: 'recording.wav', type: 'audio/wav' } as AcceptedAudioFile;
}

function expectBoundedFailedStatus(status: StatusUpdate): void {
  expect(status.status).toBe('failed');
  if (status.status !== 'failed') return;

  expect(Array.from(status.failureMessage).length).toBeGreaterThanOrEqual(1);
  expect(Array.from(status.failureMessage).length).toBeLessThanOrEqual(500);
  expect(Object.keys(status).sort()).toEqual(['failureMessage', 'jobId', 'status']);
  expect('transcriptText' in status).toBe(false);
}

function expectNoPrivateValues(value: unknown, privateValues: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    expect(serialized).not.toContain(privateValue);
  }
}

describe('Property 7: backend lifecycle outcomes are exact and client-safe', () => {
  it('maps every generated lifecycle and failure scenario to safe public results', async () => {
    // Feature: soniox-audio-transcription, Property 7: Backend lifecycle outcomes are exact and client-safe. For every accepted job and provider outcome of queued, processing, completed with transcript T, or failed, the Backend Service returns one correlated public status with the same non-terminal state or the exact completed transcript, and a failed status contains a 1–500-character sanitized public message. For every rejected request, missing credential, or provider-submission failure, the service produces the required failed/rejected public outcome, never produces false completion, and makes no prohibited job creation or provider submission side effect.
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const credential = `credential-${scenario.credentialSeed}-secret` as SonioxCredential;
        const providerHandle = `provider-handle-${scenario.credentialSeed}` as SonioxProviderHandle;
        const rawDiagnostic = `raw-diagnostic-${scenario.diagnosticSeed}`;
        const transcript = `${scenario.transcriptSeed}<script>alert("literal")</script>\n終わり\r\n`;
        const settings = `language-${scenario.settingsSeed}`;
        const repository = new InMemoryJobRepository();

        let credentialCalls = 0;
        let submitCalls = 0;
        let refreshCalls = 0;
        let submittedCredential: SonioxCredential | undefined;
        let submittedSettings: string | undefined;
        let submittedProviderHandle: SonioxProviderHandle | undefined;

        const credentialStore: SonioxCredentialStore = {
          async getCredential(): Promise<SonioxCredential> {
            credentialCalls += 1;
            if (scenario.mode === 'missing-credential') {
              throw new Error(`credential store outage: ${rawDiagnostic}`);
            }
            return credential;
          },
        };

        const gateway: SonioxGateway = {
          async submit(submission, receivedCredential) {
            submitCalls += 1;
            submittedCredential = receivedCredential;
            submittedSettings = submission.settings;
            if (scenario.mode === 'submission-failure') {
              throw new Error(`submission stack: ${rawDiagnostic}`);
            }

            const outcome: ProviderOutcome = { status: scenario.initialStatus };
            return { providerHandle, outcome };
          },
          async refresh(receivedProviderHandle, receivedCredential) {
            refreshCalls += 1;
            submittedProviderHandle = receivedProviderHandle;
            submittedCredential = receivedCredential;

            if (scenario.mode === 'accepted-provider-failure') {
              return {
                status: 'failed',
                context: {
                  kind: 'provider',
                  message: `token=${credential}; ${'x'.repeat(700)}; ${rawDiagnostic}`,
                  providerCode: 'RAW_PROVIDER_CODE',
                  statusCode: 502,
                  providerPayload: { credential, rawDiagnostic },
                  cause: new Error(`provider stack: ${rawDiagnostic}`),
                },
              };
            }

            return { status: 'completed', transcriptText: transcript };
          },
        };

        const coordinator = new JobCoordinator({ repository, credentialStore, gateway });
        const privateValues = [credential, providerHandle, rawDiagnostic];

        if (scenario.mode === 'rejected-request') {
          const result = await coordinator.create(
            [{ name: 'not-audio.txt', type: 'text/plain' }],
            settings,
          );

          expect(result).toEqual({
            accepted: false,
            failureMessage: 'Exactly one audio file is required.',
          });
          expect(repository.count()).toBe(0);
          expect(credentialCalls).toBe(0);
          expect(submitCalls).toBe(0);
          expect(refreshCalls).toBe(0);
          expectNoPrivateValues(result, privateValues);
          return;
        }

        const created = await coordinator.create([audioFile()], settings);
        expect(created.accepted).toBe(true);
        if (!created.accepted) return;

        expect(isJobId(created.status.jobId)).toBe(true);
        expectNoPrivateValues(created.status, privateValues);

        if (scenario.mode === 'missing-credential') {
          expectBoundedFailedStatus(created.status);
          expect(created.status.status).not.toBe('completed');
          expect(repository.count()).toBe(1);
          expect(credentialCalls).toBe(1);
          expect(submitCalls).toBe(0);
          expect(refreshCalls).toBe(0);

          const retained = await coordinator.getStatus(created.status.jobId);
          expect(retained).toEqual(created.status);
          expectNoPrivateValues(retained, privateValues);
          expect(credentialCalls).toBe(1);
          expect(refreshCalls).toBe(0);
          return;
        }

        if (scenario.mode === 'submission-failure') {
          expectBoundedFailedStatus(created.status);
          expect(created.status.status).not.toBe('completed');
          expect(repository.count()).toBe(1);
          expect(credentialCalls).toBe(1);
          expect(submitCalls).toBe(1);
          expect(refreshCalls).toBe(0);
          expect(submittedCredential).toBe(credential);
          expect(submittedSettings).toBe(settings);

          const retained = await coordinator.getStatus(created.status.jobId);
          expect(retained).toEqual(created.status);
          expectNoPrivateValues(retained, privateValues);
          expect(credentialCalls).toBe(1);
          expect(refreshCalls).toBe(0);
          return;
        }

        expect(created.status).toEqual({
          jobId: created.status.jobId,
          status: scenario.initialStatus,
        });
        expect(created.status.status === 'queued' || created.status.status === 'processing').toBe(true);
        expect(repository.count()).toBe(1);
        expect(credentialCalls).toBe(1);
        expect(submitCalls).toBe(1);
        expect(refreshCalls).toBe(0);
        expect(submittedCredential).toBe(credential);
        expect(submittedSettings).toBe(settings);

        const terminal = await coordinator.getStatus(created.status.jobId);
        expect(terminal?.jobId).toBe(created.status.jobId);
        // Transcript text is opaque user data and may legitimately contain a
        // token-shaped substring; the exact completed-object assertion below
        // verifies that no private fields are added to that public result.
        if (scenario.mode !== 'accepted-completed') {
          expectNoPrivateValues(terminal, privateValues);
        }
        expect(submittedProviderHandle).toBe(providerHandle);
        expect(submittedCredential).toBe(credential);
        expect(refreshCalls).toBe(1);

        if (scenario.mode === 'accepted-completed') {
          expect(terminal).toEqual({
            jobId: created.status.jobId,
            status: 'completed',
            transcriptText: transcript,
          });
        } else {
          expect(terminal).not.toHaveProperty('transcriptText');
          if (terminal !== null) {
            expectBoundedFailedStatus(terminal);
          }
        }

        const retained = await coordinator.getStatus(created.status.jobId);
        expect(retained).toEqual(terminal);
        if (scenario.mode !== 'accepted-completed') {
          expectNoPrivateValues(retained, privateValues);
        }
        expect(refreshCalls).toBe(1);
        expect(credentialCalls).toBe(2);
      }),
      { numRuns: 100 },
    );
  });
});
