import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationServer } from '../../src/server/index';
import type { SpeakerIdentificationService } from '../../src/server/speaker-identification';

interface RunningServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const runningServers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

async function startServer(speakerService: SpeakerIdentificationService): Promise<RunningServer> {
  const server = createApplicationServer({ speakerService });
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

describe('Speaker HTTP API', () => {
  it('GET /api/speakers returns list of enrolled speakers', async () => {
    const mockService = {
      list: vi.fn().mockResolvedValue(['Alice', 'Bob']),
      enroll: vi.fn(),
      remove: vi.fn(),
      identify: vi.fn(),
      relabel: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const server = await startServer(mockService);
    const res = await fetch(`${server.baseUrl}/api/speakers`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ speakers: ['Alice', 'Bob'] });
    expect(mockService.list).toHaveBeenCalled();
  });

  it('POST /api/speakers/enroll accepts multipart form and calls speakerService', async () => {
    const mockService = {
      list: vi.fn(),
      enroll: vi.fn().mockResolvedValue({ status: 'enrolled', name: 'Alice', embedding_dim: 192 }),
      remove: vi.fn(),
      identify: vi.fn(),
      relabel: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const server = await startServer(mockService);
    const form = new FormData();
    form.append('name', 'Alice');
    form.append('audio', new Blob(['test audio bytes'], { type: 'audio/wav' }), 'alice.wav');

    const res = await fetch(`${server.baseUrl}/api/speakers/enroll`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'enrolled', name: 'Alice', embeddingDim: 192 });
    expect(mockService.enroll).toHaveBeenCalledWith('Alice', expect.stringContaining('speaker-enroll-'));
  });

  it('POST /api/speakers/enroll returns 400 when name is missing', async () => {
    const mockService = {
      list: vi.fn(),
      enroll: vi.fn(),
      remove: vi.fn(),
      identify: vi.fn(),
      relabel: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const server = await startServer(mockService);
    const form = new FormData();
    form.append('audio', new Blob(['test audio'], { type: 'audio/wav' }), 'test.wav');

    const res = await fetch(`${server.baseUrl}/api/speakers/enroll`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ failureMessage: 'Speaker name and audio sample are required.' });
    expect(mockService.enroll).not.toHaveBeenCalled();
  });

  it('DELETE /api/speakers/:name removes an enrolled speaker', async () => {
    const mockService = {
      list: vi.fn(),
      enroll: vi.fn(),
      remove: vi.fn().mockResolvedValue(true),
      identify: vi.fn(),
      relabel: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const server = await startServer(mockService);
    const res = await fetch(`${server.baseUrl}/api/speakers/Alice`, {
      method: 'DELETE',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'removed', name: 'Alice' });
    expect(mockService.remove).toHaveBeenCalledWith('Alice');
  });

  it('rejects unsupported methods with 405 Method Not Allowed', async () => {
    const mockService = {
      list: vi.fn(),
      enroll: vi.fn(),
      remove: vi.fn(),
      identify: vi.fn(),
      relabel: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const server = await startServer(mockService);
    const res = await fetch(`${server.baseUrl}/api/speakers`, {
      method: 'PUT',
    });
    const body = await res.json();

    expect(res.status).toBe(405);
    expect(body).toEqual({ failureMessage: 'The requested method is not allowed.' });
  });

  it('POST /api/transcriptions/:jobId/enroll-speaker enrolls speaker from job recording', async () => {
    const mockService = {
      enrollFromAudio: vi.fn().mockResolvedValue({ status: 'enrolled', name: 'Charlie', embedding_dim: 192 }),
    } as unknown as SpeakerIdentificationService;

    const mockCoordinator = {
      create: vi.fn(),
      getStatus: vi.fn(),
      getAudio: vi.fn().mockResolvedValue({ path: '/tmp/job-123.wav', mimeType: 'audio/wav' }),
      getJob: vi.fn().mockResolvedValue({
        jobId: 'job-123',
        tokens: [
          { text: 'Hello', speaker: '1', startMs: 0, endMs: 1000 },
          { text: 'World', speaker: '1', startMs: 1200, endMs: 2500 },
        ],
      }),
    };

    const serverInstance = createApplicationServer({ coordinator: mockCoordinator, speakerService: mockService });
    await new Promise<void>((resolve, reject) => {
      serverInstance.once('error', reject);
      serverInstance.listen(0, '127.0.0.1', () => resolve());
    });
    const address = serverInstance.address() as { port: number };
    const running: RunningServer = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve, reject) => {
        serverInstance.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    };
    runningServers.push(running);

    const res = await fetch(`${running.baseUrl}/api/transcriptions/job-123/enroll-speaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie', speakerId: '1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.enrolled).toHaveLength(1);
    expect(body.enrolled[0].name).toBe('Charlie');
    expect(mockService.enrollFromAudio).toHaveBeenCalledWith(
      'Charlie',
      '/tmp/job-123.wav',
      expect.any(Array),
      '1',
    );
  });
});
