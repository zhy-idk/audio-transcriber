import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SameOriginTranscriptionApi,
  StatusPollingController,
  TranscriptionApiError,
} from '../../src/client';
import type { TranscriptionApi } from '../../src/client';
import type { StatusUpdate } from '../../src/shared';

function audioFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'voice.wav', { type: 'audio/wav' });
}

describe('SameOriginTranscriptionApi', () => {
  it('sends one same-origin multipart create request and accepts only public status', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'job-1', status: 'queued' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    await expect(api.create(audioFile(), 'en-US')).resolves.toEqual({
      jobId: 'job-1',
      status: 'queued',
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [input, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(input).toBe('/api/transcriptions');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('settings')).toBe('en-US');
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('redacts malformed and non-public responses into bounded errors', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ credential: 'secret', details: 'internal' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    await expect(api.getStatus('job-1')).rejects.toMatchObject({
      name: 'TranscriptionApiError',
      publicMessage: 'Transcription status could not be retrieved.',
    });
    await expect(api.getStatus('job-1')).rejects.not.toThrow('secret');
  });

  it('preserves a bounded public rejection message without exposing response objects', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ failureMessage: 'Exactly one audio file is required.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    const error = await api.create(audioFile(), 'automatic').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TranscriptionApiError);
    expect((error as TranscriptionApiError).publicMessage).toBe('Exactly one audio file is required.');
  });
});

describe('StatusPollingController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps one request in flight and discards stale responses after stop', async () => {
    vi.useFakeTimers();
    let resolveRequest: ((update: StatusUpdate) => void) | undefined;
    const getStatus = vi.fn<TranscriptionApi['getStatus']>(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const updates: StatusUpdate[] = [];
    const errors: unknown[] = [];
    const polling = new StatusPollingController({ getStatus }, { intervalMs: 1_000 });

    polling.start('job-1', {
      onUpdate: (update) => updates.push(update),
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getStatus).toHaveBeenCalledOnce();

    resolveRequest?.({ jobId: 'job-1', status: 'processing' });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(updates).toEqual([{ jobId: 'job-1', status: 'processing' }]);

    polling.stop();
    resolveRequest?.({ jobId: 'job-1', status: 'completed', transcriptText: 'late' });
    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });
});
