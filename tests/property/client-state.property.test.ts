import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  areSettingsLocked,
  createInitialClientState,
  reduceClientStatus,
  startClientJob,
} from '../../src/client/state';
import { FAILURE_DETAILS_UNAVAILABLE_MESSAGE } from '../../src/shared';

const jobIdArbitrary = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const transcriptArbitrary = fc.string();
const validFailureMessageArbitrary = fc
  .string({ minLength: 1, maxLength: 1_024 })
  .filter((message) => Array.from(message).length >= 1 && Array.from(message).length <= 1_024);

type FailureCase =
  | { readonly includeDetail: false; readonly expected: string }
  | { readonly includeDetail: true; readonly detail: unknown; readonly expected: string };

const failureCaseArbitrary: fc.Arbitrary<FailureCase> = fc.oneof(
  validFailureMessageArbitrary.map((message) => ({
    includeDetail: true as const,
    detail: message,
    expected: message,
  })),
  fc.constant({ includeDetail: false as const, expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE }),
  fc.constant({ includeDetail: true as const, detail: '', expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE }),
  fc.constant({ includeDetail: true as const, detail: 'x'.repeat(1_025), expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE }),
  fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.integer())).map((detail) => ({
    includeDetail: true as const,
    detail,
    expected: FAILURE_DETAILS_UNAVAILABLE_MESSAGE,
  })),
);

type StatusUpdateShape =
  | { readonly status: 'queued' }
  | { readonly status: 'processing' }
  | { readonly status: 'completed'; readonly transcriptText: string }
  | { readonly status: 'failed'; readonly failureMessage: string };

const statusUpdateShapeArbitrary: fc.Arbitrary<StatusUpdateShape> = fc.oneof(
  fc.constant({ status: 'queued' as const }),
  fc.constant({ status: 'processing' as const }),
  transcriptArbitrary.map((transcriptText) => ({
    status: 'completed' as const,
    transcriptText,
  })),
  validFailureMessageArbitrary.map((failureMessage) => ({
    status: 'failed' as const,
    failureMessage,
  })),
);

describe('Property 3: terminal status and active-job display are stable', () => {
  /**
   * Feature: soniox-audio-transcription, Property 3: For every Transcription_Job identifier J, Terminal_Status T, and sequence of later Status_Updates identifying J, reducing the sequence after recording T retains T as the Browser_Client state for J. For every distinct Transcription_Job identifier K, a Status_Update identifying K does not change the displayed status of the Active_Transcription_Job J.
   * **Validates: Requirements 4.5, 4.8.**
   */
  it('correlates active updates, preserves terminal state, clears replaced transcripts, and normalizes failures', () => {
    fc.assert(
      fc.property(
        jobIdArbitrary,
        jobIdArbitrary,
        transcriptArbitrary,
        fc.array(fc.constantFrom('queued' as const, 'processing' as const)),
        fc.array(statusUpdateShapeArbitrary),
        fc.array(statusUpdateShapeArbitrary),
        failureCaseArbitrary,
        (activeJobId, replacementJobId, completedTranscript, activeUpdates, laterUpdates, mismatchedUpdates, failureCase) => {
          fc.pre(activeJobId !== replacementJobId);

          let activeState = startClientJob(createInitialClientState(), {
            jobId: activeJobId,
            status: 'queued',
          });
          expect(activeState.activeJobId).toBe(activeJobId);
          expect(areSettingsLocked(activeState)).toBe(true);

          for (const status of activeUpdates) {
            const nextState = reduceClientStatus(activeState, { jobId: activeJobId, status });
            expect(nextState.activeJobId).toBe(activeJobId);
            expect(nextState.status).toBe(status);
            expect(nextState.transcriptText).toBeNull();
            expect(areSettingsLocked(nextState)).toBe(true);
            activeState = nextState;
          }

          for (const update of mismatchedUpdates) {
            expect(reduceClientStatus(activeState, { jobId: replacementJobId, ...update })).toBe(activeState);
          }

          const completedState = reduceClientStatus(activeState, {
            jobId: activeJobId,
            status: 'completed',
            transcriptText: completedTranscript,
          });
          expect(completedState.status).toBe('completed');
          expect(completedState.transcriptText).toBe(completedTranscript);
          expect(completedState.failureMessage).toBeNull();
          expect(areSettingsLocked(completedState)).toBe(false);

          for (const update of laterUpdates) {
            expect(reduceClientStatus(completedState, { jobId: activeJobId, ...update })).toBe(completedState);
          }
          for (const update of mismatchedUpdates) {
            expect(reduceClientStatus(completedState, { jobId: replacementJobId, ...update })).toBe(completedState);
          }

          const replacementState = startClientJob(completedState, {
            jobId: replacementJobId,
            status: 'queued',
          });
          expect(replacementState.activeJobId).toBe(replacementJobId);
          expect(replacementState.status).toBe('queued');
          expect(replacementState.transcriptText).toBeNull();
          expect(replacementState.failureMessage).toBeNull();
          expect(areSettingsLocked(replacementState)).toBe(true);

          const failedUpdate = failureCase.includeDetail
            ? {
                jobId: replacementJobId,
                status: 'failed' as const,
                failureMessage: failureCase.detail,
              }
            : { jobId: replacementJobId, status: 'failed' as const };
          const failedState = reduceClientStatus(replacementState, failedUpdate);

          expect(failedState.status).toBe('failed');
          expect(failedState.failureMessage).toBe(failureCase.expected);
          expect(failedState.transcriptText).toBeNull();
          expect(areSettingsLocked(failedState)).toBe(false);

          for (const update of laterUpdates) {
            expect(reduceClientStatus(failedState, { jobId: replacementJobId, ...update })).toBe(failedState);
          }
          for (const update of mismatchedUpdates) {
            expect(reduceClientStatus(failedState, { jobId: activeJobId, ...update })).toBe(failedState);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
