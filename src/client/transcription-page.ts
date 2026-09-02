import {
  areSettingsLocked,
  canDownloadTranscript,
  createInitialClientState,
  normalizeFailureMessage,
  reduceClientStatus,
  startClientJob,
  type ClientTranscriptionState,
} from './state';
import {
  createJobStatusRegion,
  type JobStatusRegionInstance,
} from './status-region';
import { createTranscriptExporter, type TranscriptExporter } from './transcript-exporter';
import { TranscriptViewer } from './transcript-viewer';
import { createLanguagePreferenceControl, type LanguagePreferenceControlInstance } from './language-preference';
import { createUploadZone, type UploadZone } from './upload-zone';
import {
  createSameOriginTranscriptionApi,
  TranscriptionApiError,
  type TranscriptionApi,
} from './transcription-api';
import {
  createStatusPollingController,
  type StatusPollingController,
} from './polling-controller';
import type { StatusUpdate } from '../shared/transcription';

const PAGE_FAILURE_MESSAGE = 'Transcription could not be started.';
const POLLING_FAILURE_MESSAGE = 'Transcription status could not be retrieved.';

type PageLayout = 'idle' | 'queued' | 'processing' | 'failed' | 'completed';

export interface TranscriptionPageElements {
  readonly root: HTMLElement;
  readonly idleLayout: HTMLElement;
  readonly queuedLayout: HTMLElement;
  readonly processingLayout: HTMLElement;
  readonly failedLayout: HTMLElement;
  readonly completedLayout: HTMLElement;
  readonly uploadZoneMount: HTMLElement;
  readonly languageMount: HTMLElement;
  readonly startButton: HTMLButtonElement;
  readonly requestFailure: HTMLElement;
  readonly queuedStatusMount: HTMLElement;
  readonly processingStatusMount: HTMLElement;
  readonly failedStatusMount: HTMLElement;
  readonly completedStatusMount: HTMLElement;
  readonly transcriptViewerMount: HTMLElement;
  readonly downloadButton: HTMLButtonElement;
  readonly downloadFailure: HTMLElement;
  readonly completedStartNewButton: HTMLButtonElement;
}

export interface TranscriptionPageOptions {
  readonly api?: TranscriptionApi;
  readonly polling?: StatusPollingController;
  readonly exporter?: TranscriptExporter;
  readonly pollIntervalMs?: number;
}

export interface TranscriptionPageInstance {
  readonly root: HTMLElement;
  readonly elements: TranscriptionPageElements;
  readonly uploadZone: UploadZone;
  readonly languageControl: LanguagePreferenceControlInstance;
  readonly statusRegion: JobStatusRegionInstance;
  readonly viewer: TranscriptViewer;
  readonly exporter: TranscriptExporter;
  readonly state: ClientTranscriptionState;
  destroy(): void;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  className = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className.length > 0) {
    element.className = className;
  }
  return element;
}

function setLayoutState(element: HTMLElement, layout: PageLayout): void {
  element.setAttribute('data-layout', layout);
}

function createLayout(document: Document, layout: PageLayout): HTMLElement {
  const element = createElement(
    document,
    'section',
    'min-w-0 space-y-margin-md',
  );
  setLayoutState(element, layout);
  return element;
}

function createLayoutHeading(document: Document, text: string): HTMLHeadingElement {
  const heading = createElement(
    document,
    'h2',
    'font-geist text-headline-lg-mobile text-on-surface sm:text-headline-lg',
  );
  heading.textContent = text;
  return heading;
}

function createActionButton(
  document: Document,
  text: string,
  className: string,
): HTMLButtonElement {
  const button = createElement(document, 'button', className);
  button.type = 'button';
  button.textContent = text;
  return button;
}

function publicErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof TranscriptionApiError) {
    return normalizeFailureMessage(error.publicMessage);
  }
  return fallback;
}

function layoutForState(state: ClientTranscriptionState): PageLayout {
  return state.status === 'idle' ? 'idle' : state.status;
}

/**
 * Composes the complete browser workflow from the focused client modules.
 * All user-visible styling is Tailwind utility classes; this class owns only
 * state orchestration, layout visibility, and lifecycle cleanup.
 */
