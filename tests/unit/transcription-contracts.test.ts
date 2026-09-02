import { describe, expect, it } from 'vitest';

import {
  AUTOMATIC_LANGUAGE_DETECTION,
  FAILURE_DETAILS_UNAVAILABLE_MESSAGE,
  isAcceptedAudioFile,
  isClientStatusUpdate,
  isStatusUpdate,
  validateFileSelection,
} from '../../src/shared';
import {
  areSettingsLocked,
  canDownloadTranscript,
  createInitialClientState,
  reduceClientStatus,
  startClientJob,
} from '../../src/client/state';

function browserFile(name: string, type: string): File {
  return { name, type } as File;
}

describe('shared transcription contracts', () => {
  it('accepts exactly one audio file and preserves its supplied Unicode filename', () => {
    const file = browserFile('réunion-🎙️.wav', 'audio/wav');
    const result = validateFileSelection([file]);

    expect(result).toEqual({ accepted: true, selectedFile: file, errorMessage: null });
    expect(isAcceptedAudioFile(file)).toBe(true);
  });

  it('rejects empty, multiple, non-audio, and out-of-range filename selections', () => {
    const valid = browserFile('voice.wav', 'audio/wav');

    expect(validateFileSelection([]).accepted).toBe(false);
    expect(validateFileSelection([valid, valid]).accepted).toBe(false);
    expect(validateFileSelection([browserFile('voice.wav', 'video/mp4')]).accepted).toBe(false);
    expect(validateFileSelection([browserFile('', 'audio/wav')]).accepted).toBe(false);
    expect(validateFileSelection([browserFile('a'.repeat(256), 'audio/wav')]).accepted).toBe(false);
  });

  it('uses automatic language detection as the initial client setting', () => {
    expect(createInitialClientState().selectedSettings).toBe(AUTOMATIC_LANGUAGE_DETECTION);
  });

  it('accepts only sanitized public status shapes', () => {
    expect(isStatusUpdate({ jobId: 'job-1', status: 'queued' })).toBe(true);
    expect(isStatusUpdate({ jobId: 'job-1', status: 'completed', transcriptText: '<literal>' })).toBe(true);
    expect(isStatusUpdate({ jobId: 'job-1', status: 'failed', failureMessage: 'Submission failed.' })).toBe(true);
    expect(isStatusUpdate({ jobId: 'job-1', status: 'queued', credential: 'secret' })).toBe(false);
    expect(isStatusUpdate({ jobId: 'job-1', status: 'failed', failureMessage: 'x'.repeat(501) })).toBe(false);
    expect(isClientStatusUpdate({ jobId: 'job-1', status: 'failed', failureMessage: 'x'.repeat(1_024) })).toBe(true);
  });
});

describe('client transcription state primitives', () => {
  it('starts a job with a fresh active id and clears stale transcript data', () => {
    const previous = startClientJob(
      createInitialClientState(),
      { jobId: 'old-job', status: 'completed', transcriptText: 'old transcript' },
    );
    const next = startClientJob(
      previous,
      { jobId: 'new-job', status: 'queued' },
    );

    expect(next.activeJobId).toBe('new-job');
    expect(next.status).toBe('queued');
    expect(next.transcriptText).toBeNull();
    expect(next.failureMessage).toBeNull();
    expect(areSettingsLocked(next)).toBe(true);
  });

  it('updates only the active job and keeps terminal status immutable', () => {
    const queued = startClientJob(createInitialClientState(), { jobId: 'job-1', status: 'queued' });
    const completed = reduceClientStatus(queued, {
      jobId: 'job-1',
      status: 'completed',
      transcriptText: 'line 1\n<script>not code</script>',
    });
    const mismatched = reduceClientStatus(completed, { jobId: 'job-2', status: 'failed', failureMessage: 'other' });
    const lateUpdate = reduceClientStatus(completed, { jobId: 'job-1', status: 'processing' });

    expect(completed.transcriptText).toBe('line 1\n<script>not code</script>');
    expect(areSettingsLocked(completed)).toBe(false);
    expect(canDownloadTranscript(completed)).toBe(true);
    expect(mismatched).toEqual(completed);
    expect(lateUpdate).toEqual(completed);
  });

  it('normalizes absent and oversized failure details without exposing extra fields', () => {
    const queued = startClientJob(createInitialClientState(), { jobId: 'job-1', status: 'queued' });
    const failed = reduceClientStatus(queued, {
      jobId: 'job-1',
      status: 'failed',
      failureMessage: 'x'.repeat(1_025),
    });

    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toBe(FAILURE_DETAILS_UNAVAILABLE_MESSAGE);
    expect(failed.transcriptText).toBeNull();
    expect(areSettingsLocked(failed)).toBe(false);
    expect(canDownloadTranscript(failed)).toBe(false);
  });
});
