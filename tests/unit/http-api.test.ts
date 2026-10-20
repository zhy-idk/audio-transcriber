import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createApplicationServer,
  InMemoryJobRepository,
  JobCoordinator,
  type ApplicationServerOptions,
  type TranscriptionHttpCoordinator,
} from '../../src/server/index';
import type {
  SonioxCredential,
  SonioxCredentialStore,
  SonioxGateway,
  SonioxProviderHandle,
} from '../../src/server/soniox';

const credential = 'server-only-credential' as SonioxCredential;
const providerHandle = 'provider-only-handle' as SonioxProviderHandle;

interface RunningServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const runningServers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

function createCoordinator(options: {
  readonly submissionStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  readonly transcriptText?: string;
} = {}) {
  const repository = new InMemoryJobRepository();
  const getCredential = vi.fn<SonioxCredentialStore['getCredential']>().mockResolvedValue(credential);
  const submit = vi.fn<SonioxGateway['submit']>().mockResolvedValue({
    providerHandle,
    outcome: options.submissionStatus === 'completed'
      ? { status: 'completed', transcriptText: options.transcriptText ?? 'completed transcript' }
      : options.submissionStatus === 'processing'
        ? { status: 'processing' }
        : options.submissionStatus === 'failed'
          ? {
              status: 'failed',
              context: {
                kind: 'provider',
                message: 'provider failed',
                providerCode: undefined,
                statusCode: undefined,
                providerPayload: undefined,
                cause: undefined,
              },
            }
          : { status: 'queued' },
  });
  const refresh = vi.fn<SonioxGateway['refresh']>();
  const coordinator = new JobCoordinator({
    repository,
    credentialStore: { getCredential },
    gateway: { submit, refresh },
  });

  return { coordinator, repository, getCredential, submit, refresh };
}

async function startServer(options: ApplicationServerOptions): Promise<RunningServer> {
  const server = createApplicationServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not expose a TCP address.');
  }

  const running: RunningServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
  runningServers.push(running);
  return running;
}

function audioFile(name = 'recording.wav', type = 'audio/wav'): File {
  return new File([new Uint8Array([0, 1, 2, 3])], name, { type });
}

async function createRequest(baseUrl: string, file: File, settings = 'en-US'): Promise<Response> {
  const form = new FormData();
  form.append('file', file);
  form.append('settings', settings);
  return fetch(`${baseUrl}/api/transcriptions`, { method: 'POST', body: form });
}

