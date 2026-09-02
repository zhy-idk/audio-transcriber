import {
  isClientStatusUpdateInput,
  type AcceptedAudioFile,
  type ClientStatusUpdateInput,
  type JobId,
  type StatusUpdate,
  type TranscriptionSettings,
} from '../shared/transcription';
import { normalizeFailureMessage } from './state';

export const CREATE_TRANSCRIPTION_PATH = '/api/transcriptions';
export const CREATE_TRANSCRIPTION_ENDPOINT = CREATE_TRANSCRIPTION_PATH;
export const TRANSCRIPTION_REQUEST_FAILURE_MESSAGE = 'Transcription request failed.';
export const TRANSCRIPTION_STATUS_FAILURE_MESSAGE = 'Transcription status could not be retrieved.';
export const INVALID_TRANSCRIPTION_RESPONSE_MESSAGE = 'The transcription service returned an invalid response.';

export type ClientFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface TranscriptionApi {
  create(file: AcceptedAudioFile, settings: TranscriptionSettings, signal?: AbortSignal): Promise<StatusUpdate>;
  getStatus(jobId: JobId, signal?: AbortSignal): Promise<StatusUpdate>;
}

export interface SameOriginTranscriptionApiOptions {
  readonly fetchImplementation?: ClientFetch;
  /** Alias useful to callers that name the injected dependency simply `fetch`. */
  readonly fetch?: ClientFetch;
}

export interface ClientTranscriptionApiOptions extends SameOriginTranscriptionApiOptions {}
export type TranscriptionClientApi = TranscriptionApi;

export const TRANSCRIPTION_STATUS_ENDPOINT = (jobId: JobId): string =>
  `${CREATE_TRANSCRIPTION_PATH}/${encodeURIComponent(jobId)}/status`;

export class TranscriptionApiError extends Error {
  public readonly publicMessage: string;
  public readonly statusCode: number;

  public constructor(publicMessage: string, statusCode = 0) {
    super(publicMessage);
    this.name = 'TranscriptionApiError';
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function publicFailureMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const message = payload.failureMessage;
  return typeof message === 'string' && message.length >= 1 && Array.from(message).length <= 1_024
    ? message
    : fallback;
}

function normalizeStatusUpdate(payload: ClientStatusUpdateInput): StatusUpdate {
  if (payload.status !== 'failed') {
    return payload;
  }

  return {
    jobId: payload.jobId,
    status: 'failed',
    failureMessage: normalizeFailureMessage(payload.failureMessage),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function requestWithSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  if (signal === undefined) {
    return init;
  }
  return { ...init, signal };
}

/**
 * Same-origin browser API boundary. The only create fields are the selected
 * audio file and public language setting; provider credentials, handles, and
 * provider payloads are not accepted by this boundary.
 */
export class SameOriginTranscriptionApi implements TranscriptionApi {
  private readonly fetcher: ClientFetch;

  public constructor(options: SameOriginTranscriptionApiOptions = {}) {
    this.fetcher = options.fetchImplementation ?? options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  public async create(
    file: AcceptedAudioFile,
    settings: TranscriptionSettings,
    signal?: AbortSignal,
  ): Promise<StatusUpdate> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('settings', settings);

    let response: Response;
    try {
      response = await this.fetcher(
        CREATE_TRANSCRIPTION_PATH,
        requestWithSignal({ method: 'POST', body: formData }, signal),
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new TranscriptionApiError(TRANSCRIPTION_REQUEST_FAILURE_MESSAGE);
    }

    return this.parseStatusResponse(response, TRANSCRIPTION_REQUEST_FAILURE_MESSAGE);
  }

  public async getStatus(jobId: JobId, signal?: AbortSignal): Promise<StatusUpdate> {
    let response: Response;
    try {
      response = await this.fetcher(
        TRANSCRIPTION_STATUS_ENDPOINT(jobId),
        requestWithSignal({ method: 'GET' }, signal),
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new TranscriptionApiError(TRANSCRIPTION_STATUS_FAILURE_MESSAGE);
    }

    return this.parseStatusResponse(response, TRANSCRIPTION_STATUS_FAILURE_MESSAGE);
  }

  private async parseStatusResponse(
    response: Response,
    fallbackFailureMessage: string,
  ): Promise<StatusUpdate> {
    const payload = await readJson(response);
    if (!response.ok) {
      throw new TranscriptionApiError(
        publicFailureMessage(payload, fallbackFailureMessage),
        response.status,
      );
    }

    if (!isClientStatusUpdateInput(payload)) {
      throw new TranscriptionApiError(INVALID_TRANSCRIPTION_RESPONSE_MESSAGE, response.status);
    }

    return normalizeStatusUpdate(payload);
  }
}

export const ClientTranscriptionApi = SameOriginTranscriptionApi;

export function createSameOriginTranscriptionApi(
  options: SameOriginTranscriptionApiOptions = {},
): SameOriginTranscriptionApi {
  return new SameOriginTranscriptionApi(options);
}