export class TranscriptionPage implements TranscriptionPageInstance {
  public readonly root: HTMLElement;
  public readonly elements: TranscriptionPageElements;
  public readonly uploadZone: UploadZone;
  public readonly languageControl: LanguagePreferenceControlInstance;
  public readonly statusRegion: JobStatusRegionInstance;
  public readonly viewer: TranscriptViewer;
  public readonly exporter: TranscriptExporter;

  private readonly api: TranscriptionApi;
  private readonly polling: StatusPollingController;
  private readonly ownsPolling: boolean;
  private currentState: ClientTranscriptionState;
  private submitting = false;
  private requestFailureMessage: string | null = null;
  private downloadFailureMessage: string | null = null;
  private destroyed = false;

  public constructor(document: Document, options: TranscriptionPageOptions = {}) {
    this.currentState = createInitialClientState();
    this.api = options.api ?? createSameOriginTranscriptionApi();
    this.polling = options.polling ?? createStatusPollingController(
      this.api,
      options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs },
    );
    this.ownsPolling = options.polling === undefined;

    const built = this.buildLayout(document);
    this.root = built.root;
    this.elements = built.elements;

    this.uploadZone = createUploadZone(document, {
      id: 'audio-file-input',
      onStateChange: (selection) => {
        this.currentState = {
          ...this.currentState,
          selectedFile: selection.selectedFile,
        };
        this.requestFailureMessage = null;
        this.render();
      },
    });
    this.elements.uploadZoneMount.replaceChildren(this.uploadZone.root);

    this.languageControl = createLanguagePreferenceControl(document, {
      id: 'language-preference',
      onChange: (settings) => {
        if (!areSettingsLocked(this.currentState)) {
          this.currentState = { ...this.currentState, selectedSettings: settings };
          this.render();
        }
      },
    });
    this.elements.languageMount.replaceChildren(this.languageControl.root);

    this.statusRegion = createJobStatusRegion(document, {
      onStartNew: () => this.startNewTranscription(),
    });
    this.viewer = new TranscriptViewer(this.elements.transcriptViewerMount);
    this.exporter = options.exporter ?? createTranscriptExporter(document, {
      onFailure: (message) => {
        this.downloadFailureMessage = message;
        this.render();
      },
    });

    this.elements.startButton.addEventListener('click', () => {
      void this.startTranscription();
    });
    this.elements.downloadButton.addEventListener('click', () => {
      this.downloadTranscript();
    });
    this.elements.completedStartNewButton.addEventListener('click', () => {
      this.startNewTranscription();
    });

