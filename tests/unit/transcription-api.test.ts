import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SameOriginTranscriptionApi,
  StatusPollingController,
  type ClientFetch,
  type TranscriptionApi,
} from '../../src/client';
import type { StatusUpdate } from '../../src/shared';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function audioFile(name = 'meeting.wav'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/wav' });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SameOriginTranscriptionApi', () => {
  it('sends one same-origin multipart create request with the file and exact setting', async () => {
    const fetchImplementation = vi.fn<ClientFetch>().mockResolvedValue(
      jsonResponse({ jobId: 'job-1', status: 'queued' }, 202),
    );
    const api = new SameOriginTranscriptionApi({ fetchImplementation });
    const file = audioFile();

    await expect(api.create(file, 'en-US')).resolves.toEqual({
      jobId: 'job-1',
      status: 'queued',
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [input, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(input).toBe('/api/transcriptions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('settings')).toBe('en-US');
    expect((init?.body as FormData).get('file')).toMatchObject({
      name: 'meeting.wav',
      type: 'audio/wav',
    });
    expect(JSON.stringify(init)).not.toContain('credential');
    expect(JSON.stringify(init)).not.toContain('provider');
  });

  it('reads only the active opaque job path and preserves public failure handling', async () => {
    const fetchImplementation = vi.fn<ClientFetch>()
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse({ failureMessage: 'Exactly one audio file is required.' }, 400));
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    await expect(api.getStatus('job-1')).resolves.toEqual({
      jobId: 'job-1',
      status: 'processing',
    });
    await expect(api.create(audioFile(), 'automatic')).rejects.toMatchObject({
      name: 'TranscriptionApiError',
      publicMessage: 'Exactly one audio file is required.',
      statusCode: 400,
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('/api/transcriptions/job-1/status');
    expect(JSON.stringify(fetchImplementation.mock.calls[1])).not.toContain('Exactly one audio file is required.');
  });

  it('rejects malformed public responses and normalizes absent failed details safely', async () => {
    const fetchImplementation = vi.fn<ClientFetch>()
      .mockResolvedValueOnce(jsonResponse({ credential: 'secret', details: 'internal' }, 200))
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1', status: 'failed' }));
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    await expect(api.getStatus('job-1')).rejects.toMatchObject({
      publicMessage: 'The transcription service returned an invalid response.',
    });
    await expect(api.getStatus('job-1')).resolves.toEqual({
      jobId: 'job-1',
      status: 'failed',
      failureMessage: 'Failure details are unavailable.',
    });
  });
});

describe('StatusPollingController', () => {
  it('keeps one request in flight and discards stale responses after stop', async () => {
    vi.useFakeTimers();
    const request = deferred<StatusUpdate>();
    const getStatus = vi.fn<TranscriptionApi['getStatus']>(() => request.promise);
    const updates: StatusUpdate[] = [];
    const polling = new StatusPollingController({ getStatus }, { intervalMs: 1_000 });

    polling.start('job-1', {
      onUpdate: (update) => updates.push(update),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getStatus).toHaveBeenCalledOnce();

    request.resolve({ jobId: 'job-1', status: 'completed', transcriptText: 'late' });
    polling.stop();
    await Promise.resolve();
    expect(updates).toHaveLength(0);
  });

  it('ignores a mismatched update and stops scheduling after correlated completion', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn<TranscriptionApi['getStatus']>()
      .mockResolvedValueOnce({ jobId: 'other-job', status: 'completed', transcriptText: 'stale' })
      .mockResolvedValueOnce({ jobId: 'job-1', status: 'completed', transcriptText: 'done' });
    const updates: StatusUpdate[] = [];
    const polling = new StatusPollingController({ getStatus }, { intervalMs: 10 });

    polling.start('job-1', {
      onUpdate: (update) => updates.push(update),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(updates).toEqual([
      { jobId: 'job-1', status: 'completed', transcriptText: 'done' },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
