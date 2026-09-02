import {
  BROWSE_AUDIO_FILE_LABEL,
  FileSelectionController,
  type FileSelectionControllerOptions,
  type FileSelectionElements,
} from './file-selection';

export interface UploadZoneElements extends FileSelectionElements {
  readonly root: HTMLDivElement;
}

export interface UploadZoneOptions extends FileSelectionControllerOptions {
  readonly id?: string;
}

export interface UploadZone {
  readonly root: HTMLDivElement;
  readonly elements: UploadZoneElements;
  readonly controller: FileSelectionController;
}

/**
 * Creates the accessible upload zone and wires it to FileSelectionController.
 * Styling is expressed entirely with existing Precision Core Tailwind tokens.
 */
export function createUploadZone(
  document: Document,
  options: UploadZoneOptions = {},
): UploadZone {
  const id = options.id ?? 'audio-file-input';
  const root = document.createElement('div');
  root.className = 'min-w-0 rounded-lg border-2 border-dashed border-outline-variant bg-surface-container-low p-margin-md';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Audio file upload');

  const instructionElement = document.createElement('p');
  instructionElement.id = `${id}-instruction`;
  instructionElement.className = 'font-inter text-body-md text-on-surface';

  const fileInput = document.createElement('input');
  fileInput.id = id;
  fileInput.className = 'sr-only';
  fileInput.tabIndex = -1;
  fileInput.setAttribute('aria-hidden', 'true');
  fileInput.setAttribute('autocomplete', 'off');

  const browseButton = document.createElement('button');
  browseButton.className = 'mt-margin-sm rounded-lg bg-secondary px-5 py-3 font-geist text-label-md text-on-secondary outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary';
  browseButton.textContent = BROWSE_AUDIO_FILE_LABEL;

  const filenameElement = document.createElement('p');
  filenameElement.id = `${id}-filename`;
  filenameElement.className = 'mt-margin-sm break-words font-inter text-body-sm text-on-surface-variant';
  filenameElement.hidden = true;

  const errorElement = document.createElement('p');
  errorElement.id = `${id}-error`;
  errorElement.className = 'mt-2 font-inter text-body-sm text-error';
  errorElement.hidden = true;

  root.append(fileInput, instructionElement, browseButton, filenameElement, errorElement);

  const elements: UploadZoneElements = {
    root,
    fileInput,
    dropZone: root,
    browseButton,
    instructionElement,
    filenameElement,
    errorElement,
  };
  const controller = new FileSelectionController(elements, options);

  return { root, elements, controller };
}
