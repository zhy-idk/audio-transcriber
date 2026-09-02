import { describe, expect, it } from 'vitest';

import {
  getAcceptedAudioFile,
  isAcceptedBackendUpload,
  validateBackendFileSelection,
} from '../../src/server/request-validation';
import {
  GENERIC_PUBLIC_FAILURE_MESSAGE,
  mapPublicFailure,
  mapPublicStatus,
  sanitizePublicFailureMessage,
} from '../../src/server/public-status';

function browserFile(name: string, type: string): File {
  return { name, type } as File;
}

describe('backend request validation', () => {
  it('accepts exactly one audio upload and preserves the original file and name', () => {
    const file = browserFile('réunion-🎙️.wav', 'audio/wav');
    const result = validateBackendFileSelection([file]);

    expect(result).toEqual({ accepted: true, selectedFile: file, errorMessage: null });
    expect(isAcceptedBackendUpload(result)).toBe(true);
    expect(getAcceptedAudioFile([file])).toBe(file);
  });

  it.each([
    ['zero files', []],
    ['multiple files', [browserFile('one.wav', 'audio/wav'), browserFile('two.wav', 'audio/wav')]],
    ['non-audio media type', [browserFile('voice.wav', 'video/wav')]],
    ['empty filename', [browserFile('', 'audio/wav')]],
    ['overlong filename', [browserFile('a'.repeat(256), 'audio/wav')]],
  ])('rejects %s with no accepted file', (_caseName, selection) => {
    const result = validateBackendFileSelection(selection);

    expect(result.accepted).toBe(false);
    expect(result.selectedFile).toBeNull();
    expect(result.errorMessage).toBe('Exactly one audio file is required.');
    expect(getAcceptedAudioFile(selection)).toBeNull();
  });

  it('counts Unicode filename characters at the acceptance boundaries', () => {
    expect(validateBackendFileSelection([browserFile('😀'.repeat(255), 'audio/ogg')]).accepted).toBe(true);
    expect(validateBackendFileSelection([browserFile('😀'.repeat(256), 'audio/ogg')]).accepted).toBe(false);
  });
});

describe('public backend status mapping', () => {
  it('projects queued and processing statuses without copying private fields', () => {
    const privateFields = {
      credential: 'soniox-secret',
      providerHandle: 'provider-job-1',
      providerPayload: { secret: 'payload-secret' },
      error: new Error('internal failure'),
      stack: 'Error: internal failure\\n    at secret-stack',
    };

    expect(mapPublicStatus({ jobId: 'job-1', status: 'queued', ...privateFields })).toEqual({
      jobId: 'job-1',
      status: 'queued',
    });
    expect(mapPublicStatus({ jobId: 'job-1', status: 'processing', ...privateFields })).toEqual({
      jobId: 'job-1',
      status: 'processing',
    });
  });

  it('preserves completed transcript text exactly while omitting private fields', () => {
    const transcript = 'line 1\n<script>alert("literal")</script>\n終わり';
    const mapped = mapPublicStatus({
      jobId: 'job-1',
      status: 'completed',
      transcriptText: transcript,
      credential: 'soniox-secret',
      providerPayload: { transcript: 'different' },
    });

    expect(mapped).toEqual({ jobId: 'job-1', status: 'completed', transcriptText: transcript });
  });

  it('bounds safe failure text by Unicode code points and falls back for internal data', () => {
    const longMessage = '😀'.repeat(600);
    expect(sanitizePublicFailureMessage(longMessage)).toBe('😀'.repeat(500));
    expect(sanitizePublicFailureMessage('token=soniox-secret')).toBe(GENERIC_PUBLIC_FAILURE_MESSAGE);
    expect(sanitizePublicFailureMessage('Error: internal details\\n    at secret-stack')).toBe(GENERIC_PUBLIC_FAILURE_MESSAGE);
    expect(sanitizePublicFailureMessage('{"providerPayload":"secret"}')).toBe(GENERIC_PUBLIC_FAILURE_MESSAGE);
  });

  it('maps failed statuses to only a bounded public failure field', () => {
    const mapped = mapPublicStatus({
      jobId: 'job-1',
      status: 'failed',
      failureMessage: 'Provider rejected the audio.',
      credential: 'soniox-secret',
      providerPayload: { raw: 'secret' },
      error: new Error('stack and internal details'),
    });

    expect(mapped).toEqual({
      jobId: 'job-1',
      status: 'failed',
      failureMessage: 'Provider rejected the audio.',
    });
    expect(mapPublicFailure('job-2', undefined)).toEqual({
      jobId: 'job-2',
      status: 'failed',
      failureMessage: GENERIC_PUBLIC_FAILURE_MESSAGE,
    });
  });

  it('does not expose malformed completed outcomes as false completion', () => {
    expect(mapPublicStatus({ jobId: 'job-1', status: 'completed', transcriptText: undefined })).toEqual({
      jobId: 'job-1',
      status: 'failed',
      failureMessage: GENERIC_PUBLIC_FAILURE_MESSAGE,
    });
    expect(mapPublicStatus({ jobId: 'invalid id', status: 'queued' })).toBeNull();
  });
});
