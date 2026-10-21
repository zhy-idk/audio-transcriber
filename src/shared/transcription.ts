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
export type PublicFailureMessage = string;

export interface TranscriptToken {
  readonly text: string;
  readonly confidence?: number | null | undefined;
  readonly speaker?: string | null | undefined;
  readonly startMs?: number | null | undefined;
  readonly endMs?: number | null | undefined;
}

export type TranscriptionProvider = 'soniox' | 'groq';

export interface StructuredTranscriptionSettings {
  readonly provider?: TranscriptionProvider | undefined;
  readonly languagePreference?: string | undefined;
  readonly languageHints?: readonly string[] | undefined;
  readonly enableDiarization?: boolean | undefined;
  readonly contextTerms?: readonly string[] | undefined;
  readonly contextText?: string | undefined;
}

export type TranscriptionSettings = string;

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
  readonly confidenceScore?: number | null;
  readonly tokens?: readonly TranscriptToken[];
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

export function isTranscriptToken(value: unknown): value is TranscriptToken {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return false;
  }
  if ('confidence' in value && value.confidence !== null && value.confidence !== undefined) {
    if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) {
      return false;
    }
  }
  if ('speaker' in value && value.speaker !== null && value.speaker !== undefined && typeof value.speaker !== 'string') {
    return false;
  }
  if ('startMs' in value && value.startMs !== null && value.startMs !== undefined) {
    if (typeof value.startMs !== 'number' || !Number.isFinite(value.startMs)) {
      return false;
    }
  }
  if ('endMs' in value && value.endMs !== null && value.endMs !== undefined) {
    if (typeof value.endMs !== 'number' || !Number.isFinite(value.endMs)) {
      return false;
    }
  }
  return true;
}

export function isTranscriptionSettings(value: unknown): value is TranscriptionSettings {
  return typeof value === 'string' && value.length > 0;
}

export function serializeTranscriptionSettings(
  settings: StructuredTranscriptionSettings | string,
): string {
  if (typeof settings === 'string') {
    return settings;
  }
  return JSON.stringify(settings);
}

export function normalizeTranscriptionSettings(settings: unknown): StructuredTranscriptionSettings {
  if (isRecord(settings)) {
    return {
      ...(typeof settings.provider === 'string' ? { provider: settings.provider === 'groq' ? 'groq' : 'soniox' } : {}),
      languagePreference: typeof settings.languagePreference === 'string' ? settings.languagePreference : AUTOMATIC_LANGUAGE_DETECTION,
      languageHints: Array.isArray(settings.languageHints) ? settings.languageHints.filter((h): h is string => typeof h === 'string') : [],
      enableDiarization: typeof settings.enableDiarization === 'boolean' ? settings.enableDiarization : false,
      contextTerms: Array.isArray(settings.contextTerms) ? settings.contextTerms.filter((t): t is string => typeof t === 'string') : [],
      contextText: typeof settings.contextText === 'string' ? settings.contextText : undefined,
    };
  }

  if (typeof settings === 'string') {
    const trimmed = settings.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) {
          return normalizeTranscriptionSettings(parsed);
        }
      } catch {
        // Fall back to plain string
      }
    }
    if (trimmed === AUTOMATIC_LANGUAGE_DETECTION || trimmed === '') {
      return {
        languagePreference: AUTOMATIC_LANGUAGE_DETECTION,
        languageHints: [],
        enableDiarization: false,
        contextTerms: [],
        contextText: undefined,
      };
    }
    return {
      languagePreference: trimmed,
      languageHints: [trimmed],
      enableDiarization: false,
      contextTerms: [],
      contextText: undefined,
    };
  }

  return {
    languagePreference: AUTOMATIC_LANGUAGE_DETECTION,
    languageHints: [],
    enableDiarization: false,
    contextTerms: [],
    contextText: undefined,
  };
}

export interface FormatDiarizedOptions {
  readonly includeTimestamps?: boolean;
}

