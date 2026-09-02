import {
  AUTOMATIC_LANGUAGE_DETECTION,
  type AcceptedAudioFile,
  type TranscriptText,
  type TranscriptionSettings,
} from '../shared/transcription.js';
import type {
  ProviderFailureContext,
  ProviderOutcome,
  SonioxCredential,
  SonioxGateway,
  SonioxProviderHandle,
  SonioxSubmissionResult,
} from './soniox.js';

const DEFAULT_BASE_URL = 'https://api.soniox.com/v1';
const DEFAULT_MODEL = 'stt-async-v5';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Payload = Record<string, unknown>;

type UploadResult =
  | { readonly fileId: string }
  | { readonly failure: ProviderOutcome };

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, keys: readonly string[], allowEmpty = false): string | undefined {
  if (typeof value === 'string') {
    return allowEmpty || value.length > 0 ? value : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && (allowEmpty || candidate.length > 0)) {
      return candidate;
    }
  }
  return undefined;
}

function failure(
  kind: ProviderFailureContext['kind'],
  message: string,
  providerPayload?: unknown,
  statusCode?: number,
  cause?: unknown,
): ProviderOutcome {
  return {
    status: 'failed',
    context: {
      kind,
      message,
      providerCode: readString(providerPayload, ['code', 'error_type']),
      statusCode,
      providerPayload,
      cause,
    },
  };
}

function statusFromPayload(payload: unknown): string | undefined {
  return readString(payload, ['status', 'state'])?.toLowerCase();
}

function transcriptTextFromPayload(payload: unknown): TranscriptText | undefined {
  const directText = readString(payload, ['transcript_text', 'transcriptText', 'transcript', 'text'], true);
  if (directText !== undefined) {
    return directText;
  }

  if (!isRecord(payload) || !Array.isArray(payload.tokens)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const token of payload.tokens) {
    const text = readString(token, ['text'], true);
    if (text === undefined) {
      return undefined;
    }
    textParts.push(text);
  }
  return textParts.join('');
}

async function readPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { raw: body.slice(0, 4_096) };
  }
}

export interface SonioxApiGatewayOptions {
  readonly baseUrl?: string | URL;
  readonly model?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

/**
 * Production adapter for Soniox's asynchronous REST API. Provider-specific
 * upload, create, status, and transcript calls remain backend-only.
 */
export class SonioxApiGateway implements SonioxGateway {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(options: SonioxApiGatewayOptions = {}) {
    const configuredBaseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.baseUrl = configuredBaseUrl;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;

    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the Soniox API gateway.');
    }
  }

  public async submit(
    submission: { readonly file: AcceptedAudioFile; readonly settings: TranscriptionSettings },
    credential: SonioxCredential,
  ): Promise<SonioxSubmissionResult> {
    try {
      const uploaded = await this.uploadFile(submission.file, credential);
      if ('failure' in uploaded) {
        return { providerHandle: null, outcome: uploaded.failure };
      }

      const config: Record<string, unknown> = {
        model: this.model,
        file_id: uploaded.fileId,
      };
      if (submission.settings !== AUTOMATIC_LANGUAGE_DETECTION) {
        config.language_hints = [submission.settings];
      }

      const response = await this.request('/transcriptions', credential, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        return {
          providerHandle: null,
          outcome: failure('provider', 'Soniox rejected the transcription request.', payload, response.status),
        };
      }

      const providerId = readString(payload, ['id']);
      if (providerId === undefined) {
        return {
          providerHandle: null,
          outcome: failure('protocol', 'Soniox did not return a transcription identifier.', payload),
        };
      }

      const providerHandle = providerId as SonioxProviderHandle;
      return {
        providerHandle,
        outcome: await this.outcomeForPayload(providerHandle, payload, credential),
      };
    } catch (cause) {
      return {
        providerHandle: null,
        outcome: failure('transport', 'The Soniox request could not be completed.', undefined, undefined, cause),
      };
    }
  }

  public async refresh(
    providerHandle: SonioxProviderHandle,
    credential: SonioxCredential,
  ): Promise<ProviderOutcome> {
    try {
      const response = await this.request(
        `/transcriptions/${encodeURIComponent(providerHandle)}`,
        credential,
        { method: 'GET' },
      );
      const payload = await readPayload(response);
      if (!response.ok) {
        return failure('provider', 'Soniox status retrieval failed.', payload, response.status);
      }
      return this.outcomeForPayload(providerHandle, payload, credential);
    } catch (cause) {
      return failure('transport', 'The Soniox status request could not be completed.', undefined, undefined, cause);
    }
  }

  private async uploadFile(file: AcceptedAudioFile, credential: SonioxCredential): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await this.request('/files', credential, { method: 'POST', body: form });
    const payload = await readPayload(response);
    if (!response.ok) {
      return { failure: failure('provider', 'Soniox rejected the audio upload.', payload, response.status) };
    }

    const fileId = readString(payload, ['id']);
    return fileId === undefined
      ? { failure: failure('protocol', 'Soniox did not return an uploaded file identifier.', payload) }
      : { fileId };
  }

  private async outcomeForPayload(
    providerHandle: SonioxProviderHandle,
    payload: unknown,
    credential: SonioxCredential,
  ): Promise<ProviderOutcome> {
    switch (statusFromPayload(payload)) {
      case 'queued':
        return { status: 'queued' };
      case 'processing':
        return { status: 'processing' };
      case 'error':
      case 'failed':
        return failure(
          'provider',
          readString(payload, ['error_message', 'message', 'detail']) ?? 'Soniox reported a transcription failure.',
          payload,
        );
      case 'completed': {
        const transcriptResponse = await this.request(
          `/transcriptions/${encodeURIComponent(providerHandle)}/transcript`,
          credential,
          { method: 'GET' },
        );
        const transcriptPayload = await readPayload(transcriptResponse);
        if (!transcriptResponse.ok) {
          return failure('provider', 'Soniox transcript retrieval failed.', transcriptPayload, transcriptResponse.status);
        }
        const transcriptText = transcriptTextFromPayload(transcriptPayload);
        return transcriptText === undefined
          ? failure('protocol', 'Soniox completed without transcript text.', transcriptPayload)
          : { status: 'completed', transcriptText };
      }
      default:
        return failure('protocol', 'Soniox returned an unrecognized transcription state.', payload);
    }
  }

  private async request(path: string, credential: SonioxCredential, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credential}`,
          ...init.headers,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
