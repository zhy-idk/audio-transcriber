import {
  FAILURE_DETAILS_UNAVAILABLE_MESSAGE,
  type AcceptedAudioFile,
  type ClientStatusUpdateInput,
  type JobId,
  type TranscriptText,
  type TranscriptionSettings,
  type TranscriptionStatus,
  type StatusUpdate,
  getDefaultTranscriptionSettings,
  isClientStatusUpdateInput,
  isTerminalStatus,
} from '../shared/transcription';

export interface ClientTranscriptionState {
  readonly selectedFile: AcceptedAudioFile | null;
  readonly selectedSettings: TranscriptionSettings;
  readonly activeJobId: JobId | null;
  readonly status: TranscriptionStatus | 'idle';
  readonly transcriptText: TranscriptText | null;
  readonly failureMessage: string | null;
}

export function createInitialClientState(
  selectedSettings: TranscriptionSettings = getDefaultTranscriptionSettings(),
): ClientTranscriptionState {
  return {
    selectedFile: null,
    selectedSettings,
    activeJobId: null,
    status: 'idle',
    transcriptText: null,
    failureMessage: null,
  };
}

/** The settings control is locked only while an active job is non-terminal. */
export function areSettingsLocked(state: ClientTranscriptionState): boolean {
  return state.activeJobId !== null && (state.status === 'queued' || state.status === 'processing');
}

export function canDownloadTranscript(state: ClientTranscriptionState): boolean {
  return state.status === 'completed' && state.transcriptText !== null;
}

/** A failed active job exposes the terminal start-new action. */
export function canStartNewTranscription(
  state: Pick<ClientTranscriptionState, 'activeJobId' | 'status'>,
): boolean {
  return state.activeJobId !== null && state.status === 'failed';
}

export function normalizeFailureMessage(value: unknown): string {
  return typeof value === 'string' && value.length >= 1 && Array.from(value).length <= 1_024
    ? value
    : FAILURE_DETAILS_UNAVAILABLE_MESSAGE;
}

function applyStatusUpdate(
  state: ClientTranscriptionState,
  update: ClientStatusUpdateInput,
): ClientTranscriptionState {
  if (update.status === 'completed') {
    return {
      ...state,
      status: update.status,
      transcriptText: update.transcriptText,
      failureMessage: null,
    };
  }

  if (update.status === 'failed') {
    return {
      ...state,
      status: update.status,
      transcriptText: null,
      failureMessage: normalizeFailureMessage(update.failureMessage),
    };
  }

  return {
    ...state,
    status: update.status,
    transcriptText: null,
    failureMessage: null,
  };
}

/**
 * Makes a create response the active job and clears any previous transcript.
 * The initial update may already be terminal when submission fails quickly.
 */
export function startClientJob(
  state: ClientTranscriptionState,
  initialUpdate: StatusUpdate,
): ClientTranscriptionState {
  return applyStatusUpdate(
    {
      ...state,
      selectedFile: null,
      activeJobId: initialUpdate.jobId,
      status: 'idle',
      transcriptText: null,
      failureMessage: null,
    },
    initialUpdate,
  );
}

/**
 * Applies only valid, active-job updates. Once terminal, a job cannot roll back
 * to queued/processing or be replaced by a later terminal update.
 */
export function reduceClientStatus(
  state: ClientTranscriptionState,
  update: unknown,
): ClientTranscriptionState {
  if (
    !isClientStatusUpdateInput(update) ||
    state.activeJobId === null ||
    update.jobId !== state.activeJobId ||
    isTerminalStatus(state.status)
  ) {
    return state;
  }

  return applyStatusUpdate(state, update);
}
