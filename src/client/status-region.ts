import { type TranscriptionStatus } from '../shared/transcription';
import { canStartNewTranscription, normalizeFailureMessage, type ClientTranscriptionState } from './state';

export const START_NEW_TRANSCRIPTION_LABEL = 'Start new transcription';

export type JobStatusRegionState = Pick<
  ClientTranscriptionState,
  'activeJobId' | 'status' | 'failureMessage'
>;

export interface JobStatusRegionElements {
  readonly root: HTMLDivElement;
  readonly statusLabel: HTMLElement;
  readonly processingIndicator: HTMLElement;
  readonly failureMessage: HTMLElement;
  readonly startNewButton: HTMLButtonElement;
}

export interface JobStatusRegionOptions {
  readonly onStartNew?: () => void;
}

export interface JobStatusRegionInstance {
  readonly root: HTMLDivElement;
  readonly elements: JobStatusRegionElements;
  readonly region: JobStatusRegion;
}

const STATUS_LABELS: Readonly<Record<TranscriptionStatus, string>> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_REGION_CLASSES = [
  'min-w-0',
  'rounded-lg',
  'border',
  'border-outline-variant',
  'bg-surface-container-low',
  'p-margin-md',
] as const;

const STATUS_LABEL_CLASSES = [
  'font-geist',
  'text-label-md',
  'uppercase',
  'text-on-surface-variant',
] as const;

const PROCESSING_INDICATOR_CLASSES = [
  'inline-block',
  'h-3',
  'w-3',
  'rounded-full',
  'bg-secondary',
  'animate-processing',
] as const;

/**
 * Renders the public lifecycle state and terminal retry control.
 *
 * The region is a passive view of ClientTranscriptionState: correlation,
 * terminal immutability, and failure normalization belong to the reducer.
 * Its status container is a polite live region so every visible status change
 * is announced without interrupting the user's current work.
 */
export class JobStatusRegion {
  private readonly onStartNew: () => void;

  private readonly handleStartNew = (): void => {
    if (!this.elements.startNewButton.disabled) {
      this.onStartNew();
    }
  };

  public constructor(
    private readonly elements: JobStatusRegionElements,
    options: JobStatusRegionOptions = {},
  ) {
    this.onStartNew = options.onStartNew ?? (() => undefined);

    this.elements.root.classList.add(...STATUS_REGION_CLASSES);
    this.elements.root.setAttribute('role', 'status');
    this.elements.root.setAttribute('aria-live', 'polite');
    this.elements.root.setAttribute('aria-atomic', 'true');
    this.elements.root.setAttribute('aria-label', 'Transcription status');

    this.elements.statusLabel.classList.add(...STATUS_LABEL_CLASSES);
    this.elements.processingIndicator.classList.add(...PROCESSING_INDICATOR_CLASSES);
    this.elements.processingIndicator.setAttribute('aria-hidden', 'true');
    this.elements.processingIndicator.setAttribute('data-processing-indicator', 'true');

    this.elements.failureMessage.className =
      'mt-2 break-words font-inter text-body-sm text-error';
    this.elements.failureMessage.setAttribute('data-failure-message', 'true');

    this.elements.startNewButton.type = 'button';
    this.elements.startNewButton.textContent = START_NEW_TRANSCRIPTION_LABEL;
    this.elements.startNewButton.className =
      'mt-margin-sm rounded-lg bg-secondary px-5 py-3 font-geist text-label-md text-on-secondary outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50';
    this.elements.startNewButton.setAttribute('aria-label', START_NEW_TRANSCRIPTION_LABEL);
    this.elements.startNewButton.addEventListener('click', this.handleStartNew);

    this.render({ activeJobId: null, status: 'idle', failureMessage: null });
  }

  public get startNewEnabled(): boolean {
    return !this.elements.startNewButton.disabled && !this.elements.startNewButton.hidden;
  }

  public render(state: JobStatusRegionState): void {
    const hasActiveStatus = state.activeJobId !== null && state.status !== 'idle';
    const isProcessing = hasActiveStatus && state.status === 'processing';
    const isFailed = hasActiveStatus && state.status === 'failed';

    this.elements.root.hidden = !hasActiveStatus;
    this.elements.statusLabel.textContent = hasActiveStatus
      ? STATUS_LABELS[state.status as TranscriptionStatus]
      : '';
    this.elements.processingIndicator.hidden = !isProcessing;
    this.elements.failureMessage.hidden = !isFailed;
    this.elements.failureMessage.textContent = isFailed
      ? normalizeFailureMessage(state.failureMessage)
      : '';
    this.elements.startNewButton.hidden = !isFailed;
    this.elements.startNewButton.disabled = !isFailed || !canStartNewTranscription(state);

    if (isFailed) {
      this.elements.startNewButton.setAttribute('aria-describedby', this.elements.failureMessage.id);
    } else {
      this.elements.startNewButton.removeAttribute('aria-describedby');
    }
  }

  public destroy(): void {
    this.elements.startNewButton.removeEventListener('click', this.handleStartNew);
  }
}

export function createJobStatusRegion(
  document: Document,
  options: JobStatusRegionOptions = {},
): JobStatusRegionInstance {
  const root = document.createElement('div');
  const statusLabel = document.createElement('p');
  const processingIndicator = document.createElement('span');
  const failureMessage = document.createElement('p');
  const startNewButton = document.createElement('button');

  failureMessage.id = 'transcription-failure-message';
  root.append(statusLabel, processingIndicator, failureMessage, startNewButton);

  const elements: JobStatusRegionElements = {
    root,
    statusLabel,
    processingIndicator,
    failureMessage,
    startNewButton,
  };
  const region = new JobStatusRegion(elements, options);

  return { root, elements, region };
}
