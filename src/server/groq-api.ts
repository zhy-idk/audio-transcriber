import { randomUUID } from 'node:crypto';
import {
  AUTOMATIC_LANGUAGE_DETECTION,
  normalizeTranscriptionSettings,
  type AcceptedAudioFile,
  type TranscriptToken,
  type TranscriptionSettings,
} from '../shared/transcription.js';
import type {
  GroqCredential,
  GroqGateway,
  GroqSubmissionResult,
} from './groq.js';
import type { ProviderFailureContext, ProviderOutcome } from './soniox.js';

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
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

export interface GroqApiGatewayOptions {
  readonly baseUrl?: string | URL;
  readonly model?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export class GroqApiGateway implements GroqGateway {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(options: GroqApiGatewayOptions = {}) {
    this.baseUrl = String(options.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/u, '');
    this.model = options.model ?? DEFAULT_GROQ_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;

    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the Groq API gateway.');
    }
  }

  public async submit(
    submission: { readonly file: AcceptedAudioFile; readonly settings: TranscriptionSettings },
    credential: GroqCredential,
  ): Promise<GroqSubmissionResult> {
    try {
      const parsedSettings = normalizeTranscriptionSettings(submission.settings);
      const form = new FormData();
      form.append('file', submission.file, submission.file.name);
      form.append('model', this.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');

      if (
        parsedSettings.languagePreference &&
        parsedSettings.languagePreference !== AUTOMATIC_LANGUAGE_DETECTION
      ) {
        form.append('language', parsedSettings.languagePreference);
      } else if (parsedSettings.languageHints && parsedSettings.languageHints.length > 0) {
        form.append('language', parsedSettings.languageHints[0]!);
      }

      const promptParts: string[] = [];
      if (parsedSettings.contextTerms && parsedSettings.contextTerms.length > 0) {
        promptParts.push(`Vocabulary: ${parsedSettings.contextTerms.join(', ')}`);
      }
      if (parsedSettings.contextText && parsedSettings.contextText.trim().length > 0) {
        promptParts.push(parsedSettings.contextText.trim());
      }
      if (promptParts.length > 0) {
        form.append('prompt', promptParts.join('. ').slice(0, 400));
      }

      const response = await this.request('/audio/transcriptions', credential, {
        method: 'POST',
        body: form,
      });

      const payload = await readPayload(response);
      if (!response.ok) {
        let errorMsg = 'Groq rejected the transcription request.';
        if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
          errorMsg = payload.error.message;
        } else if (isRecord(payload) && typeof payload.message === 'string') {
          errorMsg = payload.message;
        }
        return {
          providerHandle: null,
          outcome: failure('provider', errorMsg, payload, response.status),
        };
      }

      return {
        providerHandle: `groq-${randomUUID()}`,
        outcome: this.parseOutcome(payload),
      };
    } catch (cause) {
      return {
        providerHandle: null,
        outcome: failure('transport', 'The Groq request could not be completed.', undefined, undefined, cause),
      };
    }
  }

  private parseOutcome(payload: unknown): ProviderOutcome {
    if (!isRecord(payload)) {
      return failure('protocol', 'Groq returned an invalid response envelope.', payload);
    }

    const transcriptText = readString(payload, ['text']) ?? '';
    const tokens: TranscriptToken[] = [];

    if (Array.isArray(payload.words)) {
      for (let i = 0; i < payload.words.length; i++) {
        const item = payload.words[i];
        if (isRecord(item) && typeof item.word === 'string') {
          const rawWord = item.word;
          const text = (i > 0 && !rawWord.startsWith(' ') ? ' ' : '') + rawWord;
          tokens.push({
            text,
            startMs: typeof item.start === 'number' ? Math.round(item.start * 1000) : null,
            endMs: typeof item.end === 'number' ? Math.round(item.end * 1000) : null,
            confidence: null,
          });
        }
      }
    }

    let confidenceScore: number | null = null;
    if (Array.isArray(payload.segments) && payload.segments.length > 0) {
      let sum = 0;
      let count = 0;
      for (const seg of payload.segments) {
        if (isRecord(seg) && typeof seg.avg_logprob === 'number') {
          const prob = Math.min(1, Math.max(0, Math.exp(seg.avg_logprob)));
          sum += prob;
          count += 1;
        }
      }
      if (count > 0) {
        confidenceScore = Math.round((sum / count) * 100) / 100;
      }
    }

    return {
      status: 'completed',
      transcriptText,
      ...(confidenceScore !== null ? { confidenceScore } : {}),
      ...(tokens.length > 0 ? { tokens } : {}),
    };
  }

  private async request(path: string, credential: GroqCredential, init: RequestInit): Promise<Response> {
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