export function formatTimeMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '00:00';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function formatDiarizedTranscript(
  tokens: readonly TranscriptToken[],
  options?: FormatDiarizedOptions,
): string {
  const segments: Array<{
    speaker: string;
    textParts: string[];
    startMs: number | null;
    endMs: number | null;
  }> = [];
  let currentSpeaker: string | null = null;
  let currentParts: string[] = [];
  let currentStartMs: number | null = null;
  let currentEndMs: number | null = null;

  for (const token of tokens) {
    const tokenSpeaker = token.speaker ?? '1';
    if (currentSpeaker === null) {
      currentSpeaker = tokenSpeaker;
      currentParts.push(token.text);
      currentStartMs = typeof token.startMs === 'number' ? token.startMs : null;
      currentEndMs = typeof token.endMs === 'number' ? token.endMs : null;
    } else if (tokenSpeaker === currentSpeaker) {
      currentParts.push(token.text);
      if (currentStartMs === null && typeof token.startMs === 'number') {
        currentStartMs = token.startMs;
      }
      if (typeof token.endMs === 'number') {
        currentEndMs = token.endMs;
      }
    } else {
      segments.push({
        speaker: currentSpeaker,
        textParts: currentParts,
        startMs: currentStartMs,
        endMs: currentEndMs,
      });
      currentSpeaker = tokenSpeaker;
      currentParts = [token.text];
      currentStartMs = typeof token.startMs === 'number' ? token.startMs : null;
      currentEndMs = typeof token.endMs === 'number' ? token.endMs : null;
    }
  }
  if (currentSpeaker !== null && currentParts.length > 0) {
    segments.push({
      speaker: currentSpeaker,
      textParts: currentParts,
      startMs: currentStartMs,
      endMs: currentEndMs,
    });
  }

  const includeTimestamps = Boolean(options?.includeTimestamps);

  return segments
    .map((seg) => {
      const trimmed = seg.speaker.trim();
      const label = /^\d+$/u.test(trimmed) ? `Speaker ${trimmed}` : trimmed;
      const text = seg.textParts.join('').trim();
      if (includeTimestamps && (seg.startMs !== null || seg.endMs !== null)) {
        const start = formatTimeMs(seg.startMs ?? 0);
        const end = seg.endMs !== null ? formatTimeMs(seg.endMs) : start;
        return `[${start} - ${end}] ${label}: ${text}`;
      }
      return `${label}: ${text}`;
    })
    .join('\n\n');
}

export function computeConfidenceScore(tokens: readonly TranscriptToken[]): number | null {
  const valid = tokens.filter(
    (t): t is TranscriptToken & { confidence: number } =>
      typeof t.confidence === 'number' && Number.isFinite(t.confidence),
  );
  if (valid.length === 0) {
    return null;
  }
  const sum = valid.reduce((acc, t) => acc + t.confidence, 0);
  return Math.round((sum / valid.length) * 100) / 100;
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

function isValidCompletedPayload(value: Record<string, unknown>): boolean {
  const allowedKeys = ['jobId', 'status', 'transcriptText', 'confidenceScore', 'tokens'];
  const ownKeys = Object.keys(value);
  if (!ownKeys.every((key) => allowedKeys.includes(key))) {
    return false;
  }
  if (
    !Object.prototype.hasOwnProperty.call(value, 'jobId') ||
    !Object.prototype.hasOwnProperty.call(value, 'status') ||
    !Object.prototype.hasOwnProperty.call(value, 'transcriptText')
  ) {
    return false;
  }
  if (!isTranscriptText(value.transcriptText)) {
    return false;
  }
  if ('confidenceScore' in value && value.confidenceScore !== null && value.confidenceScore !== undefined) {
    if (typeof value.confidenceScore !== 'number' || !Number.isFinite(value.confidenceScore)) {
      return false;
    }
  }
  if ('tokens' in value && value.tokens !== null && value.tokens !== undefined) {
    if (!Array.isArray(value.tokens) || !value.tokens.every(isTranscriptToken)) {
      return false;
    }
  }
  return true;
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
      return isValidCompletedPayload(value);
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
      return isValidCompletedPayload(value);
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
      return isValidCompletedPayload(value);
    case 'failed':
      return hasExactKeys(value, ['jobId', 'status']) || hasExactKeys(value, ['jobId', 'status', 'failureMessage']);
    default:
      return false;
  }
}
