import { describe, expect, it, vi } from 'vitest';
import type { AcceptedAudioFile } from '../../src/shared/transcription';
import {
  EnvironmentSonioxCredentialStore,
  HttpSonioxGateway,
  type SonioxCredential,
  type SonioxProviderHandle,
} from '../../src/server/soniox';

const credential = 'server-only-secret' as SonioxCredential;

function createAudioFile(): AcceptedAudioFile {
  const file = new Blob(['audio bytes'], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'recording.wav' });
  return file as AcceptedAudioFile;
}

describe('EnvironmentSonioxCredentialStore', () => {
  it('reads the credential from server configuration without changing it', async () => {
    const store = new EnvironmentSonioxCredentialStore({ SONIOX_API_KEY: credential });

    await expect(store.getCredential()).resolves.toBe(credential);
  });

  it('fails without returning or embedding a missing credential', async () => {
    const store = new EnvironmentSonioxCredentialStore({});

    await expect(store.getCredential()).rejects.toMatchObject({
      name: 'SonioxCredentialUnavailableError',
      message: 'Soniox credential is unavailable.',
    });
  });
});

describe('HttpSonioxGateway', () => {
  it('submits the file and setting through the server-only provider request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const form = init?.body as FormData;
      expect(form.get('language')).toBe('en-US');
      expect(form.get('file')).toBeTruthy();
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${credential}`);

      return new Response(JSON.stringify({ id: 'provider-1', status: 'queued' }), { status: 202 });
    });
    const gateway = new HttpSonioxGateway({
      submitUrl: 'https://provider.test/transcriptions',
      statusUrl: (handle) => `https://provider.test/transcriptions/${handle}`,
      fetchImplementation,
    });

    const result = await gateway.submit(
      { file: createAudioFile(), settings: 'en-US' },
      credential,
    );

    expect(result.providerHandle).toBe('provider-1');
    expect(result.outcome).toEqual({ status: 'queued' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('maps a completed provider response to opaque transcript text', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: 'completed', transcript_text: '<literal>\n✓' }), { status: 200 }),
    );
    const gateway = new HttpSonioxGateway({
      submitUrl: 'https://provider.test/transcriptions',
      statusUrl: (handle) => `https://provider.test/transcriptions/${handle}`,
      fetchImplementation,
    });

    const outcome = await gateway.refresh('provider-1' as SonioxProviderHandle, credential);

    expect(outcome).toEqual({ status: 'completed', transcriptText: '<literal>\n✓' });
  });

  it('preserves an empty completed transcript as valid opaque text', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: 'completed', transcript_text: '' }), { status: 200 }),
    );
    const gateway = new HttpSonioxGateway({
      submitUrl: 'https://provider.test/transcriptions',
      statusUrl: (handle) => `https://provider.test/transcriptions/${handle}`,
      fetchImplementation,
    });

    const outcome = await gateway.refresh('provider-1' as SonioxProviderHandle, credential);

    expect(outcome).toEqual({ status: 'completed', transcriptText: '' });
  });

  it('keeps provider failure context backend-private and never includes the credential', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: 'failed', code: 'TRANSCRIPTION_FAILED', message: 'provider detail' }), {
        status: 200,
      }),
    );
    const gateway = new HttpSonioxGateway({
      submitUrl: 'https://provider.test/transcriptions',
      statusUrl: (handle) => `https://provider.test/transcriptions/${handle}`,
      fetchImplementation,
    });

    const outcome = await gateway.refresh('provider-1' as SonioxProviderHandle, credential);

    expect(outcome).toMatchObject({
      status: 'failed',
      context: {
        kind: 'provider',
        message: 'provider detail',
        providerCode: 'TRANSCRIPTION_FAILED',
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(credential);
  });

  it('converts transport failures into a private failed outcome', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new Error('connection detail');
    });
    const gateway = new HttpSonioxGateway({
      submitUrl: 'https://provider.test/transcriptions',
      statusUrl: (handle) => `https://provider.test/transcriptions/${handle}`,
      fetchImplementation,
    });

    const outcome = await gateway.refresh('provider-1' as SonioxProviderHandle, credential);

    expect(outcome).toMatchObject({
      status: 'failed',
      context: {
        kind: 'transport',
        message: 'The provider status request could not be completed.',
      },
    });
  });
});
