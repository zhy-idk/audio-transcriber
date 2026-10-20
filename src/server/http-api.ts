/**
 * Same-origin HTTP boundary for the browser transcription workflow.
 *
 * This module owns wire parsing and response serialization only. Credential
 * retrieval, provider calls, job persistence, and lifecycle decisions remain
 * behind the injected JobCoordinator.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERIC_PUBLIC_FAILURE_MESSAGE,
  REJECTED_REQUEST_FAILURE_MESSAGE,
  mapPublicStatus,
  sanitizePublicFailureMessage,
} from './public-status.js';
import type { CreateTranscriptionResult } from './job-coordinator.js';
import { SpeakerIdentificationService } from './speaker-identification.js';
import type { StatusUpdate } from '../shared/transcription.js';

const CREATE_TRANSCRIPTION_PATH = '/api/transcriptions';
const STATUS_PATH_PREFIX = `${CREATE_TRANSCRIPTION_PATH}/`;
const STATUS_PATH_SUFFIX = '/status';
const AUDIO_PATH_SUFFIX = '/audio';
const SPEAKERS_PATH = '/api/speakers';
const ENROLL_SPEAKER_PATH = `${SPEAKERS_PATH}/enroll`;
const REMOVE_SPEAKER_PATH = `${SPEAKERS_PATH}/remove`;
const NOT_FOUND_FAILURE_MESSAGE = 'Transcription job was not found.';
const MALFORMED_REQUEST_FAILURE_MESSAGE = 'The transcription request was rejected.';
const SERVER_FAILURE_STATUS = 500;

/** The narrow coordinator surface used by the HTTP boundary and its tests. */
export interface TranscriptionHttpCoordinator {
  create(selection: unknown, settings: unknown): Promise<CreateTranscriptionResult>;
  getStatus(jobId: unknown): Promise<StatusUpdate | null>;
  getAudio?(jobId: unknown): Promise<{ readonly path: string; readonly mimeType: string; readonly filename?: string } | null>;
}

/** Options for the existing Node server factory. */
export interface ApplicationServerOptions {
  readonly coordinator?: TranscriptionHttpCoordinator | undefined;
  readonly speakerService?: SpeakerIdentificationService | undefined;
}

interface MultipartPart {
  readonly name: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly body: Buffer;
}

interface ParsedMultipartForm {
  readonly files: readonly File[];
  readonly settings: string | undefined;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    return;
  }

  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function sendFailure(response: ServerResponse, statusCode: number, message: unknown, fallback = GENERIC_PUBLIC_FAILURE_MESSAGE): void {
  sendJson(response, statusCode, {
    failureMessage: sanitizePublicFailureMessage(message, fallback),
  });
}

function parseContentType(value: string | undefined): { mediaType: string; boundary: string | null } {
  if (typeof value !== 'string') {
    return { mediaType: '', boundary: null };
  }

  const [mediaTypePart, ...parameters] = value.split(';');
  const mediaType = (mediaTypePart ?? '').trim().toLowerCase();
  let boundary: string | null = null;

  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 0) {
      continue;
    }

    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== 'boundary') {
      continue;
    }

    const rawValue = parameter.slice(separator + 1).trim();
    boundary = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    break;
  }

  return { mediaType, boundary: boundary && boundary.length > 0 ? boundary : null };
}

function readDispositionParameter(header: string, parameterName: string): string | null {
  const pattern = new RegExp(`(?:^|;)\\s*${parameterName}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^;\\s]*))`, 'i');
  const match = pattern.exec(header);
  if (match === null) {
    return null;
  }

  if (match[1] !== undefined) {
    return match[1].replace(/\\(.)/g, '$1');
  }
  return match[2] ?? null;
}

