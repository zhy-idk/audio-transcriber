import { describe, expect, it, vi } from 'vitest';
import {
  EnvironmentGroqCredentialStore,
  toGroqCredential,
  type GroqCredential,
} from '../../src/server/groq';
import { GroqApiGateway } from '../../src/server/groq-api';
import { JobCoordinator } from '../../src/server/job-coordinator';
import { InMemoryJobRepository } from '../../src/server/job-repository';
import {
  serializeTranscriptionSettings,
  type AcceptedAudioFile,
} from '../../src/shared/transcription';
import type { SpeakerIdentificationService } from '../../src/server/speaker-identification';

const testCredential = toGroqCredential('gsk_test_credential_12345');

function createAudioFile(name = 'sample.mp3'): AcceptedAudioFile {
  const file = new Blob(['audio sample bytes'], { type: 'audio/mp3' });
  Object.defineProperty(file, 'name', { value: name });
  return file as AcceptedAudioFile;
}

describe('EnvironmentGroqCredentialStore', () => {
  it('reads the credential from environment variable', async () => {
    const store = new EnvironmentGroqCredentialStore({ GROQ_API_KEY: 'gsk_test_env_key' });
    await expect(store.getCredential()).resolves.toBe('gsk_test_env_key');
  });

  it('throws descriptive error when GROQ_API_KEY is not set', async () => {
    const store = new EnvironmentGroqCredentialStore({});
    await expect(store.getCredential()).rejects.toThrow(
      'Groq credential is unavailable. Please set GROQ_API_KEY in your environment or .env file.',
    );
  });

  it('throws descriptive error when GROQ_API_KEY is whitespace', async () => {
    const store = new EnvironmentGroqCredentialStore({ GROQ_API_KEY: '   ' });
    await expect(store.getCredential()).rejects.toThrow(
      'Groq credential is unavailable',
    );
  });
});

describe('GroqApiGateway', () => {
  it('submits audio file with correct parameters to Groq transcription endpoint', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedModel = '';
    let capturedFormat = '';
    let capturedGranularities: string[] = [];

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get('authorization') ?? '';
      const form = init?.body as FormData;
      capturedModel = String(form.get('model'));
      capturedFormat = String(form.get('response_format'));
      capturedGranularities = form.getAll('timestamp_granularities[]').map(String);

      return new Response(
        JSON.stringify({
          text: 'Hello world from Groq Whisper.',
          words: [
            { word: 'Hello', start: 0.1, end: 0.5 },
            { word: 'world', start: 0.6, end: 1.0 },
            { word: 'from', start: 1.1, end: 1.3 },
            { word: 'Groq', start: 1.4, end: 1.8 },
            { word: 'Whisper.', start: 1.9, end: 2.5 },
          ],
          segments: [
            { id: 0, avg_logprob: -0.15, text: 'Hello world from Groq Whisper.' },
          ],
        }),
        { status: 200 },
      );
    });

    const gateway = new GroqApiGateway({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      fetchImplementation: mockFetch,
    });

    const result = await gateway.submit(
      {
        file: createAudioFile(),
        settings: serializeTranscriptionSettings({
          provider: 'groq',
          languagePreference: 'en',
          contextTerms: ['Groq', 'Whisper'],
        }),
      },
      testCredential,
    );

    expect(capturedUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(capturedAuth).toBe(`Bearer ${testCredential}`);
    expect(capturedModel).toBe('whisper-large-v3-turbo');
    expect(capturedFormat).toBe('verbose_json');
    expect(capturedGranularities).toEqual(['word', 'segment']);

    expect(result.providerHandle).toMatch(/^groq-/);
    expect(result.outcome.status).toBe('completed');
    if (result.outcome.status === 'completed') {
      expect(result.outcome.transcriptText).toBe('Hello world from Groq Whisper.');
      expect(result.outcome.tokens).toHaveLength(5);
      expect(result.outcome.tokens?.[0]).toEqual({
        text: 'Hello',
        startMs: 100,
        endMs: 500,
        confidence: null,
      });
      expect(result.outcome.tokens?.[1]).toEqual({
        text: ' world',
        startMs: 600,
        endMs: 1000,
        confidence: null,
      });
      // Math.exp(-0.15) ≈ 0.86
      expect(result.outcome.confidenceScore).toBe(0.86);
    }
  });

  it('handles API errors gracefully with provider context', async () => {
    const mockFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'File size exceeds 25 MB limit.',
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        }),
        { status: 400 },
      ),
    );

    const gateway = new GroqApiGateway({ fetchImplementation: mockFetch });
    const result = await gateway.submit(
      { file: createAudioFile(), settings: serializeTranscriptionSettings({ provider: 'groq' }) },
      testCredential,
    );

    expect(result.providerHandle).toBeNull();
    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.context.message).toBe('File size exceeds 25 MB limit.');
      expect(result.outcome.context.statusCode).toBe(400);
    }
  });

  it('handles transport/network errors gracefully', async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Connection refused to api.groq.com');
    });

    const gateway = new GroqApiGateway({ fetchImplementation: mockFetch });
    const result = await gateway.submit(
      { file: createAudioFile(), settings: serializeTranscriptionSettings({ provider: 'groq' }) },
      testCredential,
    );

    expect(result.providerHandle).toBeNull();
    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.context.kind).toBe('transport');
      expect(result.outcome.context.message).toBe('The Groq request could not be completed.');
    }
  });
});

