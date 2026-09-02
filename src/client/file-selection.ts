import {
  type AcceptedAudioFile,
  type FileSelectionValidation,
  validateFileSelection,
} from '../shared/transcription';

export const AUDIO_FILE_ACCEPT = 'audio/*';
export const UPLOAD_ZONE_IDLE_COPY = 'Browse for or drag one audio file into this upload zone.';
export const BROWSE_AUDIO_FILE_LABEL = 'Browse for an audio file';

export interface FileSelectionState extends FileSelectionValidation {}

export interface FileSelectionElements {
  readonly fileInput: HTMLInputElement;
  readonly dropZone: HTMLElement;
  readonly browseButton: HTMLButtonElement;
  readonly instructionElement: HTMLElement;
  readonly filenameElement: HTMLElement;
  readonly errorElement: HTMLElement;
}

export interface FileSelectionControllerOptions {
  readonly onStateChange?: (state: FileSelectionState) => void;
}

/**
 * Coordinates native browse and drag/drop selection through the shared
 * acceptance rule. Every invalid event replaces the prior state with a clear
 * selection and the public exact-one-audio-file message.
 */
export class FileSelectionController {
  private state: FileSelectionState = {
    accepted: false,
    selectedFile: null,
    errorMessage: null,
  };

  private readonly onStateChange: (state: FileSelectionState) => void;

  private readonly handleBrowseClick = (): void => {
    if (!this.elements.fileInput.disabled) {
      this.elements.fileInput.click();
    }
  };

  private readonly handleInputChange = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement | null;
    this.selectFiles(input?.files ? Array.from(input.files) : []);
  };

  private readonly handleDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.elements.dropZone.classList.add('bg-surface-container-high');
  };

  private readonly handleDragLeave = (): void => {
    this.elements.dropZone.classList.remove('bg-surface-container-high');
  };

  private readonly handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.elements.dropZone.classList.remove('bg-surface-container-high');
    this.selectFiles(event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : []);
  };

  constructor(
    private readonly elements: FileSelectionElements,
    options: FileSelectionControllerOptions = {},
  ) {
    this.onStateChange = options.onStateChange ?? (() => undefined);

    this.elements.fileInput.type = 'file';
    this.elements.fileInput.accept = AUDIO_FILE_ACCEPT;
    this.elements.fileInput.multiple = false;
    this.elements.fileInput.setAttribute('aria-label', BROWSE_AUDIO_FILE_LABEL);
    this.elements.browseButton.type = 'button';
    this.elements.browseButton.setAttribute('aria-label', BROWSE_AUDIO_FILE_LABEL);
    this.elements.browseButton.setAttribute('aria-controls', this.elements.fileInput.id);
    this.elements.instructionElement.textContent = UPLOAD_ZONE_IDLE_COPY;
    this.elements.errorElement.setAttribute('role', 'alert');
    this.elements.errorElement.setAttribute('aria-live', 'assertive');

    this.elements.browseButton.addEventListener('click', this.handleBrowseClick);
    this.elements.fileInput.addEventListener('change', this.handleInputChange);
    this.elements.dropZone.addEventListener('dragover', this.handleDragOver);
    this.elements.dropZone.addEventListener('dragleave', this.handleDragLeave);
    this.elements.dropZone.addEventListener('drop', this.handleDrop);

    this.render();
  }

  get selectedFile(): AcceptedAudioFile | null {
    return this.state.selectedFile;
  }

  get errorMessage(): string | null {
    return this.state.errorMessage;
  }

  get currentState(): FileSelectionState {
    return this.state;
  }

  /** Applies browse/drop files and returns the resulting public selection state. */
  selectFiles(files: Iterable<File>): FileSelectionState {
    const result = validateFileSelection(Array.from(files));
    this.state = result;
    if (!result.accepted) {
      // Clearing the value permits selecting the same invalid file again and
      // ensures the browser input does not retain an invalid prior selection.
      this.elements.fileInput.value = '';
    }
    this.render();
    this.onStateChange(this.state);
    return this.state;
  }

  clear(): FileSelectionState {
    return this.selectFiles([]);
  }

  destroy(): void {
    this.elements.browseButton.removeEventListener('click', this.handleBrowseClick);
    this.elements.fileInput.removeEventListener('change', this.handleInputChange);
    this.elements.dropZone.removeEventListener('dragover', this.handleDragOver);
    this.elements.dropZone.removeEventListener('dragleave', this.handleDragLeave);
    this.elements.dropZone.removeEventListener('drop', this.handleDrop);
  }

  private render(): void {
    const hasSelection = this.state.selectedFile !== null;
    const hasError = this.state.errorMessage !== null;

    this.elements.filenameElement.textContent = this.state.selectedFile?.name ?? '';
    this.elements.filenameElement.hidden = !hasSelection;
    this.elements.errorElement.textContent = this.state.errorMessage ?? '';
    this.elements.errorElement.hidden = !hasError;
    this.elements.fileInput.setAttribute('aria-invalid', hasError ? 'true' : 'false');
    this.elements.dropZone.setAttribute('aria-describedby', this.elements.instructionElement.id);
  }
}
