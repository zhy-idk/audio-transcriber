import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FileSelectionController } from '../../src/client';
import {
  INVALID_AUDIO_SELECTION_MESSAGE,
  MAX_AUDIO_FILENAME_CHARACTERS,
  validateFileSelection,
} from '../../src/shared';

type LocalFile = {
  readonly name: string;
  readonly type: string;
};

class PropertyElement {
  readonly listeners = new Map<string, EventListener[]>();
  readonly attributes = new Map<string, string>();
  id = '';
  type = '';
  accept = '';
  multiple = false;
  disabled = false;
  hidden = false;
  value = '';
  textContent: string | null = null;

  addEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((handler) => handler !== listener));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function controllerFixture(): {
  readonly controller: FileSelectionController;
  readonly filenameElement: PropertyElement;
  readonly errorElement: PropertyElement;
} {
  const filenameElement = new PropertyElement();
  const errorElement = new PropertyElement();
  const controller = new FileSelectionController({
    fileInput: new PropertyElement() as unknown as HTMLInputElement,
    dropZone: new PropertyElement() as unknown as HTMLElement,
    browseButton: new PropertyElement() as unknown as HTMLButtonElement,
    instructionElement: new PropertyElement() as unknown as HTMLElement,
    filenameElement: filenameElement as unknown as HTMLElement,
    errorElement: errorElement as unknown as HTMLElement,
  });

  return { controller, filenameElement, errorElement };
}

function asBrowserFile(file: LocalFile): File {
  return file as unknown as File;
}

function unicodeFilenameOfLength(length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.fullUnicode(), { minLength: length, maxLength: length })
    .map((codePoints) => codePoints.join(''));
}

const validFilenameArbitrary = fc
  .integer({ min: 1, max: MAX_AUDIO_FILENAME_CHARACTERS })
  .chain(unicodeFilenameOfLength);
const emptyFilenameArbitrary = fc.constant('');
const overlongFilenameArbitrary = unicodeFilenameOfLength(MAX_AUDIO_FILENAME_CHARACTERS + 1);
const audioTypeArbitrary = fc.constantFrom('audio/', 'audio/wav', 'audio/mpeg', 'audio/x-local-test');
const nonAudioTypeArbitrary = fc.constantFrom('', 'text/plain', 'video/mp4', 'application/octet-stream', 'Audio/wav');

const validFileArbitrary = fc.record({
  name: validFilenameArbitrary,
  type: audioTypeArbitrary,
});
const arbitraryFileArbitrary = fc.record({
  name: fc.oneof(validFilenameArbitrary, emptyFilenameArbitrary, overlongFilenameArbitrary),
  type: fc.oneof(audioTypeArbitrary, nonAudioTypeArbitrary),
});
const invalidSingleFileArbitrary = fc.oneof(
  fc.record({ name: fc.oneof(validFilenameArbitrary, emptyFilenameArbitrary, overlongFilenameArbitrary), type: nonAudioTypeArbitrary }),
  fc.record({ name: fc.oneof(emptyFilenameArbitrary, overlongFilenameArbitrary), type: audioTypeArbitrary }),
);

const selectionArbitrary = fc.oneof(
  validFileArbitrary.map((file) => [file]),
  fc.constant([] as LocalFile[]),
  fc.array(arbitraryFileArbitrary, { minLength: 2, maxLength: 3 }),
  invalidSingleFileArbitrary.map((file) => [file]),
);

function isExpectedAccepted(selection: readonly LocalFile[]): boolean {
  const file = selection[0];
  if (selection.length !== 1 || file === undefined) {
    return false;
  }

  const filenameLength = Array.from(file.name).length;
  return file.type.startsWith('audio/') && filenameLength >= 1 && filenameLength <= MAX_AUDIO_FILENAME_CHARACTERS;
}

describe('Property 1: audio-file selection validation', () => {
  it('accepts exactly one valid audio file deterministically and clears prior state otherwise', () => {
    // Feature: soniox-audio-transcription, Property 1: For every generated FileSelection S, the Browser Client accepts S if and only if S contains exactly one file F whose media type begins with audio/ and whose supplied filename contains 1–255 characters; accepted selections preserve F and its filename, while invalid selections clear selection and expose the exact rejection outcome.
    fc.assert(
      fc.property(selectionArbitrary, (selection) => {
        const files = selection.map(asBrowserFile);
        const expectedAccepted = isExpectedAccepted(selection);
        const firstResult = validateFileSelection(files);
        const secondResult = validateFileSelection(files);

        expect(secondResult).toEqual(firstResult);
        expect(firstResult.accepted).toBe(expectedAccepted);

        const { controller, filenameElement, errorElement } = controllerFixture();
        const priorFile = asBrowserFile({ name: 'prior.wav', type: 'audio/wav' });
        controller.selectFiles([priorFile]);
        const state = controller.selectFiles(files);

        if (expectedAccepted) {
          expect(firstResult.selectedFile).toBe(files[0]);
          expect(firstResult.errorMessage).toBeNull();
          expect(state.accepted).toBe(true);
          expect(state.selectedFile).toBe(files[0]);
          expect(filenameElement.textContent).toBe(selection[0]?.name);
          expect(state.selectedFile?.name).toBe(selection[0]?.name);
          expect(state.errorMessage).toBeNull();
          expect(errorElement.textContent).toBe('');
        } else {
          expect(firstResult.selectedFile).toBeNull();
          expect(firstResult.errorMessage).toBe(INVALID_AUDIO_SELECTION_MESSAGE);
          expect(state).toEqual({
            accepted: false,
            selectedFile: null,
            errorMessage: INVALID_AUDIO_SELECTION_MESSAGE,
          });
          expect(filenameElement.textContent).toBe('');
          expect(errorElement.textContent).toBe(INVALID_AUDIO_SELECTION_MESSAGE);
        }

        controller.destroy();
      }),
      { numRuns: 100 },
    );
  });
});