describe('JobCoordinator with Groq and Sherpa Diarization', () => {
  it('processes Groq transcription and runs sherpa-onnx diarization when enabled', async () => {
    const repository = new InMemoryJobRepository();

    const groqCredentialStore = {
      getCredential: vi.fn().mockResolvedValue(testCredential),
    };

    const mockGroqSubmit = vi.fn().mockResolvedValue({
      providerHandle: 'groq-test-123',
      outcome: {
        status: 'completed',
        transcriptText: 'Hello Alice how are you doing today',
        tokens: [
          { text: 'Hello', startMs: 100, endMs: 500 },
          { text: 'Alice', startMs: 600, endMs: 1000 },
          { text: 'how', startMs: 1200, endMs: 1500 },
          { text: 'are', startMs: 1600, endMs: 1800 },
          { text: 'you', startMs: 1900, endMs: 2100 },
          { text: 'doing', startMs: 2200, endMs: 2500 },
          { text: 'today', startMs: 2600, endMs: 3000 },
        ],
        confidenceScore: 0.95,
      },
    });

    const groqGateway = {
      submit: mockGroqSubmit,
    };

    const mockDiarize = vi.fn().mockResolvedValue({
      status: 'ok',
      tokens: [
        { text: 'Hello', speaker: 'Bob', startMs: 100, endMs: 500 },
        { text: ' Alice', speaker: 'Bob', startMs: 600, endMs: 1000 },
        { text: ' how', speaker: 'Alice', startMs: 1200, endMs: 1500 },
        { text: ' are', speaker: 'Alice', startMs: 1600, endMs: 1800 },
        { text: ' you', speaker: 'Alice', startMs: 1900, endMs: 2100 },
        { text: ' doing', speaker: 'Alice', startMs: 2200, endMs: 2500 },
        { text: ' today', speaker: 'Alice', startMs: 2600, endMs: 3000 },
      ],
      speaker_mapping: { '1': 'Bob', '2': 'Alice' },
    });

    const speakerService = {
      diarize: mockDiarize,
      relabel: vi.fn(),
      enroll: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      identify: vi.fn(),
    } as unknown as SpeakerIdentificationService;

    const coordinator = new JobCoordinator({
      repository,
      credentialStore: { getCredential: vi.fn() },
      gateway: { submit: vi.fn(), refresh: vi.fn() },
      groqCredentialStore,
      groqGateway,
      speakerService,
    });

    const created = await coordinator.create([createAudioFile()], serializeTranscriptionSettings({
      provider: 'groq',
      enableDiarization: true,
    }));

    expect(created.accepted).toBe(true);
    if (!created.accepted) return;

    expect(groqCredentialStore.getCredential).toHaveBeenCalledTimes(1);
    expect(mockGroqSubmit).toHaveBeenCalledTimes(1);
    expect(mockDiarize).toHaveBeenCalledTimes(1);

    const job = repository.find(created.status.jobId);
    expect(job?.status).toBe('completed');
    expect(job?.transcriptText).toContain('Bob: Hello Alice');
    expect(job?.transcriptText).toContain('Alice: how are you doing today');
    expect(job?.tokens?.[0]?.speaker).toBe('Bob');
    expect(job?.tokens?.[2]?.speaker).toBe('Alice');
  });

  it('fails gracefully when GROQ_API_KEY is not configured', async () => {
    const repository = new InMemoryJobRepository();
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: { getCredential: vi.fn() },
      gateway: { submit: vi.fn(), refresh: vi.fn() },
      // no groqCredentialStore
    });

    const created = await coordinator.create([createAudioFile()], serializeTranscriptionSettings({
      provider: 'groq',
    }));

    expect(created.accepted).toBe(true);
    if (!created.accepted) return;

    const job = repository.find(created.status.jobId);
    expect(job?.status).toBe('failed');
    expect(job?.failureMessage).toBe('Groq credential is unavailable. Please set GROQ_API_KEY in your .env file.');
  });
});