function parsePartHeaders(headerBytes: Buffer): { name: string; filename: string | null; contentType: string | null } | null {
  const headerText = headerBytes.toString('utf8');
  const headers = new Map<string, string>();

  for (const line of headerText.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return null;
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const disposition = headers.get('content-disposition');
  if (disposition === undefined || !/^form-data(?:;|$)/i.test(disposition)) {
    return null;
  }

  const name = readDispositionParameter(disposition, 'name');
  if (name === null || name.length === 0) {
    return null;
  }

  const filename = readDispositionParameter(disposition, 'filename');
  const contentType = headers.get('content-type');
  return {
    name,
    filename,
    contentType: contentType === undefined || contentType.length === 0 ? null : contentType,
  };
}

/**
 * Parses multipart bytes without converting the file body to text. Multipart
 * delimiters are recognized only at a CRLF boundary, so delimiter-like bytes
 * inside an audio payload remain unchanged.
 */
function parseMultipartBody(body: Buffer, boundary: string): MultipartPart[] | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const firstDelimiter = body.indexOf(delimiter);
  if (firstDelimiter !== 0) {
    return null;
  }

  const parts: MultipartPart[] = [];
  let cursor = delimiter.length;

  while (true) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) {
      const remainder = body.subarray(cursor + 2);
      return remainder.length === 0 || remainder.equals(Buffer.from('\r\n')) ? parts : null;
    }

    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) {
      return null;
    }
    cursor += 2;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) {
      return null;
    }

    const headers = parsePartHeaders(body.subarray(cursor, headerEnd));
    if (headers === null) {
      return null;
    }

    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0) {
      return null;
    }

    parts.push({
      ...headers,
      body: body.subarray(contentStart, contentEnd),
    });

    cursor = contentEnd + 2 + delimiter.length;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fileFromPart(part: MultipartPart): File {
  // Node 20+ supplies the same File primitive used by the browser. Keeping
  // the original filename and browser-provided media type is required for the
  // backend validator and provider submission contract.
  return new File([part.body], part.filename ?? '', {
    type: part.contentType ?? '',
  });
}

function parseMultipartForm(contentType: string | undefined, body: Buffer): ParsedMultipartForm | null {
  const parsedContentType = parseContentType(contentType);
  if (parsedContentType.mediaType !== 'multipart/form-data' || parsedContentType.boundary === null) {
    return null;
  }

  const parts = parseMultipartBody(body, parsedContentType.boundary);
  if (parts === null) {
    return null;
  }

  const files: File[] = [];
  let settings: string | undefined;
  let settingsFieldCount = 0;

  for (const part of parts) {
    if (part.filename !== null) {
      files.push(fileFromPart(part));
      continue;
    }

    // `settings` is the public wire name. `language` is accepted as a
    // backwards-compatible alias for the selected source-language value.
    if (part.name === 'settings' || part.name === 'language') {
      settingsFieldCount += 1;
      if (settingsFieldCount === 1) {
        settings = part.body.toString('utf8');
      }
    }
  }

  return {
    files,
    settings: settingsFieldCount === 1 ? settings : undefined,
  };
}

function parseEnrollForm(contentType: string | undefined, body: Buffer): {
  readonly name: string | null;
  readonly audioBuffer: Buffer | null;
  readonly filename: string | null;
} | null {
  const parsedContentType = parseContentType(contentType);
  if (parsedContentType.mediaType !== 'multipart/form-data' || parsedContentType.boundary === null) {
    return null;
  }

  const parts = parseMultipartBody(body, parsedContentType.boundary);
  if (parts === null) {
    return null;
  }

  let name: string | null = null;
  let audioBuffer: Buffer | null = null;
  let filename: string | null = null;

  for (const part of parts) {
    if (part.name === 'name') {
      name = part.body.toString('utf8').trim();
    } else if (part.name === 'audio' || part.name === 'file') {
      audioBuffer = part.body;
      filename = part.filename;
    }
  }

  return { name, audioBuffer, filename };
}

function routeJobId(pathname: string): string | null {
  if (!pathname.startsWith(STATUS_PATH_PREFIX) || !pathname.endsWith(STATUS_PATH_SUFFIX)) {
    return null;
  }

  const encodedJobId = pathname.slice(STATUS_PATH_PREFIX.length, -STATUS_PATH_SUFFIX.length);
  if (encodedJobId.length === 0 || encodedJobId.includes('/')) {
    return null;
  }

  try {
    return decodeURIComponent(encodedJobId);
  } catch {
    return null;
  }
}

function routeAudioJobId(pathname: string): string | null {
  if (!pathname.startsWith(STATUS_PATH_PREFIX) || !pathname.endsWith(AUDIO_PATH_SUFFIX)) {
    return null;
  }

  const encodedJobId = pathname.slice(STATUS_PATH_PREFIX.length, -AUDIO_PATH_SUFFIX.length);
  if (encodedJobId.length === 0 || encodedJobId.includes('/')) {
    return null;
  }

  try {
    return decodeURIComponent(encodedJobId);
  } catch {
    return null;
  }
}

function publicCreateStatus(result: CreateTranscriptionResult): StatusUpdate | null {
  if (!result.accepted) {
    return null;
  }
  return mapPublicStatus(result.status);
}

