import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { reduceClientStatus, startClientJob, createInitialClientState } from '../../src/client/state';
import { TranscriptViewer } from '../../src/client/transcript-viewer';
import type { StatusUpdate } from '../../src/shared/transcription';

class FakeTextNode {
  public readonly nodeType = 3;

  public constructor(public readonly data: string) {}
}

class FakeClassList {
  public add(..._tokens: string[]): void {
    // TranscriptViewer only needs the DOM class-list add operation during setup.
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly ownerDocument = {
    createTextNode: (value: string) => new FakeTextNode(value),
  };
  public childNodes: FakeTextNode[] = [];

  public setAttribute(_name: string, _value: string): void {
    // Accessibility attributes are not relevant to this state-transition property.
  }

  public replaceChildren(...nodes: FakeTextNode[]): void {
    this.childNodes = nodes;
  }
}

const jobIdArbitrary = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);

/** Includes arbitrary Unicode code points, line breaks, and markup-like text. */
const transcriptTextArbitrary = fc
  .array(
    fc.oneof(
      fc.fullUnicode(),
      fc.constantFrom(
        '\n',
        '\r',
        '\r\n',
        '<script>alert("stale")</script>',
        '<img src=x onerror=alert(1)>',
        '&lt;literal&gt;',
        '🎙️',
        'e\u0301',
      ),
    ),
    { maxLength: 48 },
  )
  .map((parts) => parts.join(''));

const replacementStatusArbitrary = fc.constantFrom<'queued' | 'processing' | 'failed'>(
  'queued',
  'processing',
  'failed',
);
const mismatchedStatusArbitrary = fc.constantFrom<'queued' | 'processing' | 'completed' | 'failed'>(
  'queued',
  'processing',
  'completed',
  'failed',
);

type ReplacementStatus = 'queued' | 'processing' | 'failed';

type PropertyCase = {
  readonly oldJobId: string;
  readonly replacementJobId: string;
  readonly completedJobId: string;
  readonly oldTranscript: string;
  readonly newTranscript: string;
  readonly replacementStatus: ReplacementStatus;
  readonly mismatchedStatuses: readonly ('queued' | 'processing' | 'completed' | 'failed')[];
};

const propertyCaseArbitrary: fc.Arbitrary<PropertyCase> = fc
  .record({
    oldJobId: jobIdArbitrary,
    replacementJobId: jobIdArbitrary,
    completedJobId: jobIdArbitrary,
    oldTranscript: transcriptTextArbitrary,
    newTranscript: transcriptTextArbitrary,
    replacementStatus: replacementStatusArbitrary,
    mismatchedStatuses: fc.array(mismatchedStatusArbitrary, { minLength: 1, maxLength: 8 }),
  })
  .filter(
    ({ oldJobId, replacementJobId, completedJobId, oldTranscript, newTranscript }) =>
      oldJobId !== replacementJobId &&
      oldJobId !== completedJobId &&
      replacementJobId !== completedJobId &&
      oldTranscript !== newTranscript,
  );

function updateForStatus(jobId: string, status: ReplacementStatus): StatusUpdate {
  if (status === 'failed') {
    return { jobId, status, failureMessage: 'The replacement job failed.' };
  }

  return { jobId, status };
}

function mismatchedUpdate(jobId: string, status: PropertyCase['mismatchedStatuses'][number], staleTranscript: string): StatusUpdate {
  switch (status) {
    case 'completed':
      return { jobId, status, transcriptText: staleTranscript };
    case 'failed':
      return { jobId, status, failureMessage: 'Stale failure details.' };
    default:
      return { jobId, status };
  }
}

function renderedText(element: FakeElement): string {
  return element.childNodes.map((node) => node.data).join('');
}

function expectViewerEmpty(element: FakeElement): void {
  expect(element.childNodes).toHaveLength(0);
  expect(renderedText(element)).toBe('');
}

describe('Property 6: active job replacement clears stale transcript data', () => {
  it('clears prior text for every new active state and renders only current-job completion', () => {
    // Feature: soniox-audio-transcription, Property 6: For every prior transcript value T and new job identifier J, starting J makes J the active job, replaces the displayed status with J’s current status, and leaves the transcript viewer with zero characters from T until a completed update for J supplies a new transcript.
    fc.assert(
      fc.property(propertyCaseArbitrary, ({
        oldJobId,
        replacementJobId,
        completedJobId,
        oldTranscript,
        newTranscript,
        replacementStatus,
        mismatchedStatuses,
      }) => {
        const element = new FakeElement();
        const viewer = new TranscriptViewer(element as unknown as HTMLElement);

        const previousState = startClientJob(createInitialClientState(), {
          jobId: oldJobId,
          status: 'completed',
          transcriptText: oldTranscript,
        });
        viewer.render(previousState);
        expect(renderedText(element)).toBe(oldTranscript);

        let replacementState = startClientJob(
          previousState,
          updateForStatus(replacementJobId, replacementStatus),
        );
        expect(replacementState.activeJobId).toBe(replacementJobId);
        expect(replacementState.status).toBe(replacementStatus);
        expect(replacementState.transcriptText).toBeNull();
        viewer.render(replacementState);
        expectViewerEmpty(element);

        for (const status of mismatchedStatuses) {
          const nextState = reduceClientStatus(
            replacementState,
            mismatchedUpdate(oldJobId, status, oldTranscript),
          );
          expect(nextState).toBe(replacementState);
          viewer.render(nextState);
          expectViewerEmpty(element);
        }

        if (replacementStatus === 'queued') {
          replacementState = reduceClientStatus(replacementState, {
            jobId: replacementJobId,
            status: 'processing',
          });
          viewer.render(replacementState);
          expect(replacementState.transcriptText).toBeNull();
          expectViewerEmpty(element);
        }

        if (replacementStatus !== 'failed') {
          replacementState = reduceClientStatus(replacementState, {
            jobId: replacementJobId,
            status: 'failed',
            failureMessage: 'The replacement job failed.',
          });
          viewer.render(replacementState);
          expect(replacementState.transcriptText).toBeNull();
          expectViewerEmpty(element);
        }

        const currentJobState = startClientJob(replacementState, {
          jobId: completedJobId,
          status: 'queued',
        });
        viewer.render(currentJobState);
        expect(currentJobState.activeJobId).toBe(completedJobId);
        expect(currentJobState.transcriptText).toBeNull();
        expectViewerEmpty(element);

        const completedState = reduceClientStatus(currentJobState, {
          jobId: completedJobId,
          status: 'completed',
          transcriptText: newTranscript,
        });
        viewer.render(completedState);
        expect(completedState.activeJobId).toBe(completedJobId);
        expect(completedState.transcriptText).toBe(newTranscript);
        expect(renderedText(element)).toBe(newTranscript);

        for (const mismatchedJobId of [oldJobId, replacementJobId]) {
          for (const status of mismatchedStatuses) {
            const nextState = reduceClientStatus(
              completedState,
              mismatchedUpdate(mismatchedJobId, status, oldTranscript),
            );
            expect(nextState).toBe(completedState);
            viewer.render(nextState);
            expect(renderedText(element)).toBe(newTranscript);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
