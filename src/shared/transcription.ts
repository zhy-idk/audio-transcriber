/**
 * Browser-safe transcription contracts.
 *
 * These models intentionally contain no provider credentials, provider handles,
 * exceptions, or server diagnostics. Backend-only details must stay behind the
 * server adapter boundary.
 */

export const AUTOMATIC_LANGUAGE_DETECTION = 'automatic';
export const INVALID_AUDIO_SELECTION_MESSAGE = 'Exactly one audio file is required.';
export const FAILURE_DETAILS_UNAVAILABLE_MESSAGE = 'Failure details are unavailable.';
export const MAX_AUDIO_FILENAME_CHARACTERS = 255;
export const MAX_PUBLIC_FAILURE_MESSAGE_CHARACTERS = 500;
export const MAX_CLIENT_FAILURE_MESSAGE_CHARACTERS = 1_024;

export type JobId = string;
export type TranscriptText = string;
export type TranscriptionSettings = string;
export type PublicFailureMessage = string;

export type TranscriptionStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface QueuedStatusUpdate {
  readonly jobId: JobId;
  readonly status: 'queued';
}

export interface ProcessingStatusUpdate {
  readonly jobId: JobId;
  readonly status: 'processing';
}

export interface CompletedStatusUpdate {
  readonly jobId: JobId;
  readonly status: 'completed';
  readonly transcriptText: TranscriptText;
}

export interface FailedStatusUpdate {
  readonly jobId: JobId;
  readonly status: 'failed';
  readonly failureMessage: PublicFailureMessage;
}

/** A sanitized status update that is safe to expose to the browser. */
export type StatusUpdate =
  | QueuedStatusUpdate
  | ProcessingStatusUpdate
  | CompletedStatusUpdate
  | FailedStatusUpdate;

/**
 * A status update received by the client before failure-detail normalization.
 * The client accepts up to 1,024 characters, while backend-created public
 * failure messages are limited to 500 characters.
 */
export type ClientStatusUpdate =
  | QueuedStatusUpdate
  | ProcessingStatusUpdate
  | CompletedStatusUpdate
  | {
      readonly jobId: JobId;
      readonly status: 'failed';
      readonly failureMessage: string;
    };

/** A structurally valid client status envelope before failure normalization. */
export type ClientStatusUpdateInput =
  | QueuedStatusUpdate
  | ProcessingStatusUpdate
  | CompletedStatusUpdate
  | {
      readonly jobId: JobId;
      readonly status: 'failed';
      readonly failureMessage?: unknown;
    };

export interface FileSelectionValidation {
  readonly accepted: boolean;
  readonly selectedFile: AcceptedAudioFile | null;
  readonly errorMessage: string | null;
}

/**
 * A browser File that has passed the shared audio-file acceptance rule.
 * The runtime guard is structural so it remains usable in local Node tests
 * without requiring a browser File constructor.
 */
export type AcceptedAudioFile = File;
export type FileSelection = readonly File[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isFileLike(value: unknown): value is Pick<File, 'name' | 'type'> {
  return isRecord(value) && typeof value.name === 'string' && typeof value.type === 'string';
}

/** Counts Unicode code points rather than UTF-16 code units. */
export function getAudioFilenameCharacterCount(filename: string): number {
  return characterCount(filename);
}

export function isAcceptedAudioFile(value: unknown): value is AcceptedAudioFile {
  return (
    isFileLike(value) &&
    value.type.startsWith('audio/') &&
    characterCount(value.name) >= 1 &&
    characterCount(value.name) <= MAX_AUDIO_FILENAME_CHARACTERS
  );
}

export function isFileSelection(value: unknown): value is FileSelection {
  return Array.isArray(value) && value.every((file) => isFileLike(file));
}

export function validateFileSelection(selection: unknown): FileSelectionValidation {
  const files = Array.isArray(selection) ? selection : [];
  const selectedFile = files.length === 1 && isAcceptedAudioFile(files[0]) ? files[0] : null;

  return selectedFile
    ? { accepted: true, selectedFile, errorMessage: null }
    : { accepted: false, selectedFile: null, errorMessage: INVALID_AUDIO_SELECTION_MESSAGE };
}

export function isJobId(value: unknown): value is JobId {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function isTranscriptionSettings(value: unknown): value is TranscriptionSettings {
  return typeof value === 'string' && value.length > 0;
}

export function getDefaultTranscriptionSettings(): TranscriptionSettings {
  return AUTOMATIC_LANGUAGE_DETECTION;
}

export function isTranscriptText(value: unknown): value is TranscriptText {
  return typeof value === 'string';
}

export function isPublicFailureMessage(value: unknown): value is PublicFailureMessage {
  return typeof value === 'string' && characterCount(value) >= 1 && characterCount(value) <= MAX_PUBLIC_FAILURE_MESSAGE_CHARACTERS;
}

export function isClientFailureMessage(value: unknown): value is string {
  return typeof value === 'string' && characterCount(value) >= 1 && characterCount(value) <= MAX_CLIENT_FAILURE_MESSAGE_CHARACTERS;
}

export function isTranscriptionStatus(value: unknown): value is TranscriptionStatus {
  return value === 'queued' || value === 'processing' || value === 'completed' || value === 'failed';
}

export function isTerminalStatus(status: TranscriptionStatus | 'idle'): boolean {
  return status === 'completed' || status === 'failed';
}

export function isStatusUpdate(value: unknown): value is StatusUpdate {
  if (!isRecord(value) || typeof value.status !== 'string' || !isJobId(value.jobId)) {
    return false;
  }

  switch (value.status) {
    case 'queued':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'processing':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'completed':
      return hasExactKeys(value, ['jobId', 'status', 'transcriptText']) && isTranscriptText(value.transcriptText);
    case 'failed':
      return hasExactKeys(value, ['jobId', 'status', 'failureMessage']) && isPublicFailureMessage(value.failureMessage);
    default:
      return false;
  }
}

export function isClientStatusUpdate(value: unknown): value is ClientStatusUpdate {
  if (!isRecord(value) || typeof value.status !== 'string' || !isJobId(value.jobId)) {
    return false;
  }

  switch (value.status) {
    case 'queued':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'processing':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'completed':
      return hasExactKeys(value, ['jobId', 'status', 'transcriptText']) && isTranscriptText(value.transcriptText);
    case 'failed':
      return hasExactKeys(value, ['jobId', 'status', 'failureMessage']) && isClientFailureMessage(value.failureMessage);
    default:
      return false;
  }
}

/**
 * Accepts a client status shape far enough to render a failed state safely.
 * Failure details are deliberately checked later by normalizeFailureMessage,
 * so absent, empty, or oversized values become the standard fallback.
 */
export function isClientStatusUpdateInput(value: unknown): value is ClientStatusUpdateInput {
  if (!isRecord(value) || typeof value.status !== 'string' || !isJobId(value.jobId)) {
    return false;
  }

  switch (value.status) {
    case 'queued':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'processing':
      return hasExactKeys(value, ['jobId', 'status']);
    case 'completed':
      return hasExactKeys(value, ['jobId', 'status', 'transcriptText']) && isTranscriptText(value.transcriptText);
    case 'failed':
      return hasExactKeys(value, ['jobId', 'status']) || hasExactKeys(value, ['jobId', 'status', 'failureMessage']);
    default:
      return false;
  }
}
