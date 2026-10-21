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
  createVoiceEnrollmentControl,
  type VoiceEnrollmentInstance,
} from './voice-enrollment';
import {
  createSameOriginTranscriptionApi,
  TranscriptionApiError,
  type TranscriptionApi,
} from './transcription-api';
import {
  createStatusPollingController,
  type StatusPollingController,
} from './polling-controller';
import {
  AUTOMATIC_LANGUAGE_DETECTION,
  formatDiarizedTranscript,
  serializeTranscriptionSettings,
  type StatusUpdate,
  type TranscriptionSettings,
} from '../shared/transcription';

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
  readonly languageHintsInput: HTMLInputElement;
  readonly diarizationCheckbox: HTMLInputElement;
  readonly voiceEnrollmentMount: HTMLElement;
  readonly contextTermsInput: HTMLInputElement;
  readonly contextTextInput: HTMLTextAreaElement;
  readonly startButton: HTMLButtonElement;
  readonly requestFailure: HTMLElement;
  readonly queuedStatusMount: HTMLElement;
  readonly processingStatusMount: HTMLElement;
  readonly failedStatusMount: HTMLElement;
  readonly completedStatusMount: HTMLElement;
  readonly transcriptViewerMount: HTMLElement;
  readonly confidenceBadge: HTMLElement;
  readonly lowConfidenceReview: HTMLElement;
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
  readonly voiceEnrollment: VoiceEnrollmentInstance;
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

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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
  public readonly voiceEnrollment: VoiceEnrollmentInstance;
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
  private audioElement: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private isPlaying = false;
  private playerPlayBtn: HTMLButtonElement | null = null;
  private playerPlayTime: HTMLElement | null = null;
  private playerFileBadge: HTMLElement | null = null;
  private playerTrackFill: HTMLElement | null = null;
  private playerSpeedButtons: HTMLButtonElement[] = [];
  private playerErrorBanner: HTMLElement | null = null;
  private playerErrorText: HTMLElement | null = null;
  private timestampButton: HTMLButtonElement | null = null;
  private showTimestamps = false;
  private selectedProvider: 'soniox' | 'groq' = 'soniox';
  private visualizerEngine: HTMLElement | null = null;

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
      onChange: () => {
        if (!areSettingsLocked(this.currentState)) {
          this.currentState = { ...this.currentState, selectedSettings: this.getCombinedSettings() };
          this.render();
        }
      },
    });
    this.elements.languageMount.replaceChildren(this.languageControl.root);

    this.voiceEnrollment = createVoiceEnrollmentControl(document, {
      api: this.api,
    });
    this.elements.voiceEnrollmentMount.replaceChildren(this.voiceEnrollment.root);

    const onSettingsUpdate = (): void => {
      if (!areSettingsLocked(this.currentState)) {
        this.currentState = {
          ...this.currentState,
          selectedSettings: this.getCombinedSettings(),
        };
        this.render();
      }
    };
    this.elements.languageHintsInput.addEventListener('input', onSettingsUpdate);
    this.elements.diarizationCheckbox.addEventListener('change', onSettingsUpdate);
    this.elements.contextTermsInput.addEventListener('input', onSettingsUpdate);
    this.elements.contextTextInput.addEventListener('input', onSettingsUpdate);

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
    this.cleanupAudio();
    this.polling.stop();
    if (this.ownsPolling) {
      this.polling.destroy();
    }
    this.uploadZone.controller.destroy();
    this.languageControl.control.destroy();
    this.voiceEnrollment.control.destroy();
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
      'mx-auto grid min-h-[calc(100vh-8rem)] w-full min-w-0 max-w-container grid-cols-1 items-start gap-gutter md:grid-cols-12 md:items-start',
    );
    const shell = createElement(
      document,
      'section',
      'col-span-1 mx-auto min-w-0 w-full max-w-container overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-4 sm:p-6 lg:p-8 md:col-span-12 shadow-sm',
    );
    const header = createElement(
      document,
      'header',
      'mb-6 border-b border-outline-variant pb-5',
    );

    const topBar = createElement(
      document,
      'div',
      'mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant/60 pb-3',
    );
    const brandGroup = createElement(document, 'div', 'flex items-center gap-2.5');
    const brandIcon = createElement(
      document,
      'span',
      'flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-xs text-on-secondary font-bold shadow-sm',
    );
    brandIcon.textContent = '🎙️';
    const brandText = createElement(
      document,
      'span',
      'font-geist text-sm font-bold text-on-surface',
    );
    brandText.textContent = 'Audio Transcriber';
    const statusBadge = createElement(
      document,
      'span',
      'inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-geist text-xs font-semibold text-emerald-800',
    );
    const statusDot = createElement(document, 'span', 'inline-block h-2 w-2 rounded-full bg-emerald-500');
    const statusText = createElement(document, 'span');
    statusText.textContent = 'Offline Speaker ID Enabled (CAM++)';
    statusBadge.append(statusDot, statusText);
    brandGroup.append(brandIcon, brandText, statusBadge);

    const sessionMeta = createElement(
      document,
      'div',
      'hidden sm:flex items-center gap-2 font-geist text-xs text-on-surface-variant',
    );
    sessionMeta.textContent = 'Workbench • Session Ready';
    topBar.append(brandGroup, sessionMeta);

    const title = createElement(
      document,
      'h1',
      'font-geist text-headline-lg-mobile font-bold tracking-tight text-on-surface sm:text-headline-lg',
    );
    title.textContent = 'Acoustic Transcription & Speaker Diarization Studio';
    const intro = createElement(
      document,
      'p',
      'mt-1.5 max-w-3xl font-inter text-body-sm text-on-surface-variant',
    );
    intro.textContent = 'High-precision speech-to-text with offline CAM++ speaker identification and voice profiling.';
    header.append(topBar, title, intro);

    const idleLayout = createLayout(document, 'idle');
    const workbenchGrid = createElement(
      document,
      'div',
      'grid grid-cols-1 gap-6 lg:grid-cols-12 min-w-0 items-start',
    );
    const leftColumn = createElement(document, 'div', 'lg:col-span-7 min-w-0 space-y-5');
    const rightColumn = createElement(document, 'div', 'lg:col-span-5 min-w-0 space-y-5');

    // Left Column Card 0: Engine Selection
    const providerCard = createElement(
      document,
      'section',
      'rounded-lg border border-outline-variant bg-surface-container-lowest p-4 space-y-3 min-w-0 shadow-sm',
    );
    const providerHeader = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant pb-2',
    );
    const providerTitle = createElement(
      document,
      'h3',
      'font-geist text-xs font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5',
    );
    providerTitle.textContent = '⚡ Speech-to-Text Engine';
    const providerBadge = createElement(
      document,
      'span',
      'font-geist text-[11px] font-semibold text-secondary',
    );
    providerBadge.textContent = 'Soniox Active';
    providerHeader.append(providerTitle, providerBadge);

    const providerGrid = createElement(document, 'div', 'grid grid-cols-2 gap-2.5');

    const sonioxBtn = createElement(
      document,
      'button',
      'rounded-lg border border-secondary bg-secondary/10 p-2.5 text-left font-geist transition shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    sonioxBtn.type = 'button';
    const sonioxBtnTitle = createElement(document, 'div', 'text-xs font-bold text-secondary flex items-center gap-1.5');
    sonioxBtnTitle.textContent = '🎙️ Soniox ASR';
    const sonioxBtnDesc = createElement(document, 'div', 'text-[10px] text-on-surface-variant mt-0.5');
    sonioxBtnDesc.textContent = 'Async • Max 2GB • Multi-Hints';
    sonioxBtn.append(sonioxBtnTitle, sonioxBtnDesc);

    const groqBtn = createElement(
      document,
      'button',
      'rounded-lg border border-outline-variant bg-surface p-2.5 text-left font-geist transition hover:bg-surface-container shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    groqBtn.type = 'button';
    const groqBtnTitle = createElement(document, 'div', 'text-xs font-bold text-on-surface flex items-center gap-1.5');
    groqBtnTitle.textContent = '⚡ Groq Whisper';
    const groqBtnDesc = createElement(document, 'div', 'text-[10px] text-on-surface-variant mt-0.5');
    groqBtnDesc.textContent = 'LPU Fast • Max 25MB • Sherpa Diarization';
    groqBtn.append(groqBtnTitle, groqBtnDesc);

    providerGrid.append(sonioxBtn, groqBtn);
    providerCard.append(providerHeader, providerGrid);

    // Left Column Card 1: Audio Source Input
    const audioCard = createElement(
      document,
      'section',
      'rounded-lg border border-outline-variant bg-surface-container-lowest p-5 space-y-3 min-w-0 shadow-sm',
    );
    const audioCardHeader = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant pb-2.5',
    );
    const audioCardTitle = createElement(
      document,
      'h3',
      'font-geist text-sm font-semibold text-on-surface flex items-center gap-2',
    );
    audioCardTitle.textContent = '📁 Audio Source Input';
    const audioFormatsBadge = createElement(
      document,
      'span',
      'font-geist text-[11px] font-medium text-on-surface-variant',
    );
    audioFormatsBadge.textContent = 'WAV, MP3, M4A, FLAC (Max 2GB)';
    audioCardHeader.append(audioCardTitle, audioFormatsBadge);

    const uploadZoneMount = createElement(document, 'div', 'min-w-0');
    audioCard.append(audioCardHeader, uploadZoneMount);

    // Left Column Card 2: Language & Acoustic Recognition
    const settingsCard = createElement(
      document,
      'section',
      'rounded-lg border border-outline-variant bg-surface-container-lowest p-5 space-y-4 min-w-0 shadow-sm',
    );
    const settingsCardHeader = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant pb-2.5',
    );
    const settingsCardTitle = createElement(
      document,
      'h3',
      'font-geist text-sm font-semibold text-on-surface flex items-center gap-2',
    );
    settingsCardTitle.textContent = '🌐 Language & Acoustic Recognition';
    const settingsCardBadge = createElement(
      document,
      'span',
      'font-geist text-[11px] font-medium text-secondary',
    );
    settingsCardBadge.textContent = 'Multi-language supported';
    settingsCardHeader.append(settingsCardTitle, settingsCardBadge);

    const languageMount = createElement(document, 'div', 'min-w-0');

    const languageHintsContainer = createElement(document, 'div', 'min-w-0');
    const languageHintsLabel = createElement(
      document,
      'label',
      'mb-1.5 block font-geist text-xs font-semibold uppercase tracking-wider text-on-surface-variant',
    );
    languageHintsLabel.htmlFor = 'language-hints';
    languageHintsLabel.textContent = 'Additional Language Hints (optional)';
    const languageHintsInput = createElement(
      document,
      'input',
      'w-full rounded-lg border border-outline-variant bg-surface px-3.5 py-2 font-inter text-body-sm text-on-surface outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    languageHintsInput.id = 'language-hints';
    languageHintsInput.type = 'text';
    languageHintsInput.placeholder = 'e.g., en, tl, es';
    const languageHintsHelp = createElement(
      document,
      'p',
      'mt-1 font-inter text-xs text-on-surface-variant',
    );
    languageHintsHelp.textContent = 'Comma-separated language codes to optimize multi-language detection.';
    languageHintsContainer.append(languageHintsLabel, languageHintsInput, languageHintsHelp);

    const diarizationContainer = createElement(
      document,
      'div',
      'flex items-start gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3.5 transition hover:bg-surface-container',
    );
    const diarizationCheckbox = createElement(
      document,
      'input',
      'mt-0.5 h-4 w-4 rounded border-outline-variant text-secondary outline-focus',
    );
    diarizationCheckbox.id = 'diarization-toggle';
    diarizationCheckbox.type = 'checkbox';
    const diarizationLabelGroup = createElement(document, 'div', 'min-w-0');
    const diarizationLabel = createElement(
      document,
      'label',
      'block cursor-pointer font-geist text-body-sm font-semibold text-on-surface',
    );
    diarizationLabel.htmlFor = 'diarization-toggle';
    diarizationLabel.textContent = 'Enable speaker diarization';
    const diarizationHelp = createElement(
      document,
      'p',
      'font-inter text-xs text-on-surface-variant',
    );
    diarizationHelp.textContent = 'Separate and label speech by distinct speakers using CAM++ offline voice biometric embeddings.';
    diarizationLabelGroup.append(diarizationLabel, diarizationHelp);
    diarizationContainer.append(diarizationCheckbox, diarizationLabelGroup);

    settingsCard.append(settingsCardHeader, languageMount, languageHintsContainer, diarizationContainer);

    // Left Column Card 3: Domain Vocabulary & Context
    const contextContainer = createElement(
      document,
      'section',
      'min-w-0 space-y-3 rounded-lg border border-outline-variant bg-surface-container-lowest p-5 shadow-sm',
    );
    const contextHeader = createElement(
      document,
      'div',
      'flex items-center justify-between border-b border-outline-variant pb-2.5',
    );
    const contextHeading = createElement(
      document,
      'h3',
      'font-geist text-sm font-semibold text-on-surface',
    );
    contextHeading.textContent = '📝 Domain Vocabulary & Context Framing (optional)';
    contextHeader.append(contextHeading);

    const contextTermsContainer = createElement(document, 'div', 'min-w-0');
    const contextTermsLabel = createElement(
      document,
      'label',
      'mb-1.5 block font-geist text-xs font-semibold uppercase tracking-wider text-on-surface-variant',
    );
    contextTermsLabel.htmlFor = 'context-terms';
    contextTermsLabel.textContent = 'Key Terms / Vocabulary';
    const contextTermsInput = createElement(
      document,
      'input',
      'w-full rounded-lg border border-outline-variant bg-surface px-3.5 py-2 font-inter text-body-sm text-on-surface outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    contextTermsInput.id = 'context-terms';
    contextTermsInput.type = 'text';
    contextTermsInput.placeholder = 'e.g., transcribe, React, cardiology terms';
    contextTermsContainer.append(contextTermsLabel, contextTermsInput);

    const contextTextContainer = createElement(document, 'div', 'min-w-0');
    const contextTextLabel = createElement(
      document,
      'label',
      'mb-1.5 block font-geist text-xs font-semibold uppercase tracking-wider text-on-surface-variant',
    );
    contextTextLabel.htmlFor = 'context-text';
    contextTextLabel.textContent = 'Background / Topic Notes';
    const contextTextInput = createElement(
      document,
      'textarea',
      'w-full resize-y rounded-lg border border-outline-variant bg-surface px-3.5 py-2 font-inter text-body-sm text-on-surface outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    contextTextInput.id = 'context-text';
    contextTextInput.rows = 2;
    contextTextInput.placeholder = 'Optional background context, topic summary, or conversation notes...';
    contextTextContainer.append(contextTextLabel, contextTextInput);

    contextContainer.append(contextHeader, contextTermsContainer, contextTextContainer);

    const startButton = createActionButton(
      document,
      'Start transcription',
      'w-full min-w-0 rounded-lg bg-secondary px-6 py-3.5 font-geist text-label-md text-on-secondary shadow-md hover:bg-secondary/90 transition outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50',
    );
    const requestFailure = createElement(
      document,
      'p',
      'break-words font-inter text-body-sm text-error',
    );
    requestFailure.setAttribute('role', 'alert');
    requestFailure.setAttribute('aria-live', 'assertive');
    requestFailure.hidden = true;

    sonioxBtn.addEventListener('click', () => {
      this.selectedProvider = 'soniox';
      sonioxBtn.className = 'rounded-lg border border-secondary bg-secondary/10 p-2.5 text-left font-geist transition shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary';
      sonioxBtnTitle.className = 'text-xs font-bold text-secondary flex items-center gap-1.5';
      groqBtn.className = 'rounded-lg border border-outline-variant bg-surface p-2.5 text-left font-geist transition hover:bg-surface-container shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary';
      groqBtnTitle.className = 'text-xs font-bold text-on-surface flex items-center gap-1.5';
      providerBadge.textContent = 'Soniox Active';
      if (this.visualizerEngine) this.visualizerEngine.textContent = 'Soniox Engine • CAM++ Active';
      audioFormatsBadge.textContent = 'WAV, MP3, M4A, FLAC (Max 2GB)';
      diarizationHelp.textContent = 'Separate and label speech by distinct speakers using CAM++ offline voice biometric embeddings.';
    });

    groqBtn.addEventListener('click', () => {
      this.selectedProvider = 'groq';
      groqBtn.className = 'rounded-lg border border-secondary bg-secondary/10 p-2.5 text-left font-geist transition shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary';
      groqBtnTitle.className = 'text-xs font-bold text-secondary flex items-center gap-1.5';
      sonioxBtn.className = 'rounded-lg border border-outline-variant bg-surface p-2.5 text-left font-geist transition hover:bg-surface-container shadow-xs focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary';
      sonioxBtnTitle.className = 'text-xs font-bold text-on-surface flex items-center gap-1.5';
      providerBadge.textContent = 'Groq Whisper Active';
      if (this.visualizerEngine) this.visualizerEngine.textContent = 'Groq Whisper • Sherpa Diarization';
      audioFormatsBadge.textContent = 'WAV, MP3, M4A, FLAC (Max 25MB)';
      diarizationHelp.textContent = 'Offline speaker diarization via Sherpa-ONNX + CAM++ voice biometrics.';
    });

    leftColumn.append(
      providerCard,
      audioCard,
      settingsCard,
      contextContainer,
      startButton,
      requestFailure,
    );

    // Right Column: Voice Enrollment Studio
    const voiceEnrollmentMount = createElement(document, 'div', 'min-w-0');
    rightColumn.append(voiceEnrollmentMount);

    workbenchGrid.append(leftColumn, rightColumn);
    idleLayout.append(workbenchGrid);

    // QUEUED LAYOUT
    const queuedLayout = createLayout(document, 'queued');
    queuedLayout.append(createLayoutHeading(document, 'Transcription queued'));

    const queuedCard = createElement(
      document,
      'section',
      'rounded-xl border border-outline-variant bg-surface-container-lowest p-6 space-y-6 shadow-sm min-w-0',
    );

    // Top status ribbon with telemetry
    const queuedHeaderRow = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant pb-4',
    );
    const queuedTitleGroup = createElement(document, 'div', 'flex items-center gap-2.5');
    const queuedIcon = createElement(
      document,
      'span',
      'flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/10 text-secondary text-base font-bold',
    );
    queuedIcon.textContent = '⏳';
    const queuedTextGroup = createElement(document, 'div');
    const queuedMainText = createElement(document, 'p', 'font-geist text-sm font-bold text-on-surface');
    queuedMainText.textContent = 'Job Positioned in Execution Queue';
    const queuedSubText = createElement(document, 'p', 'font-inter text-xs text-on-surface-variant');
    queuedSubText.textContent = 'Preparing CAM++ neural models and allocating acoustic recognition worker...';
    queuedTextGroup.append(queuedMainText, queuedSubText);
    queuedTitleGroup.append(queuedIcon, queuedTextGroup);

    const queuedStatusMount = createElement(document, 'div', 'min-w-0');
    queuedHeaderRow.append(queuedTitleGroup, queuedStatusMount);

    // Pipeline Stepper
    const queuedStepper = createElement(document, 'div', 'grid grid-cols-1 sm:grid-cols-4 gap-3');
    const stepsData = [
      { num: '1', title: 'File Validation', status: 'Ready', desc: 'Audio headers checked', active: true, done: true },
      { num: '2', title: 'CAM++ Diarization', status: 'Queued', desc: '192-d voice clustering', active: true, done: false },
      { num: '3', title: 'Acoustic ASR', status: 'Queued', desc: 'Neural speech recognition', active: false, done: false },
      { num: '4', title: 'Profile Relabeling', status: 'Pending', desc: 'Match enrolled speakers', active: false, done: false },
    ];
    for (const s of stepsData) {
      const stepBox = createElement(
        document,
        'div',
        `rounded-lg border ${s.done ? 'border-emerald-200 bg-emerald-50/50' : s.active ? 'border-secondary/30 bg-surface' : 'border-outline-variant/60 bg-surface-container-low/50'} p-3 space-y-1`,
      );
      const stepTop = createElement(document, 'div', 'flex items-center justify-between');
      const stepBadge = createElement(
        document,
        'span',
        `inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${s.done ? 'bg-emerald-600 text-white' : s.active ? 'bg-secondary text-white' : 'bg-surface-container-high text-on-surface-variant'}`,
      );
      stepBadge.textContent = s.done ? '✓' : s.num;
      const stepStatus = createElement(
        document,
        'span',
        `text-[10px] font-bold uppercase tracking-wider ${s.done ? 'text-emerald-700' : s.active ? 'text-secondary' : 'text-on-surface-variant'}`,
      );
      stepStatus.textContent = s.status;
      stepTop.append(stepBadge, stepStatus);
      const stepTitle = createElement(document, 'p', 'font-geist text-xs font-semibold text-on-surface');
      stepTitle.textContent = s.title;
      const stepDesc = createElement(document, 'p', 'font-inter text-[11px] text-on-surface-variant');
      stepDesc.textContent = s.desc;
      stepBox.append(stepTop, stepTitle, stepDesc);
      queuedStepper.append(stepBox);
    }

    // Animated Shimmer Progress Bar
    const queuedProgressBarContainer = createElement(document, 'div', 'space-y-2');
    const queuedProgressLabelRow = createElement(document, 'div', 'flex items-center justify-between text-xs font-geist text-on-surface-variant');
    const queuedProgressLabel = createElement(document, 'span', 'font-medium');
    queuedProgressLabel.textContent = 'Queue Status';
    const queuedProgressEta = createElement(document, 'span', 'font-semibold text-secondary');
    queuedProgressEta.textContent = 'Initiating transcription engine...';
    queuedProgressLabelRow.append(queuedProgressLabel, queuedProgressEta);

    const queuedProgressBarTrack = createElement(document, 'div', 'h-2 w-full overflow-hidden rounded-full bg-surface-container-high');
    const queuedProgressBarFill = createElement(document, 'div', 'h-full w-full rounded-full animate-shimmer-bar');
    queuedProgressBarTrack.append(queuedProgressBarFill);
    queuedProgressBarContainer.append(queuedProgressLabelRow, queuedProgressBarTrack);

    queuedCard.append(queuedHeaderRow, queuedStepper, queuedProgressBarContainer);
    queuedLayout.append(queuedCard);

    // PROCESSING LAYOUT
    const processingLayout = createLayout(document, 'processing');
    processingLayout.append(createLayoutHeading(document, 'Transcription in progress'));

    const processingCard = createElement(
      document,
      'section',
      'rounded-xl border border-outline-variant bg-surface-container-lowest p-6 space-y-6 shadow-sm min-w-0',
    );

    // Header Row with live telemetry
    const processingHeaderRow = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant pb-4',
    );
    const processingTitleGroup = createElement(document, 'div', 'flex items-center gap-2.5');
    const processingIcon = createElement(
      document,
      'span',
      'flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-on-secondary text-base font-bold shadow-sm',
    );
    processingIcon.textContent = '⚡';
    const processingTextGroup = createElement(document, 'div');
    const processingMainText = createElement(document, 'p', 'font-geist text-sm font-bold text-on-surface');
    processingMainText.textContent = 'Neural Audio Processing & Speaker Diarization Active';
    const processingSubText = createElement(document, 'p', 'font-inter text-xs text-on-surface-variant');
    processingSubText.textContent = 'Streaming acoustic phonemes and matching 192-dim CAM++ biometric voice embeddings...';
    processingTextGroup.append(processingMainText, processingSubText);
    processingTitleGroup.append(processingIcon, processingTextGroup);

    const processingStatusMount = createElement(document, 'div', 'min-w-0');
    processingHeaderRow.append(processingTitleGroup, processingStatusMount);

    // Processing Stepper
    const processingStepper = createElement(document, 'div', 'grid grid-cols-1 sm:grid-cols-4 gap-3');
    const procStepsData = [
      { num: '1', title: 'Ingestion & Decode', status: 'Completed', desc: 'PCM 16kHz mono stream', done: true, active: false },
      { num: '2', title: 'Neural Diarization', status: 'In Progress', desc: 'CAM++ speaker clusters', done: false, active: true },
      { num: '3', title: 'Acoustic ASR', status: 'Active', desc: 'Neural speech phonemes', done: false, active: true },
      { num: '4', title: 'Profile Relabeling', status: 'Next', desc: 'Biometric verification', done: false, active: false },
    ];
    for (const s of procStepsData) {
      const stepBox = createElement(
        document,
        'div',
        `rounded-lg border ${s.done ? 'border-emerald-200 bg-emerald-50/60' : s.active ? 'border-secondary bg-surface shadow-sm ring-1 ring-secondary/20' : 'border-outline-variant/60 bg-surface-container-low/40'} p-3 space-y-1`,
      );
      const stepTop = createElement(document, 'div', 'flex items-center justify-between');
      const stepBadge = createElement(
        document,
        'span',
        `inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${s.done ? 'bg-emerald-600 text-white' : s.active ? 'bg-secondary text-white animate-pulse' : 'bg-surface-container-high text-on-surface-variant'}`,
      );
      stepBadge.textContent = s.done ? '✓' : s.num;
      const stepStatus = createElement(
        document,
        'span',
        `text-[10px] font-bold uppercase tracking-wider ${s.done ? 'text-emerald-700' : s.active ? 'text-secondary' : 'text-on-surface-variant'}`,
      );
      stepStatus.textContent = s.status;
      stepTop.append(stepBadge, stepStatus);
      const stepTitle = createElement(document, 'p', 'font-geist text-xs font-semibold text-on-surface');
      stepTitle.textContent = s.title;
      const stepDesc = createElement(document, 'p', 'font-inter text-[11px] text-on-surface-variant');
      stepDesc.textContent = s.desc;
      stepBox.append(stepTop, stepTitle, stepDesc);
      processingStepper.append(stepBox);
    }

    // Animated Audio Spectrum Equalizer Visualizer
    const visualizerCard = createElement(
      document,
      'div',
      'rounded-lg border border-outline-variant bg-surface-container-low p-4 space-y-3',
    );
    const visualizerHeader = createElement(document, 'div', 'flex items-center justify-between text-xs font-geist');
    const visualizerLabel = createElement(document, 'span', 'font-semibold text-on-surface flex items-center gap-2');
    visualizerLabel.textContent = '📊 Live Acoustic Spectrum';
    const visualizerEngine = createElement(document, 'span', 'rounded bg-surface-container-high px-2 py-0.5 text-[11px] font-medium text-secondary');
    visualizerEngine.textContent = 'Soniox Engine • CAM++ Active';
    this.visualizerEngine = visualizerEngine;
    visualizerHeader.append(visualizerLabel, visualizerEngine);

    const visualizerBars = createElement(document, 'div', 'flex items-end justify-center gap-1.5 h-12 py-1');
    const barHeights = [14, 22, 34, 18, 28, 42, 30, 20, 36, 44, 26, 16, 32, 40, 24, 18, 38, 28, 14, 32, 22, 16, 26, 12];
    for (let i = 0; i < barHeights.length; i++) {
      const bar = createElement(
        document,
        'span',
        'w-1.5 rounded-full bg-secondary animate-equalizer-bar transition-all duration-300',
      );
      bar.style.height = `${barHeights[i]}px`;
      (bar.style as unknown as Record<string, string>)['animationDelay'] = `${(i * 0.08).toFixed(2)}s`;
      visualizerBars.append(bar);
    }

    // Glowing Progress Bar
    const procProgressBarTrack = createElement(document, 'div', 'h-2 w-full overflow-hidden rounded-full bg-surface-container-high');
    const procProgressBarFill = createElement(document, 'div', 'h-full w-full rounded-full animate-shimmer-bar');
    procProgressBarTrack.append(procProgressBarFill);

    const procTip = createElement(document, 'p', 'font-inter text-xs text-on-surface-variant text-center');
    procTip.textContent = '🔒 Offline speaker identification running securely. No voice biometrics leave your machine.';

    visualizerCard.append(visualizerHeader, visualizerBars, procProgressBarTrack, procTip);
    processingCard.append(processingHeaderRow, processingStepper, visualizerCard);
    processingLayout.append(processingCard);

    const failedLayout = createLayout(document, 'failed');
    failedLayout.append(createLayoutHeading(document, 'Transcription needs attention'));
    const failedStatusMount = createElement(document, 'div', 'min-w-0');
    failedLayout.append(failedStatusMount);

    // COMPLETED LAYOUT
    const completedLayout = createLayout(document, 'completed');
    completedLayout.append(createLayoutHeading(document, 'Transcript complete'));

    // Top Executive Summary Metrics Card
    const completedSummaryCard = createElement(
      document,
      'section',
      'rounded-xl border border-outline-variant bg-surface-container-lowest p-5 space-y-4 shadow-sm min-w-0',
    );

    const metricsGrid = createElement(document, 'div', 'grid grid-cols-1 sm:grid-cols-3 gap-4 border-b border-outline-variant pb-4');

    // Metric 1: Status
    const metric1 = createElement(document, 'div', 'space-y-1');
    const metric1Label = createElement(document, 'p', 'font-geist text-[11px] font-bold uppercase tracking-wider text-on-surface-variant');
    metric1Label.textContent = 'Transcription Status';
    const metric1Val = createElement(document, 'div', 'flex items-center gap-2');
    const metric1Badge = createElement(document, 'span', 'inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-geist text-xs font-bold text-emerald-800');
    metric1Badge.textContent = '✓ Ready & Finalized';
    metric1Val.append(metric1Badge);
    metric1.append(metric1Label, metric1Val);

    // Metric 2: Acoustic Accuracy & Confidence
    const metric2 = createElement(document, 'div', 'space-y-1');
    const metric2Label = createElement(document, 'p', 'font-geist text-[11px] font-bold uppercase tracking-wider text-on-surface-variant');
    metric2Label.textContent = 'Acoustic Reliability';
    const confidenceBadge = createElement(
      document,
      'span',
      'hidden rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 font-geist text-xs font-semibold text-on-surface',
    );
    confidenceBadge.id = 'confidence-badge';
    metric2.append(metric2Label, confidenceBadge);

    // Metric 3: Speaker Identification
    const metric3 = createElement(document, 'div', 'space-y-1');
    const metric3Label = createElement(document, 'p', 'font-geist text-[11px] font-bold uppercase tracking-wider text-on-surface-variant');
    metric3Label.textContent = 'Speaker Diarization';
    const metric3Val = createElement(document, 'div', 'flex items-center gap-1.5');
    const metric3Badge = createElement(document, 'span', 'inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 font-geist text-xs font-semibold text-blue-800');
    metric3Badge.textContent = '● CAM++ Biometric Matched';
    metric3Val.append(metric3Badge);
    metric3.append(metric3Label, metric3Val);

    metricsGrid.append(metric1, metric2, metric3);

    const completedStatusMount = createElement(document, 'div', 'min-w-0');
    completedSummaryCard.append(metricsGrid, completedStatusMount);

    // Interactive Audio Playback & Scrubber Bar
    const playerBar = createElement(
      document,
      'div',
      'rounded-lg border border-outline-variant bg-surface-container-low p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-inner',
    );
    const playerControls = createElement(document, 'div', 'flex items-center gap-3');
    const playBtn = createElement(
      document,
      'button',
      'flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-on-secondary text-xs shadow-sm hover:bg-secondary/90 transition focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    playBtn.type = 'button';
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play audio');
    const playTime = createElement(document, 'span', 'font-geist text-xs font-medium text-on-surface tabular-nums');
    playTime.textContent = '00:00 / --:--';
    const playerFileBadge = createElement(
      document,
      'span',
      'hidden sm:inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 font-geist text-xs font-medium text-on-surface-variant truncate max-w-[180px]',
    );
    playerFileBadge.textContent = 'Audio File';
    playerControls.append(playBtn, playTime, playerFileBadge);

    // Clickable Scrubber Track with progress fill
    const playerTrack = createElement(
      document,
      'div',
      'relative flex-1 min-w-[140px] h-3 bg-surface-container-high rounded-full overflow-hidden flex cursor-pointer group',
    );
    playerTrack.setAttribute('role', 'slider');
    playerTrack.setAttribute('aria-label', 'Audio timeline scrubber');

    const trackProgress = createElement(
      document,
      'div',
      'h-full bg-secondary transition-all duration-100 rounded-full pointer-events-none',
    );
    trackProgress.style.width = '0%';
    playerTrack.append(trackProgress);

    const speedChips = createElement(document, 'div', 'flex items-center gap-1 text-[11px] font-geist text-on-surface-variant');
    const speeds = [
      { label: '1.0x', val: 1.0 },
      { label: '1.25x', val: 1.25 },
      { label: '1.5x', val: 1.5 },
    ];
    const speedButtons: HTMLButtonElement[] = [];
    for (const sp of speeds) {
      const spBtn = createElement(
        document,
        'button',
        `rounded px-2 py-0.5 font-semibold transition ${sp.val === 1.0 ? 'bg-surface text-secondary shadow-xs border border-outline-variant' : 'hover:text-on-surface text-on-surface-variant'}`,
      );
      spBtn.type = 'button';
      spBtn.textContent = sp.label;
      spBtn.setAttribute('data-speed', String(sp.val));
      speedChips.append(spBtn);
      speedButtons.push(spBtn);
    }
    playerBar.append(playerControls, playerTrack, speedChips);

    this.playerPlayBtn = playBtn;
    this.playerPlayTime = playTime;
    this.playerFileBadge = playerFileBadge;
    this.playerTrackFill = trackProgress;
    this.playerSpeedButtons = speedButtons;

    const playerErrorBanner = createElement(
      document,
      'div',
      'hidden rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 font-inter text-xs text-amber-900 flex items-center justify-between gap-2 shadow-xs',
    );
    playerErrorBanner.id = 'player-error-banner';
    const playerErrorText = createElement(document, 'span', 'flex items-center gap-1.5');
    playerErrorText.textContent = '';
    const playerErrorDismiss = createElement(
      document,
      'button',
      'text-amber-800 hover:text-amber-950 font-bold px-1',
    );
    playerErrorDismiss.type = 'button';
    playerErrorDismiss.textContent = '✕';
    playerErrorDismiss.addEventListener('click', () => {
      playerErrorBanner.hidden = true;
    });
    playerErrorBanner.append(playerErrorText, playerErrorDismiss);
    this.playerErrorBanner = playerErrorBanner;
    this.playerErrorText = playerErrorText;

    playBtn.addEventListener('click', () => {
      this.togglePlayback();
    });

    playerTrack.addEventListener('click', (e: MouseEvent) => {
      this.seekPlayback(e, playerTrack);
    });

    for (const spBtn of speedButtons) {
      spBtn.addEventListener('click', () => {
        const rate = parseFloat(spBtn.getAttribute('data-speed') || '1.0');
        if (this.audioElement) {
          this.audioElement.playbackRate = rate;
        }
        for (const b of speedButtons) {
          if (b === spBtn) {
            b.className = 'rounded px-2 py-0.5 font-semibold bg-surface text-secondary shadow-xs border border-outline-variant';
          } else {
            b.className = 'rounded px-2 py-0.5 font-semibold hover:text-on-surface text-on-surface-variant';
          }
        }
      });
    }

    // Transcript Panel
    const transcriptPanel = createElement(
      document,
      'section',
      'min-w-0 rounded-xl border border-outline-variant bg-surface-container-lowest p-5 space-y-3 shadow-sm',
    );
    const transcriptHeader = createElement(
      document,
      'div',
      'flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant pb-2.5',
    );
    const transcriptLabel = createElement(
      document,
      'h3',
      'font-geist text-sm font-semibold uppercase tracking-wider text-on-surface flex items-center gap-2',
    );
    transcriptLabel.textContent = '📜 Diarized Transcript Feed';

    const transcriptActions = createElement(document, 'div', 'flex items-center gap-2');
    const timestampButton = createElement(
      document,
      'button',
      'rounded-md border border-outline-variant bg-surface px-2.5 py-1 font-geist text-xs font-medium text-on-surface hover:bg-surface-container transition shadow-xs flex items-center gap-1',
    );
    timestampButton.type = 'button';
    timestampButton.textContent = '⏱ Timestamps';
    timestampButton.title = 'Toggle timestamp ranges on transcript';
    timestampButton.addEventListener('click', () => {
      this.toggleTimestamps();
    });
    this.timestampButton = timestampButton;

    const copyButton = createElement(
      document,
      'button',
      'rounded-md border border-outline-variant bg-surface px-2.5 py-1 font-geist text-xs font-medium text-on-surface hover:bg-surface-container transition shadow-xs',
    );
    copyButton.type = 'button';
    copyButton.textContent = '📋 Copy';
    copyButton.addEventListener('click', () => {
      if (this.currentState.transcriptText && typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(this.currentState.transcriptText);
        copyButton.textContent = '✓ Copied!';
        setTimeout(() => {
          copyButton.textContent = '📋 Copy';
        }, 2000);
      }
    });
    transcriptActions.append(timestampButton, copyButton);
    transcriptHeader.append(transcriptLabel, transcriptActions);

    const transcriptViewerMount = createElement(
      document,
      'div',
      'min-h-[16rem] w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low p-5 font-inter text-body-sm leading-relaxed text-on-surface',
    );
    transcriptViewerMount.id = 'transcript-viewer';
    const lowConfidenceReview = createElement(
      document,
      'div',
      'hidden rounded-lg border border-amber-300 bg-amber-50 p-3.5 font-inter text-body-sm text-amber-900',
    );
    lowConfidenceReview.id = 'low-confidence-review';
    transcriptPanel.append(transcriptHeader, transcriptViewerMount, lowConfidenceReview);

    // Action buttons row
    const completedActionRow = createElement(
      document,
      'div',
      'grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1',
    );
    const downloadButton = createActionButton(
      document,
      'Download transcript',
      'w-full min-w-0 rounded-lg bg-primary px-6 py-3.5 font-geist text-label-md text-on-primary shadow-sm hover:bg-primary/90 transition outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50',
    );
    const downloadFailure = createElement(
      document,
      'p',
      'col-span-full break-words font-inter text-body-sm text-error',
    );
    downloadFailure.setAttribute('role', 'alert');
    downloadFailure.setAttribute('aria-live', 'assertive');
    downloadFailure.hidden = true;
    const completedStartNewButton = createActionButton(
      document,
      'Start new transcription',
      'w-full min-w-0 rounded-lg border border-outline-variant bg-surface px-6 py-3.5 font-geist text-label-md text-on-surface shadow-sm hover:bg-surface-container transition outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
    );
    completedActionRow.append(downloadButton, completedStartNewButton);

    completedLayout.append(
      completedSummaryCard,
      playerBar,
      playerErrorBanner,
      transcriptPanel,
      completedActionRow,
      downloadFailure,
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
      languageHintsInput,
      diarizationCheckbox,
      voiceEnrollmentMount,
      contextTermsInput,
      contextTextInput,
      startButton,
      requestFailure,
      queuedStatusMount,
      processingStatusMount,
      failedStatusMount,
      completedStatusMount,
      transcriptViewerMount,
      confidenceBadge,
      lowConfidenceReview,
      downloadButton,
      downloadFailure,
      completedStartNewButton,
    };

    return { root, elements };
  }

  private getCombinedSettings(): TranscriptionSettings {
    const langPref = this.languageControl.control.value;
    const hints = this.elements.languageHintsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const diarization = this.elements.diarizationCheckbox.checked;
    const terms = this.elements.contextTermsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const text = this.elements.contextTextInput.value.trim();

    if (this.selectedProvider === 'soniox' && !diarization && hints.length === 0 && terms.length === 0 && text.length === 0) {
      return langPref;
    }

    return serializeTranscriptionSettings({
      provider: this.selectedProvider,
      languagePreference: langPref,
      languageHints: hints,
      enableDiarization: diarization,
      contextTerms: terms.length > 0 ? terms : undefined,
      contextText: text.length > 0 ? text : undefined,
    });
  }

  private async startTranscription(): Promise<void> {
    const file = this.currentState.selectedFile;
    if (file === null || this.submitting || this.destroyed) {
      return;
    }

    this.submitting = true;
    this.requestFailureMessage = null;
    this.currentState = {
      ...this.currentState,
      selectedSettings: this.getCombinedSettings(),
    };
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

    this.cleanupAudio();
    this.polling.stop();
    this.elements.languageHintsInput.value = '';
    this.elements.diarizationCheckbox.checked = false;
    this.elements.contextTermsInput.value = '';
    this.elements.contextTextInput.value = '';
    this.languageControl.control.setValue(AUTOMATIC_LANGUAGE_DETECTION);
    this.currentState = createInitialClientState(AUTOMATIC_LANGUAGE_DETECTION);
    this.submitting = false;
    this.requestFailureMessage = null;
    this.downloadFailureMessage = null;
    this.uploadZone.controller.clear();
    this.render();
  }

  private toggleTimestamps(): void {
    this.showTimestamps = !this.showTimestamps;
    if (this.timestampButton) {
      if (this.showTimestamps) {
        this.timestampButton.className = 'rounded-md border border-secondary bg-secondary/15 px-2.5 py-1 font-geist text-xs font-semibold text-secondary hover:bg-secondary/25 transition shadow-xs flex items-center gap-1';
        this.timestampButton.textContent = '⏱ Timestamps (ON)';
      } else {
        this.timestampButton.className = 'rounded-md border border-outline-variant bg-surface px-2.5 py-1 font-geist text-xs font-medium text-on-surface hover:bg-surface-container transition shadow-xs flex items-center gap-1';
        this.timestampButton.textContent = '⏱ Timestamps';
      }
    }

    if (this.currentState.tokens && this.currentState.tokens.length > 0) {
      const formatted = formatDiarizedTranscript(this.currentState.tokens, {
        includeTimestamps: this.showTimestamps,
      });
      this.currentState = {
        ...this.currentState,
        transcriptText: formatted,
      };
      this.viewer.render(this.currentState);
    }
  }

  private showPlayerError(message: string): void {
    if (this.playerErrorBanner && this.playerErrorText) {
      this.playerErrorText.textContent = `⚠️ ${message}`;
      this.playerErrorBanner.hidden = false;
    }
  }

  private togglePlayback(): void {
    if (!this.audioElement || !this.audioElement.src) {
      const file = this.currentState.selectedFile;
      if (file) {
        this.setupAudio(file as Blob);
      } else if (this.currentState.activeJobId) {
        this.setupAudio(`/api/transcriptions/${encodeURIComponent(this.currentState.activeJobId)}/audio`);
      }
    }

    if (!this.audioElement || !this.audioElement.src) {
      this.showPlayerError('No audio stream or file available for playback.');
      return;
    }

    const audio = this.audioElement;
    if (this.isPlaying) {
      audio.pause();
      this.isPlaying = false;
      if (this.playerPlayBtn) {
        this.playerPlayBtn.textContent = '▶';
        this.playerPlayBtn.setAttribute('aria-label', 'Play audio');
      }
    } else {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            this.isPlaying = true;
            if (this.playerErrorBanner) {
              this.playerErrorBanner.hidden = true;
            }
            if (this.playerPlayBtn) {
              this.playerPlayBtn.textContent = '❚❚';
              this.playerPlayBtn.setAttribute('aria-label', 'Pause audio');
            }
          })
          .catch((err) => {
            this.isPlaying = false;
            if (this.playerPlayBtn) {
              this.playerPlayBtn.textContent = '▶';
              this.playerPlayBtn.setAttribute('aria-label', 'Play audio');
            }
            const name = err instanceof Error ? err.name : '';
            if (name === 'NotSupportedError') {
              this.showPlayerError('Your browser cannot decode this audio format for playback (e.g. M4A container with unsupported codec). Transcript remains fully available.');
            } else if (name === 'NotAllowedError') {
              this.showPlayerError('Browser autoplay was blocked. Click play again to start.');
            } else {
              this.showPlayerError('Audio playback failed in this browser. Try an MP3 or standard WAV file.');
            }
          });
      } else {
        this.isPlaying = true;
        if (this.playerPlayBtn) {
          this.playerPlayBtn.textContent = '❚❚';
          this.playerPlayBtn.setAttribute('aria-label', 'Pause audio');
        }
      }
    }
  }

  private seekPlayback(e: MouseEvent, track: HTMLElement): void {
    if (!this.audioElement || !this.audioElement.src) {
      const file = this.currentState.selectedFile;
      if (file) {
        this.setupAudio(file as Blob);
      } else if (this.currentState.activeJobId) {
        this.setupAudio(`/api/transcriptions/${encodeURIComponent(this.currentState.activeJobId)}/audio`);
      }
    }
    if (this.audioElement && this.audioElement.duration > 0 && typeof e.clientX === 'number') {
      const rect = track.getBoundingClientRect?.() ?? { left: 0, width: 200 };
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / (rect.width || 1)));
      this.audioElement.currentTime = ratio * this.audioElement.duration;
    }
  }

  private setupAudio(source: Blob | string): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const AudioClass = window.Audio || (typeof Audio !== 'undefined' ? Audio : undefined);
      if (!this.audioElement && AudioClass) {
        this.audioElement = new AudioClass();
      }

      if (!this.audioElement) {
        return;
      }

      if (this.audioObjectUrl && window.URL?.revokeObjectURL) {
        try {
          window.URL.revokeObjectURL(this.audioObjectUrl);
        } catch {
          // ignore
        }
        this.audioObjectUrl = null;
      }

      if (typeof source === 'string') {
        this.audioElement.src = source;
      } else if (window.URL?.createObjectURL) {
        this.audioObjectUrl = window.URL.createObjectURL(source);
        this.audioElement.src = this.audioObjectUrl;
      }

      this.audioElement.preload = 'metadata';

      if (this.playerFileBadge) {
        const name = this.currentState.selectedFile?.name || 'Session Recording';
        this.playerFileBadge.textContent = name;
        this.playerFileBadge.title = name;
      }

      const audio = this.audioElement;

      audio.onloadedmetadata = () => {
        if (this.playerPlayTime && audio.duration) {
          this.playerPlayTime.textContent = `00:00 / ${formatTime(audio.duration)}`;
        }
      };

      audio.ontimeupdate = () => {
        const cur = audio.currentTime || 0;
        const dur = audio.duration || 0;
        if (this.playerPlayTime) {
          this.playerPlayTime.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        }
        if (this.playerTrackFill && dur > 0) {
          const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
          this.playerTrackFill.style.width = `${pct}%`;
        }
      };

      audio.onended = () => {
        this.isPlaying = false;
        if (this.playerPlayBtn) {
          this.playerPlayBtn.textContent = '▶';
          this.playerPlayBtn.setAttribute('aria-label', 'Play audio');
        }
        if (this.playerTrackFill) {
          this.playerTrackFill.style.width = '0%';
        }
      };

      audio.onerror = () => {
        const err = audio.error;
        let msg = 'Playback error: The browser could not decode or stream this audio file.';
        if (err && err.code === 4) {
          msg = 'Audio format or container (e.g. M4A/ALAC) cannot be decoded by your browser for playback. Transcript remains fully accurate and downloadable below.';
        }
        this.showPlayerError(msg);
      };

      try {
        audio.load();
      } catch {
        // ignore in test
      }
    } catch {
      // Audio not supported in test or restricted environment
    }
  }

  private cleanupAudio(): void {
    if (this.audioElement) {
      try {
        this.audioElement.pause();
      } catch {
        // ignore
      }
      this.audioElement = null;
    }
    if (this.audioObjectUrl && typeof window !== 'undefined' && window.URL?.revokeObjectURL) {
      try {
        window.URL.revokeObjectURL(this.audioObjectUrl);
      } catch {
        // ignore
      }
      this.audioObjectUrl = null;
    }
    this.isPlaying = false;
    if (this.playerErrorBanner) {
      this.playerErrorBanner.hidden = true;
    }
    if (this.timestampButton) {
      this.showTimestamps = false;
      this.timestampButton.className = 'rounded-md border border-outline-variant bg-surface px-2.5 py-1 font-geist text-xs font-medium text-on-surface hover:bg-surface-container transition shadow-xs flex items-center gap-1';
      this.timestampButton.textContent = '⏱ Timestamps';
    }
    if (this.playerPlayBtn) {
      this.playerPlayBtn.textContent = '▶';
      this.playerPlayBtn.setAttribute('aria-label', 'Play audio');
    }
    if (this.playerPlayTime) {
      this.playerPlayTime.textContent = '00:00 / --:--';
    }
    if (this.playerFileBadge) {
      this.playerFileBadge.textContent = 'Audio File';
      this.playerFileBadge.title = '';
    }
    if (this.playerTrackFill) {
      this.playerTrackFill.style.width = '0%';
    }
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

    if (layout === 'completed') {
      if (!this.audioElement || !this.audioElement.src) {
        if (this.currentState.selectedFile) {
          this.setupAudio(this.currentState.selectedFile as Blob);
        } else if (this.currentState.activeJobId) {
          this.setupAudio(`/api/transcriptions/${encodeURIComponent(this.currentState.activeJobId)}/audio`);
        }
      }
    }

    const locked = areSettingsLocked(this.currentState);
    this.languageControl.control.setDisabled(locked);
    this.elements.languageHintsInput.disabled = locked;
    this.elements.diarizationCheckbox.disabled = locked;
    this.elements.contextTermsInput.disabled = locked;
    this.elements.contextTextInput.disabled = locked;
    this.elements.startButton.disabled = this.currentState.selectedFile === null || this.submitting;
    this.elements.startButton.setAttribute('aria-busy', this.submitting ? 'true' : 'false');

    this.elements.requestFailure.textContent = this.requestFailureMessage ?? '';
    this.elements.requestFailure.hidden = this.requestFailureMessage === null;

    if (layout === 'completed' && this.currentState.confidenceScore !== null) {
      const pct = Math.round(this.currentState.confidenceScore * 100);
      this.elements.confidenceBadge.textContent = `Confidence: ${pct}%`;
      this.elements.confidenceBadge.hidden = false;
      if (pct >= 85) {
        this.elements.confidenceBadge.className = 'rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 font-geist text-label-md text-on-surface';
      } else if (pct >= 70) {
        this.elements.confidenceBadge.className = 'rounded-full border border-outline-variant bg-surface-container px-3 py-1 font-geist text-label-md text-on-surface-variant';
      } else {
        this.elements.confidenceBadge.className = 'rounded-full border border-error bg-error-container px-3 py-1 font-geist text-label-md text-on-error-container';
      }
    } else {
      this.elements.confidenceBadge.hidden = true;
    }

    if (layout === 'completed' && this.currentState.tokens && this.currentState.tokens.length > 0) {
      const lowTokens = this.currentState.tokens.filter(
        (t) => typeof t.confidence === 'number' && t.confidence < 0.8 && t.text.trim().length > 0,
      );
      if (lowTokens.length > 0) {
        const preview = lowTokens.slice(0, 5).map((t) => `"${t.text.trim()}" (${Math.round((t.confidence ?? 0) * 100)}%)`).join(', ');
        const extra = lowTokens.length > 5 ? ` and ${lowTokens.length - 5} more` : '';
        this.elements.lowConfidenceReview.textContent = `Words with lower confidence (< 80%): ${preview}${extra}. Review against audio if necessary.`;
        this.elements.lowConfidenceReview.hidden = false;
      } else {
        this.elements.lowConfidenceReview.hidden = true;
      }
    } else {
      this.elements.lowConfidenceReview.hidden = true;
    }

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