async function handleCreate(
  request: IncomingMessage,
  response: ServerResponse,
  coordinator: TranscriptionHttpCoordinator | undefined,
): Promise<void> {
  if (coordinator === undefined) {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }

  let form: ParsedMultipartForm | null;
  try {
    form = parseMultipartForm(request.headers['content-type'], await readRequestBody(request));
  } catch {
    form = null;
  }

  if (form === null) {
    sendFailure(response, 400, MALFORMED_REQUEST_FAILURE_MESSAGE, REJECTED_REQUEST_FAILURE_MESSAGE);
    return;
  }

  let result: CreateTranscriptionResult;
  try {
    result = await coordinator.create(form.files, form.settings);
  } catch {
    // The coordinator is not allowed to turn internal exceptions into a wire
    // response. Keep this catch at the HTTP boundary as a final redaction wall.
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }

  if (!result.accepted) {
    sendFailure(response, 400, result.failureMessage, REJECTED_REQUEST_FAILURE_MESSAGE);
    return;
  }

  const status = publicCreateStatus(result);
  if (status === null) {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }
  sendJson(response, 202, status);
}

async function handleStatus(
  response: ServerResponse,
  coordinator: TranscriptionHttpCoordinator | undefined,
  jobId: string,
): Promise<void> {
  if (coordinator === undefined) {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }

  let status: StatusUpdate | null;
  try {
    status = await coordinator.getStatus(jobId);
  } catch {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }

  if (status === null) {
    sendFailure(response, 404, NOT_FOUND_FAILURE_MESSAGE, NOT_FOUND_FAILURE_MESSAGE);
    return;
  }

  const publicStatus = mapPublicStatus(status);
  if (publicStatus === null) {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }
  sendJson(response, 200, publicStatus);
}

async function handleAudio(
  request: IncomingMessage,
  response: ServerResponse,
  coordinator: TranscriptionHttpCoordinator | undefined,
  jobId: string,
): Promise<void> {
  if (coordinator === undefined || typeof coordinator.getAudio !== 'function') {
    sendFailure(response, 404, 'Audio stream unavailable.');
    return;
  }

  let audioInfo: { readonly path: string; readonly mimeType: string; readonly filename?: string } | null = null;
  try {
    audioInfo = await coordinator.getAudio(jobId);
  } catch {
    sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    return;
  }

  if (audioInfo === null) {
    sendFailure(response, 404, 'Audio file not found.');
    return;
  }

  let statResult: Stats;
  try {
    statResult = await stat(audioInfo.path);
  } catch {
    sendFailure(response, 404, 'Audio file not found.');
    return;
  }

  const totalSize = statResult.size;
  const rangeHeader = request.headers.range;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/i, '').split('-');
    const start = parseInt(parts[0] ?? '', 10) || 0;
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (start >= totalSize || end >= totalSize || start > end) {
      response.statusCode = 416;
      response.setHeader('Content-Range', `bytes */${totalSize}`);
      response.end();
      return;
    }

    const chunkLength = end - start + 1;
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', chunkLength);
    response.setHeader('Content-Type', audioInfo.mimeType);
    createReadStream(audioInfo.path, { start, end }).pipe(response);
  } else {
    response.statusCode = 200;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', totalSize);
    response.setHeader('Content-Type', audioInfo.mimeType);
    createReadStream(audioInfo.path).pipe(response);
  }
}

async function handleListSpeakers(
  response: ServerResponse,
  speakerService: SpeakerIdentificationService,
): Promise<void> {
  try {
    const speakers = await speakerService.list();
    sendJson(response, 200, { speakers });
  } catch (err) {
    sendFailure(response, SERVER_FAILURE_STATUS, err instanceof Error ? err.message : 'Failed to list speakers.');
  }
}

