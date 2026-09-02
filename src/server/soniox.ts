/**
 * Backend-private Soniox boundaries.
 *
 * This module must only be imported by server modules. None of the types in
 * this file are part of the browser-safe shared contract or an HTTP response.
 */

import { loadServerEnvironment } from './environment.js';
import type {
  AcceptedAudioFile,
  TranscriptText,
  TranscriptionSettings,
} from '../shared/transcription.js';

loadServerEnvironment();

const DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE = 'SONIOX_API_KEY';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_PAYLOAD_PREVIEW_CHARACTERS = 4_096;

/** A secret credential that must never cross the backend boundary. */
export type SonioxCredential = string & {
  readonly __sonioxCredential: unique symbol;
};

/** An opaque provider correlation handle that must never be sent to a client. */
export type SonioxProviderHandle = string & {
  readonly __sonioxProviderHandle: unique symbol;
};

/**
 * A backend-only representation of a provider failure. The payload and cause
 * are intentionally retained only for server-side diagnosis and mapping.
 */
export interface ProviderFailureContext {
  readonly kind: 'provider' | 'transport' | 'protocol';
  readonly message: string;
  readonly providerCode: string | undefined;
  readonly statusCode: number | undefined;
  readonly providerPayload: unknown;
  readonly cause: unknown;
}

/** Provider-neutral lifecycle outcomes consumed by the job coordinator. */
export type ProviderOutcome =
  | { readonly status: 'queued' }
  | { readonly status: 'processing' }
  | { readonly status: 'completed'; readonly transcriptText: TranscriptText }
  | { readonly status: 'failed'; readonly context: ProviderFailureContext };

/** Input accepted by the backend-private gateway. */
export interface SonioxGatewaySubmission {
  readonly file: AcceptedAudioFile;
  readonly settings: TranscriptionSettings;
}

/** Initial provider result and its server-only correlation handle. */
export interface SonioxSubmissionResult {
  readonly providerHandle: SonioxProviderHandle | null;
  readonly outcome: ProviderOutcome;
}

/** Server-only source of the credential used for Soniox calls. */
export interface SonioxCredentialStore {
  getCredential(): Promise<SonioxCredential>;
}

/**
 * Server-only provider adapter. Implementations are responsible for
 * translating provider-specific requests and responses into ProviderOutcome.
 */
export interface SonioxGateway {
  submit(
    submission: SonioxGatewaySubmission,
    credential: SonioxCredential,
  ): Promise<SonioxSubmissionResult>;
  refresh(
    providerHandle: SonioxProviderHandle,
    credential: SonioxCredential,
  ): Promise<ProviderOutcome>;
}

/** Error used internally when server configuration has no usable credential. */
export class SonioxCredentialUnavailableError extends Error {
  constructor() {
    super('Soniox credential is unavailable.');
    this.name = 'SonioxCredentialUnavailableError';
  }
}

function toCredential(value: string): SonioxCredential {
  return value as SonioxCredential;
}

function toProviderHandle(value: string): SonioxProviderHandle {
  return value as SonioxProviderHandle;
}

/**
 * Production credential adapter backed by server environment configuration.
 * The supplied environment object is injectable for local server tests; no
 * credential value is ever returned from a browser-facing module.
 */
export class EnvironmentSonioxCredentialStore implements SonioxCredentialStore {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly variableName: string;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    variableName: string = DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE,
  ) {
    this.environment = environment;
    this.variableName = variableName;
  }

  async getCredential(): Promise<SonioxCredential> {
    const value = this.environment[this.variableName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SonioxCredentialUnavailableError();
    }

    return toCredential(value);
  }
}

export interface HttpSonioxGatewayOptions {
  readonly submitUrl: string | URL;
  readonly statusUrl: (providerHandle: SonioxProviderHandle) => string | URL;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
  /** Provider field used for the selected source-language setting. */
  readonly settingsFieldName?: string;
}

interface ProviderPayloadRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is ProviderPayloadRecord {
  return typeof value === 'object' && value !== null;
}

