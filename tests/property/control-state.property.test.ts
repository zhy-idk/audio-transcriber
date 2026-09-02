import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  areSettingsLocked,
  canDownloadTranscript,
  canStartNewTranscription,
  createInitialClientState,
  reduceClientStatus,
  startClientJob,
  type ClientTranscriptionState,
} from '../../src/client/state';
import { FAILURE_DETAILS_UNAVAILABLE_MESSAGE } from '../../src/shared';

const jobIdArbitrary = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const transcriptArbitrary = fc.string();
const activeStatusArbitrary = fc.constantFrom(
  'queued' as const,
  'processing' as const,
  'completed' as const,
  'failed' as const,
);

const validFailureMessageArbitrary = fc
  .string({ minLength: 1, maxLength: 1_024 })
  .filter((message) => Array.from(message).length >= 1 && Array.from(message).length <= 1_024);

type FailureDetailCase =
  | { readonly includeDetail: false; readonly detail?: never; readonly expected: string }
  | { readonly includeDetail: true; readonly detail: unknown; readonly expected: string };

const invalidFailureDetailArbitrary = fc.oneof(
  fc.constant({ includeDetail: false as const, expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE }),
  fc.constant({ includeDetail: true as const, detail: '', expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE }),
  fc.constant({
    includeDetail: true as const,
    detail: 'x'.repeat(1_025),
    expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE,
  }),
  fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer()),
    fc.constant({ detail: 'internal failure' }),
  ).map((detail) => ({
    includeDetail: true as const,
    detail,
    expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE,
  })),
);

const failureDetailArbitrary: fc.Arbitrary<FailureDetailCase> = fc.oneof(
  validFailureMessageArbitrary.map((detail) => ({
    includeDetail: true as const,
    detail,
    expected: detail,
  })),
  invalidFailureDetailArbitrary,
);

/** A local control fake models the browser controls without creating a DOM or making requests. */
class LocalControlFake {
  public settingsDisabled = false;
  public startNewEnabled = false;
  public downloadEnabled = false;

  public render(state: ClientTranscriptionState): void {
    this.settingsDisabled = areSettingsLocked(state);
    this.startNewEnabled = canStartNewTranscription(state);
    this.downloadEnabled = canDownloadTranscript(state);
  }
}

function stateForStatus(
  jobId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  transcriptText: string,
  failureCase: FailureDetailCase,
): ClientTranscriptionState {
  const queuedState = startClientJob(createInitialClientState(), {
    jobId,
    status: 'queued',
  });

  if (status === 'queued') {
    return queuedState;
  }

  if (status === 'processing') {
    return reduceClientStatus(queuedState, { jobId, status: 'processing' });
  }

  if (status === 'completed') {
    return reduceClientStatus(queuedState, {
      jobId,
      status: 'completed',
      transcriptText,
    });
  }

  const failedUpdate = failureCase.includeDetail
    ? { jobId, status: 'failed' as const, failureMessage: failureCase.detail }
    : { jobId, status: 'failed' as const };
  return reduceClientStatus(queuedState, failedUpdate);
}

describe('Property 8: active-state controls and failure details normalize safely', () => {
  /**
   * Feature: soniox-audio-transcription, Property 8: For every active-job state, valid failed message M of 1–1,024 characters, and invalid failed detail D that is absent, empty, or longer than 1,024 characters, the settings control is disabled exactly for queued and processing active jobs; a valid failed update exposes M unchanged; and an invalid failed update exposes the standard failure-details-unavailable message.
   * **Validates: Requirements 3.3, 4.3, 4.6.**
   */
  it('locks active settings, normalizes failed details, and exposes terminal controls', () => {
    fc.assert(
      fc.property(
        jobIdArbitrary,
        activeStatusArbitrary,
        transcriptArbitrary,
        failureDetailArbitrary,
        (jobId, status, transcriptText, failureCase) => {
          const state = stateForStatus(jobId, status, transcriptText, failureCase);
          const controls = new LocalControlFake();
          controls.render(state);

          expect(state.activeJobId).toBe(jobId);
          expect(controls.settingsDisabled).toBe(status === 'queued' || status === 'processing');

          if (status === 'failed') {
            expect(state.failureMessage).toBe(failureCase.expected);
            expect(state.transcriptText).toBeNull();
            expect(controls.startNewEnabled).toBe(true);
            expect(controls.downloadEnabled).toBe(false);
          } else if (status === 'completed') {
            expect(state.failureMessage).toBeNull();
            expect(state.transcriptText).toBe(transcriptText);
            expect(controls.startNewEnabled).toBe(false);
            expect(controls.downloadEnabled).toBe(true);
          } else {
            expect(state.failureMessage).toBeNull();
            expect(state.transcriptText).toBeNull();
            expect(controls.startNewEnabled).toBe(false);
            expect(controls.downloadEnabled).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