    this.render();
  }

  public get state(): ClientTranscriptionState {
    return this.currentState;
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.polling.stop();
    if (this.ownsPolling) {
      this.polling.destroy();
    }
    this.uploadZone.controller.destroy();
    this.languageControl.control.destroy();
    this.statusRegion.region.destroy();
  }

  private buildLayout(document: Document): {
    readonly root: HTMLElement;
    readonly elements: TranscriptionPageElements;
  } {
    const root = createElement(
      document,
      'main',
      'min-h-screen min-w-0 overflow-x-clip bg-surface px-margin-sm py-margin-md text-on-surface sm:px-margin-md md:py-margin-lg lg:px-margin-lg',
    );
    root.setAttribute('data-transcription-page', 'true');

    const grid = createElement(
      document,
      'div',
      'mx-auto grid min-h-[calc(100vh-8rem)] w-full min-w-0 max-w-container grid-cols-1 items-start gap-gutter md:grid-cols-12 md:items-center',
    );
    const shell = createElement(
      document,
      'section',
      'col-span-1 mx-auto min-w-0 w-full max-w-focus overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-margin-md md:col-span-8 md:col-start-3',
    );
    const header = createElement(
      document,
      'header',
      'mb-margin-md border-b border-outline-variant pb-margin-sm',
    );
    const eyebrow = createElement(document, 'p', 'mb-2 font-geist text-label-md uppercase text-on-surface-variant');
    eyebrow.textContent = 'Audio transcription';
    const title = createElement(
      document,
      'h1',
      'font-geist text-headline-lg-mobile text-on-surface sm:text-headline-lg',
    );
    title.textContent = 'Transcribe with precision.';
    const intro = createElement(document, 'p', 'mt-2 max-w-prose font-inter text-body-sm text-on-surface-variant');
    intro.textContent = 'Upload one audio file to create a clear, reviewable transcript.';
    header.append(eyebrow, title, intro);

    const idleLayout = createLayout(document, 'idle');
    idleLayout.append(createLayoutHeading(document, 'Upload an audio file'));
    const uploadZoneMount = createElement(document, 'div', 'min-w-0');
    const settingsGroup = createElement(document, 'div', 'grid min-w-0 gap-margin-sm rounded-lg border border-outline-variant bg-surface-container-low p-margin-md');
    const languageMount = createElement(document, 'div', 'min-w-0');
    const startButton = createActionButton(
      document,
      'Start transcription',
      'w-full min-w-0 rounded-lg bg-secondary px-5 py-3 font-geist text-label-md text-on-secondary outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50',
    );
    const requestFailure = createElement(document, 'p', 'break-words font-inter text-body-sm text-error');
    requestFailure.setAttribute('role', 'alert');
    requestFailure.setAttribute('aria-live', 'assertive');
    requestFailure.hidden = true;
    settingsGroup.append(languageMount, startButton, requestFailure);
    idleLayout.append(uploadZoneMount, settingsGroup);

    const queuedLayout = createLayout(document, 'queued');
    queuedLayout.append(createLayoutHeading(document, 'Transcription queued'));
    const queuedStatusMount = createElement(document, 'div', 'min-w-0');
    queuedLayout.append(queuedStatusMount);

    const processingLayout = createLayout(document, 'processing');
    processingLayout.append(createLayoutHeading(document, 'Transcription in progress'));
    const processingStatusMount = createElement(document, 'div', 'min-w-0');
    processingLayout.append(processingStatusMount);

    const failedLayout = createLayout(document, 'failed');
    failedLayout.append(createLayoutHeading(document, 'Transcription needs attention'));
    const failedStatusMount = createElement(document, 'div', 'min-w-0');
    failedLayout.append(failedStatusMount);

    const completedLayout = createLayout(document, 'completed');
    completedLayout.append(createLayoutHeading(document, 'Transcript complete'));
    const completedStatusMount = createElement(document, 'div', 'min-w-0');
    const transcriptPanel = createElement(document, 'section', 'min-w-0 rounded-lg border border-outline-variant bg-surface-container-lowest p-margin-md');
    const transcriptLabel = createElement(document, 'h3', 'mb-margin-sm font-geist text-label-md uppercase text-on-surface-variant');
    transcriptLabel.textContent = 'Transcript';
    const transcriptViewerMount = createElement(document, 'div', 'min-h-[12rem] w-full min-w-0 max-w-full overflow-hidden rounded-md border border-outline-variant bg-surface-container-low p-margin-sm');
    transcriptViewerMount.id = 'transcript-viewer';
    transcriptPanel.append(transcriptLabel, transcriptViewerMount);
    const downloadButton = createActionButton(
      document,
      'Download transcript',
      'w-full min-w-0 rounded-lg bg-primary px-5 py-3 font-geist text-label-md text-on-primary outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50',
    );
    const downloadFailure = createElement(document, 'p', 'break-words font-inter text-body-sm text-error');
    downloadFailure.setAttribute('role', 'alert');
    downloadFailure.setAttribute('aria-live', 'assertive');
    downloadFailure.hidden = true;
    const completedStartNewButton = createActionButton(
      document,
      'Start new transcription',
      'w-full min-w-0 rounded-lg border border-outline-variant bg-surface-container-low px-5 py-3 font-geist text-label-md text-on-surface outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    completedLayout.append(
      completedStatusMount,
      transcriptPanel,
      downloadButton,
      downloadFailure,
      completedStartNewButton,
    );

    shell.append(header, idleLayout, queuedLayout, processingLayout, failedLayout, completedLayout);
    grid.append(shell);
    root.append(grid);

    const elements: TranscriptionPageElements = {
      root,
      idleLayout,
      queuedLayout,
      processingLayout,
      failedLayout,
      completedLayout,
      uploadZoneMount,
      languageMount,
      startButton,
      requestFailure,
      queuedStatusMount,
      processingStatusMount,
      failedStatusMount,
      completedStatusMount,
      transcriptViewerMount,
      downloadButton,
      downloadFailure,
      completedStartNewButton,
    };

    return { root, elements };
  }

  private async startTranscription(): Promise<void> {
    const file = this.currentState.selectedFile;
    if (file === null || this.submitting || this.destroyed) {
      return;
    }

    this.submitting = true;
    this.requestFailureMessage = null;
    this.render();

    try {
      const initialUpdate = await this.api.create(file, this.currentState.selectedSettings);
      if (this.destroyed) {
        return;
      }

      this.submitting = false;
      this.currentState = startClientJob(
        { ...this.currentState, selectedFile: file },
        initialUpdate,
      );
      this.render();

      if (this.currentState.status === 'queued' || this.currentState.status === 'processing') {
        this.polling.start(this.currentState.activeJobId as string, {
          onUpdate: (update) => this.handleStatusUpdate(update),
          onError: (error) => this.handlePollingError(error),
        });
      }
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      this.submitting = false;
      this.requestFailureMessage = publicErrorMessage(error, PAGE_FAILURE_MESSAGE);
      this.render();
    }
  }

  private handleStatusUpdate(update: StatusUpdate): void {
    if (this.destroyed) {
      return;
    }

    this.currentState = reduceClientStatus(this.currentState, update);
    this.render();
    if (update.status === 'completed' || update.status === 'failed') {
      this.polling.stop();
    }
  }

  private handlePollingError(error: unknown): void {
    if (this.destroyed || this.currentState.activeJobId === null) {
      return;
    }

    const failureMessage = publicErrorMessage(error, POLLING_FAILURE_MESSAGE);
    this.currentState = reduceClientStatus(this.currentState, {
      jobId: this.currentState.activeJobId,
      status: 'failed',
      failureMessage,
    });
    this.render();
  }

  private downloadTranscript(): void {
    if (this.destroyed || !canDownloadTranscript(this.currentState)) {
      return;
    }

    this.downloadFailureMessage = null;
    this.exporter.download(this.currentState);
    this.render();
  }

  private startNewTranscription(): void {
    if (this.destroyed) {
      return;
    }

    this.polling.stop();
    this.currentState = createInitialClientState(this.currentState.selectedSettings);
    this.submitting = false;
    this.requestFailureMessage = null;
    this.downloadFailureMessage = null;
    this.uploadZone.controller.clear();
    this.languageControl.control.setValue(this.currentState.selectedSettings);
    this.render();
  }

  private render(): void {
    const layout = layoutForState(this.currentState);
    const layouts: Readonly<Record<PageLayout, HTMLElement>> = {
      idle: this.elements.idleLayout,
      queued: this.elements.queuedLayout,
      processing: this.elements.processingLayout,
      failed: this.elements.failedLayout,
      completed: this.elements.completedLayout,
    };

    for (const [name, element] of Object.entries(layouts)) {
      element.hidden = name !== layout;
    }
    this.elements.root.setAttribute('data-state', this.currentState.status);

    const statusMount = layout === 'queued'
      ? this.elements.queuedStatusMount
      : layout === 'processing'
        ? this.elements.processingStatusMount
        : layout === 'failed'
          ? this.elements.failedStatusMount
          : this.elements.completedStatusMount;
    if (layout !== 'idle') {
      statusMount.append(this.statusRegion.root);
    }
    this.statusRegion.region.render(this.currentState);
    this.viewer.render(this.currentState);

    const locked = areSettingsLocked(this.currentState);
    this.languageControl.control.setDisabled(locked);
    this.elements.startButton.disabled = this.currentState.selectedFile === null || this.submitting;
    this.elements.startButton.setAttribute('aria-busy', this.submitting ? 'true' : 'false');

    this.elements.requestFailure.textContent = this.requestFailureMessage ?? '';
    this.elements.requestFailure.hidden = this.requestFailureMessage === null;

    const canDownload = canDownloadTranscript(this.currentState);
    this.elements.downloadButton.disabled = !canDownload;
    this.elements.downloadButton.hidden = !canDownload;
    this.elements.downloadFailure.textContent = this.downloadFailureMessage ?? '';
    this.elements.downloadFailure.hidden = this.downloadFailureMessage === null;
    this.elements.completedStartNewButton.hidden = layout !== 'completed';
  }
}

export function createTranscriptionPage(
  document: Document,
  options: TranscriptionPageOptions = {},
): TranscriptionPage {
  return new TranscriptionPage(document, options);
}