function readString(payload: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readStringIncludingEmpty(payload: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function readProviderHandle(payload: unknown): SonioxProviderHandle | null {
  const value = readString(payload, ['id', 'job_id', 'transcription_id', 'transcriptionId']);
  return value === undefined ? null : toProviderHandle(value);
}

function createFailureContext(
  kind: ProviderFailureContext['kind'],
  message: string,
  details: {
    providerCode?: string | undefined;
    statusCode?: number | undefined;
    providerPayload?: unknown;
    cause?: unknown;
  } = {},
): ProviderFailureContext {
  return {
    kind,
    message,
    providerCode: details.providerCode,
    statusCode: details.statusCode,
    providerPayload: details.providerPayload,
    cause: details.cause,
  };
}

function failedOutcome(
  kind: ProviderFailureContext['kind'],
  message: string,
  details: {
    providerCode?: string | undefined;
    statusCode?: number | undefined;
    providerPayload?: unknown;
    cause?: unknown;
  } = {},
): ProviderOutcome {
  return {
    status: 'failed',
    context: createFailureContext(kind, message, details),
  };
}

function providerOutcomeFromPayload(payload: unknown): ProviderOutcome {
  const status = readString(payload, ['status', 'state'])?.toLowerCase();

  switch (status) {
    case 'queued':
      return { status: 'queued' };
    case 'processing':
    case 'running':
    case 'in_progress':
      return { status: 'processing' };
    case 'completed':
    case 'complete':
    case 'done': {
      const transcriptText = readStringIncludingEmpty(payload, ['transcript_text', 'transcriptText', 'transcript']);
      if (transcriptText !== undefined) {
        return { status: 'completed', transcriptText };
      }

      return failedOutcome('protocol', 'The provider completion did not include transcript text.', {
        providerPayload: payload,
      });
    }
    case 'failed':
    case 'error': {
      return failedOutcome(
        'provider',
        readString(payload, ['message', 'error_message', 'error', 'detail']) ?? 'The provider reported a transcription failure.',
        {
          providerCode: readString(payload, ['code', 'error_code']),
          providerPayload: payload,
        },
      );
    }
    default:
      return failedOutcome('protocol', 'The provider returned an unrecognized transcription state.', {
        providerPayload: payload,
      });
  }
}

async function readProviderPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { raw: body.slice(0, MAX_PROVIDER_PAYLOAD_PREVIEW_CHARACTERS) };
  }
}

function responseFailure(response: Response, payload: unknown): ProviderOutcome {
  return failedOutcome(
    'provider',
    readString(payload, ['message', 'error_message', 'error', 'detail']) ??
      `The provider request failed with status ${response.status}.`,
    {
      providerCode: readString(payload, ['code', 'error_code']),
      statusCode: response.status,
      providerPayload: payload,
    },
  );
}

/**
 * Production HTTP adapter. Provider field names, authorization headers, and
 * response aliases are confined to this backend module.
 */
export class HttpSonioxGateway implements SonioxGateway {
  private readonly submitUrl: string | URL;
  private readonly statusUrl: (providerHandle: SonioxProviderHandle) => string | URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly settingsFieldName: string;

  constructor(options: HttpSonioxGatewayOptions) {
    this.submitUrl = options.submitUrl;
    this.statusUrl = options.statusUrl;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.settingsFieldName = options.settingsFieldName ?? 'language';

    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the Soniox gateway.');
    }
  }

  async submit(
    submission: SonioxGatewaySubmission,
    credential: SonioxCredential,
  ): Promise<SonioxSubmissionResult> {
    try {
      const form = new FormData();
      form.append('file', submission.file, submission.file.name);
      form.append(this.settingsFieldName, submission.settings);

      const response = await this.request(this.submitUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}` },
        body: form,
      });
      const payload = await readProviderPayload(response);

      if (!response.ok) {
        return {
          providerHandle: readProviderHandle(payload),
          outcome: responseFailure(response, payload),
        };
      }

      const providerHandle = readProviderHandle(payload);
      if (providerHandle === null) {
        return {
          providerHandle: null,
          outcome: failedOutcome('protocol', 'The provider response did not include a correlation handle.', {
            providerPayload: payload,
          }),
        };
      }

      return {
        providerHandle,
        outcome: providerOutcomeFromPayload(payload),
      };
    } catch (cause) {
      return {
        providerHandle: null,
        outcome: failedOutcome('transport', 'The provider request could not be completed.', { cause }),
      };
    }
  }

  async refresh(
    providerHandle: SonioxProviderHandle,
    credential: SonioxCredential,
  ): Promise<ProviderOutcome> {
    try {
      const response = await this.request(this.statusUrl(providerHandle), {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      const payload = await readProviderPayload(response);

      if (!response.ok) {
        return responseFailure(response, payload);
      }

      return providerOutcomeFromPayload(payload);
    } catch (cause) {
      return failedOutcome('transport', 'The provider status request could not be completed.', { cause });
    }
  }

  private async request(input: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await this.fetchImplementation(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Creates the production environment-backed credential adapter. */
export function createProductionSonioxCredentialStore(
  environment: NodeJS.ProcessEnv = process.env,
  variableName: string = DEFAULT_CREDENTIAL_ENVIRONMENT_VARIABLE,
): SonioxCredentialStore {
  return new EnvironmentSonioxCredentialStore(environment, variableName);
}

/** Creates the production HTTP provider adapter. */
export function createProductionSonioxGateway(options: HttpSonioxGatewayOptions): SonioxGateway {
  return new HttpSonioxGateway(options);
}
