import type { TranscriptionApi } from './transcription-api';

export interface VoiceEnrollmentElements {
  readonly root: HTMLElement;
  readonly toggleButton: HTMLButtonElement;
  readonly contentPanel: HTMLElement;
  readonly speakersList: HTMLElement;
  readonly nameInput: HTMLInputElement;
  readonly fileInput: HTMLInputElement;
  readonly micSelect: HTMLSelectElement;
  readonly recordButton: HTMLButtonElement;
  readonly recordStatus: HTMLElement;
  readonly recordingGuide: HTMLElement;
  readonly suggestedText: HTMLElement;
  readonly enrollButton: HTMLButtonElement;
  readonly feedback: HTMLElement;
}

export interface VoiceEnrollmentOptions {
  readonly api?: TranscriptionApi | undefined;
  readonly onSpeakersChanged?: ((speakers: readonly string[]) => void) | undefined;
}

export interface VoiceEnrollmentInstance {
  readonly root: HTMLElement;
  readonly elements: VoiceEnrollmentElements;
  readonly control: VoiceEnrollmentControl;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  className = '',
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  if (className.length > 0) {
    el.className = className;
  }
  return el;
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const dataLength = channelData.length * 2;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < channelData.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, channelData[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export class VoiceEnrollmentControl {
  private readonly api?: TranscriptionApi | undefined;
  private readonly onSpeakersChanged?: ((speakers: readonly string[]) => void) | undefined;
  private speakers: readonly string[] = [];
  private expanded = false;
  private enrolling = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedBlob: Blob | null = null;
  private mediaStream: MediaStream | null = null;
  private recordInterval: ReturnType<typeof setInterval> | null = null;
  private recordSeconds = 0;
  private destroyed = false;

  private readonly handleDeviceChange = (): void => {
    void this.loadMicrophones();
  };

  constructor(
    private readonly document: Document,
    public readonly elements: VoiceEnrollmentElements,
    options: VoiceEnrollmentOptions = {},
  ) {
    this.api = options.api;
    this.onSpeakersChanged = options.onSpeakersChanged;

    this.elements.toggleButton.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.render();
      if (this.expanded) {
        void this.loadMicrophones();
      }
    });

    this.elements.nameInput.addEventListener('input', () => {
      this.updateSuggestedText();
      this.updateEnrollButtonState();
    });

    this.elements.fileInput.addEventListener('change', () => {
      if (this.elements.fileInput.files && this.elements.fileInput.files.length > 0) {
        this.recordedBlob = null;
        this.elements.recordStatus.hidden = true;
      }
      this.updateEnrollButtonState();
    });

    this.elements.recordButton.addEventListener('click', () => {
      void this.handleRecordToggle();
    });

    this.elements.enrollButton.addEventListener('click', () => {
      void this.handleEnroll();
    });

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
    }