describe('same-origin transcription HTTP API', () => {
  it('accepts one multipart audio file, forwards the selected setting, and returns one public status', async () => {
    const fakes = createCoordinator();
    const server = await startServer({ coordinator: fakes.coordinator });

    const response = await createRequest(server.baseUrl, audioFile(), 'fr-FR');
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({ jobId: expect.any(String), status: 'queued' });
    expect(fakes.submit).toHaveBeenCalledTimes(1);
    expect(fakes.submit.mock.calls[0]?.[0]).toMatchObject({
      settings: 'fr-FR',
      file: { name: 'recording.wav', type: 'audio/wav' },
    });
    expect(JSON.stringify(body)).not.toContain(credential);
    expect(JSON.stringify(body)).not.toContain(providerHandle);
  });

  it('returns a bounded rejection without creating or submitting a rejected upload', async () => {
    const fakes = createCoordinator();
    const server = await startServer({ coordinator: fakes.coordinator });

    const response = await createRequest(server.baseUrl, audioFile('not-audio.txt', 'text/plain'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ failureMessage: 'Exactly one audio file is required.' });
    expect(fakes.repository.count()).toBe(0);
    expect(fakes.getCredential).not.toHaveBeenCalled();
    expect(fakes.submit).not.toHaveBeenCalled();
  });

  it('rejects malformed multipart requests before invoking the coordinator', async () => {
    const fakes = createCoordinator();
    const server = await startServer({ coordinator: fakes.coordinator });

    const response = await fetch(`${server.baseUrl}/api/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'server-only-credential', details: 'private request data' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ failureMessage: 'The transcription request was rejected.' });
    expect(fakes.repository.count()).toBe(0);
    expect(fakes.getCredential).not.toHaveBeenCalled();
    expect(fakes.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('server-only-credential');
    expect(JSON.stringify(body)).not.toContain('private request data');
  });

  it('converts coordinator exceptions into generic public failures for create and status', async () => {
    const create = vi.fn<TranscriptionHttpCoordinator['create']>().mockRejectedValue(
      new Error('credential=server-only-credential; internal stack details'),
    );
    const getStatus = vi.fn<TranscriptionHttpCoordinator['getStatus']>().mockRejectedValue(
      new Error('provider payload secret; internal refresh details'),
    );
    const coordinator: TranscriptionHttpCoordinator = { create, getStatus };
    const server = await startServer({ coordinator });

    const createResponse = await createRequest(server.baseUrl, audioFile());
    const createBody = await createResponse.json();
    const statusResponse = await fetch(`${server.baseUrl}/api/transcriptions/opaque-job/status`);
    const statusBody = await statusResponse.json();

    expect(createResponse.status).toBe(500);
    expect(createBody).toEqual({ failureMessage: 'Transcription failed.' });
    expect(statusResponse.status).toBe(500);
    expect(statusBody).toEqual({ failureMessage: 'Transcription failed.' });
    expect(JSON.stringify(createBody)).not.toContain('server-only-credential');
    expect(JSON.stringify(createBody)).not.toContain('internal stack details');
    expect(JSON.stringify(statusBody)).not.toContain('provider payload secret');
    expect(JSON.stringify(statusBody)).not.toContain('internal refresh details');
  });

  it('returns completed Unicode transcript text through the correlated status route without provider handles', async () => {
    const transcript = '日本語\r\n😀\n<script>alert("literal")</script>\u0301';
    const fakes = createCoordinator({ submissionStatus: 'completed', transcriptText: transcript });
    const server = await startServer({ coordinator: fakes.coordinator });

    const createResponse = await createRequest(server.baseUrl, audioFile(), 'automatic');
    const created = await createResponse.json() as { jobId: string; status: string; transcriptText?: string };
    const statusResponse = await fetch(`${server.baseUrl}/api/transcriptions/${encodeURIComponent(created.jobId)}/status`);
    const status = await statusResponse.json();

    expect(createResponse.status).toBe(202);
    expect(created).toEqual({
      jobId: expect.any(String),
      status: 'completed',
      transcriptText: transcript,
    });
    expect(statusResponse.status).toBe(200);
    expect(status).toEqual(created);
    expect(JSON.stringify(status)).not.toContain(providerHandle);
    expect(JSON.stringify(status)).not.toContain(credential);
  });

  it('returns completed status from storage without refreshing a terminal job', async () => {
    const fakes = createCoordinator({
      submissionStatus: 'completed',
      transcriptText: '<literal>\n終わり',
    });
    const server = await startServer({ coordinator: fakes.coordinator });

    const createResponse = await createRequest(server.baseUrl, audioFile());
    const created = await createResponse.json() as { jobId: string; status: string; transcriptText?: string };
    const statusResponse = await fetch(`${server.baseUrl}/api/transcriptions/${encodeURIComponent(created.jobId)}/status`);
    const status = await statusResponse.json();

    expect(createResponse.status).toBe(202);
    expect(created).toEqual({
      jobId: expect.any(String),
      status: 'completed',
      transcriptText: '<literal>\n終わり',
    });
    expect(statusResponse.status).toBe(200);
    expect(status).toEqual(created);
    expect(fakes.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain(credential);
    expect(JSON.stringify(status)).not.toContain(providerHandle);
  });

  it('returns a safe not-found response for an unknown active job', async () => {
    const fakes = createCoordinator();
    const server = await startServer({ coordinator: fakes.coordinator });

    const response = await fetch(`${server.baseUrl}/api/transcriptions/unknown-job/status`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ failureMessage: 'Transcription job was not found.' });
    expect(JSON.stringify(body)).not.toContain(credential);
    expect(JSON.stringify(body)).not.toContain(providerHandle);
  });

  it('streams uploaded audio from /api/transcriptions/:jobId/audio', async () => {
    const fakes = createCoordinator({ submissionStatus: 'completed' });
    const server = await startServer({ coordinator: fakes.coordinator });

    const createResponse = await createRequest(server.baseUrl, audioFile('recording.wav'));
    const created = (await createResponse.json()) as { jobId: string };

    const audioResponse = await fetch(`${server.baseUrl}/api/transcriptions/${encodeURIComponent(created.jobId)}/audio`);
    expect(audioResponse.status).toBe(200);
    expect(audioResponse.headers.get('content-type')).toContain('audio');
    expect(audioResponse.headers.get('accept-ranges')).toBe('bytes');
    const bytes = await audioResponse.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);

    const unknownResponse = await fetch(`${server.baseUrl}/api/transcriptions/unknown-id/audio`);
    expect(unknownResponse.status).toBe(404);
  });
});