async function handleEnrollSpeaker(
  request: IncomingMessage,
  response: ServerResponse,
  speakerService: SpeakerIdentificationService,
): Promise<void> {
  let form: ReturnType<typeof parseEnrollForm>;
  try {
    form = parseEnrollForm(request.headers['content-type'], await readRequestBody(request));
  } catch {
    form = null;
  }

  if (form === null || !form.name || !form.audioBuffer || form.audioBuffer.length === 0) {
    sendFailure(response, 400, 'Speaker name and audio sample are required.');
    return;
  }

  const ext = form.filename && form.filename.includes('.')
    ? form.filename.slice(form.filename.lastIndexOf('.'))
    : '.wav';
  const tempPath = join(tmpdir(), `speaker-enroll-${randomUUID()}${ext}`);

  try {
    await writeFile(tempPath, form.audioBuffer);
    const result = await speakerService.enroll(form.name, tempPath);
    sendJson(response, 200, {
      status: 'enrolled',
      name: result.name,
      embeddingDim: result.embedding_dim,
    });
  } catch (error) {
    sendFailure(response, 500, error instanceof Error ? error.message : 'Enrollment failed.');
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function handleRemoveSpeaker(
  request: IncomingMessage,
  response: ServerResponse,
  speakerService: SpeakerIdentificationService,
  pathname: string,
  requestUrl: URL,
): Promise<void> {
  let name: string | null = null;
  if (pathname.startsWith(`${SPEAKERS_PATH}/`)) {
    const encoded = pathname.slice(`${SPEAKERS_PATH}/`.length);
    if (encoded.length > 0 && !encoded.includes('/')) {
      try {
        name = decodeURIComponent(encoded);
      } catch {
        name = null;
      }
    }
  }

  if (!name) {
    name = requestUrl.searchParams.get('name');
  }

  if (!name && request.method === 'POST') {
    try {
      const body = await readRequestBody(request);
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (typeof parsed?.name === 'string') {
        name = parsed.name.trim();
      }
    } catch {
      // ignore
    }
  }

  if (!name || name.trim().length === 0) {
    sendFailure(response, 400, 'Speaker name is required.');
    return;
  }

  try {
    const removed = await speakerService.remove(name.trim());
    sendJson(response, 200, { status: removed ? 'removed' : 'not_found', name: name.trim() });
  } catch (error) {
    sendFailure(response, 500, error instanceof Error ? error.message : 'Failed to remove speaker.');
  }
}

/** Handles the same-origin transcription and speaker identification operations. */
export function createTranscriptionHttpHandler(
  coordinator: TranscriptionHttpCoordinator,
  speakerService?: SpeakerIdentificationService,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void handleRequest(request, response, coordinator, speakerService).catch(() => {
      sendFailure(response, SERVER_FAILURE_STATUS, undefined);
    });
  };
}

/** @internal exported for focused local handler tests and custom Node servers. */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  coordinator: TranscriptionHttpCoordinator | undefined,
  speakerService?: SpeakerIdentificationService,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const pathname = requestUrl.pathname;
  const resolvedSpeakerService = speakerService ?? new SpeakerIdentificationService();

  if (request.method === 'POST' && pathname === CREATE_TRANSCRIPTION_PATH) {
    await handleCreate(request, response, coordinator);
    return;
  }

  if (request.method === 'GET') {
    if (pathname === SPEAKERS_PATH) {
      await handleListSpeakers(response, resolvedSpeakerService);
      return;
    }

    const audioJobId = routeAudioJobId(pathname);
    if (audioJobId !== null) {
      await handleAudio(request, response, coordinator, audioJobId);
      return;
    }

    const jobId = routeJobId(pathname);
    if (jobId !== null) {
      await handleStatus(response, coordinator, jobId);
      return;
    }
  }

  if (request.method === 'POST' && pathname === ENROLL_SPEAKER_PATH) {
    await handleEnrollSpeaker(request, response, resolvedSpeakerService);
    return;
  }

  if (
    (request.method === 'DELETE' && (pathname.startsWith(`${SPEAKERS_PATH}/`) || pathname === SPEAKERS_PATH)) ||
    (request.method === 'POST' && pathname === REMOVE_SPEAKER_PATH)
  ) {
    await handleRemoveSpeaker(request, response, resolvedSpeakerService, pathname, requestUrl);
    return;
  }

  if (
    pathname === CREATE_TRANSCRIPTION_PATH ||
    routeJobId(pathname) !== null ||
    routeAudioJobId(pathname) !== null ||
    pathname === SPEAKERS_PATH ||
    pathname.startsWith(`${SPEAKERS_PATH}/`)
  ) {
    const allow = pathname === CREATE_TRANSCRIPTION_PATH
      ? 'POST'
      : routeJobId(pathname) !== null || routeAudioJobId(pathname) !== null
        ? 'GET'
        : 'GET, POST, DELETE';
    response.setHeader('allow', allow);
    sendFailure(response, 405, 'The requested method is not allowed.', 'The requested method is not allowed.');
    return;
  }

  sendJson(response, 404, { failureMessage: 'Not Found' });
}