    this.render();
    void this.loadSpeakers();
    void this.loadMicrophones();
  }

  public get enrolledSpeakers(): readonly string[] {
    return this.speakers;
  }

  public async loadMicrophones(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      if (audioInputs.length > 0) {
        const currentVal = this.elements.micSelect.value;
        this.elements.micSelect.replaceChildren();

        const defaultOpt = createElement(this.document, 'option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Default System Microphone';
        this.elements.micSelect.append(defaultOpt);

        let idx = 1;
        for (const mic of audioInputs) {
          if (!mic.deviceId) continue;
          const opt = createElement(this.document, 'option');
          opt.value = mic.deviceId;
          opt.textContent = mic.label || `Microphone ${idx++}`;
          this.elements.micSelect.append(opt);
        }

        if (currentVal) {
          this.elements.micSelect.value = currentVal;
        }
      }
    } catch {
      // ignore
    }
  }

  private updateSuggestedText(): void {
    const raw = this.elements.nameInput.value.trim();
    const name = raw.length > 0 ? raw : '[Your Name]';
    this.elements.suggestedText.textContent = `"Hi, my name is ${name}, and I am recording my voice sample for speaker identification."`;
  }

  public async loadSpeakers(): Promise<void> {
    if (this.destroyed || !this.api?.listSpeakers) {
      return;
    }

    try {
      this.speakers = await this.api.listSpeakers();
      this.renderSpeakers();
      this.updateToggleButton();
      this.onSpeakersChanged?.(this.speakers);
    } catch {
      // Background load failures do not block the page.
    }
  }

  private updateEnrollButtonState(): void {
    const hasName = this.elements.nameInput.value.trim().length > 0;
    const hasFile = (this.elements.fileInput.files && this.elements.fileInput.files.length > 0) || this.recordedBlob !== null;
    this.elements.enrollButton.disabled = !hasName || !hasFile || this.enrolling;
  }

  private async handleRecordToggle(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.showFeedback('Microphone recording is not supported in this browser.', 'error');
      return;
    }

    try {
      const deviceId = this.elements.micSelect.value;
      const audioConstraints: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      this.mediaStream = stream;
      void this.loadMicrophones();

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      this.mediaRecorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        this.stopMediaStream();
        if (this.recordInterval) {
          clearInterval(this.recordInterval);
          this.recordInterval = null;
        }

        const rawBlob = new Blob(chunks, { type: 'audio/webm' });
        const AudioCtxClass = typeof window !== 'undefined'
          ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : undefined;

        if (AudioCtxClass) {
          const audioCtx = new AudioCtxClass();
          rawBlob.arrayBuffer()
            .then((buffer) => audioCtx.decodeAudioData(buffer))
            .then((audioBuffer) => {
              this.recordedBlob = audioBufferToWav(audioBuffer);
              void audioCtx.close();
            })
            .catch(() => {
              this.recordedBlob = rawBlob;
            })
            .finally(() => {
              this.elements.recordButton.textContent = '🎙️ Re-record';
              this.elements.recordStatus.textContent = `✓ Voice sample recorded (${this.recordSeconds}s)`;
              this.elements.recordStatus.className = 'font-inter text-xs text-secondary font-medium';
              this.elements.recordStatus.hidden = false;
              this.updateEnrollButtonState();
            });
        } else {
          this.recordedBlob = rawBlob;
          this.elements.recordButton.textContent = '🎙️ Re-record';
          this.elements.recordStatus.textContent = `✓ Voice sample recorded (${this.recordSeconds}s)`;
          this.elements.recordStatus.className = 'font-inter text-xs text-secondary font-medium';
          this.elements.recordStatus.hidden = false;
          this.updateEnrollButtonState();
        }
      };

      recorder.start();
      this.recordSeconds = 0;
      this.elements.recordButton.textContent = '⏹️ Stop recording';
      this.elements.recordStatus.textContent = 'Recording: 0s (3–7s recommended)';
      this.elements.recordStatus.className = 'animate-pulse font-inter text-xs text-error font-medium';
      this.elements.recordStatus.hidden = false;

      this.recordInterval = setInterval(() => {
        this.recordSeconds += 1;
        if (this.recordSeconds >= 5) {
          this.elements.recordStatus.textContent = `Recording: ${this.recordSeconds}s (Good length! Click stop when ready)`;
          this.elements.recordStatus.className = 'animate-pulse font-inter text-xs text-secondary font-medium';
        } else {
          this.elements.recordStatus.textContent = `Recording: ${this.recordSeconds}s (3–7s recommended)`;
        }
      }, 1000);
    } catch {
      this.showFeedback('Microphone access denied or unavailable.', 'error');
    }
  }

  private stopMediaStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }

  private async handleEnroll(): Promise<void> {
    const name = this.elements.nameInput.value.trim();
    const file = this.elements.fileInput.files?.[0] ?? this.recordedBlob;

    if (!name || !file || this.enrolling || !this.api?.enrollSpeaker) {
      return;
    }

    this.enrolling = true;
    this.elements.enrollButton.disabled = true;
    this.elements.enrollButton.setAttribute('aria-busy', 'true');
    this.elements.enrollButton.textContent = 'Enrolling...';
    this.clearFeedback();

    try {
      await this.api.enrollSpeaker(name, file);
      this.showFeedback(`Speaker "${name}" enrolled successfully!`, 'success');
      this.elements.nameInput.value = '';
      this.updateSuggestedText();
      this.elements.fileInput.value = '';
      this.recordedBlob = null;
      this.elements.recordButton.textContent = '🎙️ Record sample';
      this.elements.recordStatus.hidden = true;
      await this.loadSpeakers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice enrollment failed.';
      this.showFeedback(msg, 'error');
    } finally {
      this.enrolling = false;
      this.elements.enrollButton.setAttribute('aria-busy', 'false');
      this.elements.enrollButton.textContent = 'Enroll Voice';
      this.updateEnrollButtonState();
    }
  }

  private async handleRemove(name: string): Promise<void> {
    if (!this.api?.removeSpeaker) {
      return;
    }

    try {
      await this.api.removeSpeaker(name);
      this.showFeedback(`Removed speaker "${name}".`, 'success');
      await this.loadSpeakers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to remove ${name}.`;
      this.showFeedback(msg, 'error');
    }
  }

  private showFeedback(message: string, type: 'success' | 'error'): void {
    this.elements.feedback.textContent = message;
    this.elements.feedback.className = type === 'success'
      ? 'font-inter text-xs text-secondary font-medium'
      : 'font-inter text-xs text-error font-medium';
    this.elements.feedback.hidden = false;
  }

  private clearFeedback(): void {
    this.elements.feedback.textContent = '';
    this.elements.feedback.hidden = true;
  }

  private updateToggleButton(): void {
    const count = this.speakers.length;
    this.elements.toggleButton.textContent = this.expanded
      ? `Hide Profiles (${count})`
      : `Manage Voice Profiles (${count})`;
  }

  private render(): void {
    this.elements.contentPanel.hidden = !this.expanded;
    this.updateToggleButton();
  }

  private renderSpeakers(): void {
    this.elements.speakersList.replaceChildren();

    if (this.speakers.length === 0) {
      const empty = createElement(this.document, 'p', 'font-inter text-xs text-on-surface-variant');
      empty.textContent = 'No speakers enrolled yet. Enroll voice samples below to identify names automatically.';
      this.elements.speakersList.append(empty);
      return;
    }

    for (const speaker of this.speakers) {
      const chip = createElement(
        this.document,
        'span',
        'inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface px-3 py-1 font-geist text-xs font-medium text-on-surface shadow-sm',
      );
      const avatar = createElement(
        this.document,
        'span',
        'inline-flex h-4 w-4 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-on-secondary',
      );
      avatar.textContent = speaker.charAt(0).toUpperCase();

      const nameSpan = createElement(this.document, 'span');
      nameSpan.textContent = speaker;

      const removeBtn = createElement(
        this.document,
        'button',
        'ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-on-surface-variant hover:bg-error/15 hover:text-error transition font-bold',
      );
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', `Remove speaker ${speaker}`);
      removeBtn.addEventListener('click', () => {
        void this.handleRemove(speaker);
      });

      chip.append(avatar, nameSpan, removeBtn);
      this.elements.speakersList.append(chip);
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopMediaStream();
    if (this.recordInterval) {
      clearInterval(this.recordInterval);
      this.recordInterval = null;
    }
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
  }
}

export function createVoiceEnrollmentControl(
  document: Document,
  options: VoiceEnrollmentOptions = {},
): VoiceEnrollmentInstance {
  const root = createElement(
    document,
    'section',
    'min-w-0 space-y-4 rounded-lg border border-outline-variant bg-surface-container-lowest p-5',
  );
  root.id = 'voice-enrollment-section';

  const header = createElement(
    document,
    'div',
    'flex flex-wrap items-center justify-between gap-3',
  );

  const titleGroup = createElement(document, 'div', 'min-w-0');
  const title = createElement(
    document,
    'h3',
    'font-geist text-base font-semibold text-on-surface flex items-center gap-2',
  );
  title.textContent = 'Speaker Voice Profiles (sherpa-onnx)';

  const subtitle = createElement(
    document,
    'p',
    'mt-0.5 font-inter text-xs text-on-surface-variant',
  );
  subtitle.textContent = 'Enroll voices to replace generic speaker labels with real names in diarized transcripts.';
  titleGroup.append(title, subtitle);

  const toggleButton = createElement(
    document,
    'button',
    'shrink-0 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-geist text-xs font-semibold text-on-surface shadow-sm hover:bg-surface-container transition outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
  );
  toggleButton.type = 'button';
  toggleButton.textContent = 'Manage Voice Profiles (0)';
  header.append(titleGroup, toggleButton);

  const contentPanel = createElement(
    document,
    'div',
    'space-y-4 border-t border-outline-variant pt-4',
  );
  contentPanel.hidden = true;

  // Enrolled speakers list
  const listGroup = createElement(document, 'div', 'min-w-0');
  const listLabel = createElement(
    document,
    'label',
    'mb-1.5 block font-geist text-xs font-semibold uppercase tracking-wider text-on-surface-variant',
  );
  listLabel.textContent = 'Enrolled Speakers';
  const speakersList = createElement(
    document,
    'div',
    'flex min-h-[2.5rem] flex-wrap items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-2.5',
  );
  speakersList.id = 'enrolled-speakers-list';
  listGroup.append(listLabel, speakersList);

  // Form fields
  const formGrid = createElement(document, 'div', 'grid gap-3 sm:grid-cols-2');

  const nameGroup = createElement(document, 'div', 'min-w-0');
  const nameLabel = createElement(
    document,
    'label',
    'mb-1.5 block font-geist text-xs font-semibold text-on-surface',
  );
  nameLabel.textContent = 'Speaker Name';
  const nameInput = createElement(
    document,
    'input',
    'w-full rounded-lg border border-outline-variant bg-surface px-3.5 py-2 font-inter text-body-sm text-on-surface outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
  );
  nameInput.id = 'speaker-name-input';
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g., Alice';
  nameGroup.append(nameLabel, nameInput);

  const fileGroup = createElement(document, 'div', 'min-w-0');
  const fileLabel = createElement(
    document,
    'label',
    'mb-1.5 block font-geist text-xs font-semibold text-on-surface',
  );
  fileLabel.textContent = 'Upload Audio File (Optional alternative to mic)';
  const fileInput = createElement(
    document,
    'input',
    'w-full font-inter text-xs text-on-surface file:mr-2.5 file:rounded-md file:border-0 file:bg-surface-container-high file:px-3 file:py-1.5 file:font-geist file:text-xs file:font-semibold file:text-on-surface outline-focus',
  );
  fileInput.id = 'speaker-audio-file';
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileGroup.append(fileLabel, fileInput);

  formGrid.append(nameGroup, fileGroup);

  // Recording guide box
  const recordingGuide = createElement(
    document,
    'div',
    'rounded-lg border border-outline-variant bg-surface-container-low p-3.5 space-y-2',
  );
  const guideHeader = createElement(document, 'div', 'flex flex-wrap items-center justify-between gap-1');
  const guideTitle = createElement(document, 'span', 'font-geist text-xs font-semibold text-on-surface flex items-center gap-1.5');
  guideTitle.textContent = '🎙️ Recording Guide';
  const guideDuration = createElement(document, 'span', 'rounded-full bg-secondary/15 px-2.5 py-0.5 font-geist text-[11px] font-semibold text-secondary');
  guideDuration.textContent = '3–7 seconds recommended';
  guideHeader.append(guideTitle, guideDuration);

  const guideDesc = createElement(document, 'p', 'font-inter text-xs text-on-surface-variant');
  guideDesc.textContent = 'Speak naturally in your normal conversational tone for 3 to 7 seconds (~5s is ideal). You can read aloud:';

  const suggestedText = createElement(document, 'p', 'rounded-md border border-outline-variant/60 bg-surface px-3 py-2 font-inter text-xs italic text-on-surface leading-relaxed');
  suggestedText.textContent = '"Hi, my name is [Your Name], and I am recording my voice sample for speaker identification."';
  recordingGuide.append(guideHeader, guideDesc, suggestedText);

  // Microphone selection & recording row
  const micRow = createElement(document, 'div', 'grid gap-3 sm:grid-cols-2');

  const micGroup = createElement(document, 'div', 'min-w-0');
  const micLabel = createElement(document, 'label', 'mb-1.5 block font-geist text-xs font-semibold text-on-surface');
  micLabel.textContent = 'Select Microphone';
  micLabel.htmlFor = 'speaker-mic-select';
  const micSelect = createElement(document, 'select', 'w-full rounded-lg border border-outline-variant bg-surface px-3.5 py-2 font-inter text-body-sm text-on-surface outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary');
  micSelect.id = 'speaker-mic-select';
  const defaultOption = createElement(document, 'option');
  defaultOption.value = '';
  defaultOption.textContent = 'Default System Microphone';
  micSelect.append(defaultOption);
  micGroup.append(micLabel, micSelect);

  const recordActionGroup = createElement(document, 'div', 'flex flex-col justify-end gap-1.5 min-w-0');
  const recordButtonRow = createElement(document, 'div', 'flex items-center gap-2');
  const recordButton = createElement(
    document,
    'button',
    'rounded-lg border border-secondary/40 bg-surface px-4 py-2 font-geist text-xs font-semibold text-secondary hover:bg-secondary/10 transition shadow-sm focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary',
  );
  recordButton.type = 'button';
  recordButton.textContent = '🎙️ Record sample';
  const recordStatus = createElement(document, 'span', 'font-inter text-xs text-on-surface-variant');
  recordStatus.hidden = true;
  recordButtonRow.append(recordButton, recordStatus);
  recordActionGroup.append(recordButtonRow);

  micRow.append(micGroup, recordActionGroup);

  // Action & feedback row
  const actionRow = createElement(document, 'div', 'flex flex-wrap items-center gap-3 pt-1');
  const enrollButton = createElement(
    document,
    'button',
    'rounded-lg bg-secondary px-5 py-2.5 font-geist text-xs font-semibold text-on-secondary shadow-sm hover:bg-secondary/90 transition outline-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50',
  );
  enrollButton.type = 'button';
  enrollButton.textContent = 'Enroll Voice';
  enrollButton.disabled = true;

  const feedback = createElement(document, 'span', 'font-inter text-xs font-medium');
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  actionRow.append(enrollButton, feedback);

  contentPanel.append(listGroup, formGrid, recordingGuide, micRow, actionRow);
  root.append(header, contentPanel);

  const elements: VoiceEnrollmentElements = {
    root,
    toggleButton,
    contentPanel,
    speakersList,
    nameInput,
    fileInput,
    micSelect,
    recordButton,
    recordStatus,
    recordingGuide,
    suggestedText,
    enrollButton,
    feedback,
  };

  const control = new VoiceEnrollmentControl(document, elements, options);
  return { root, elements, control };
}
