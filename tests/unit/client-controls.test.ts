import { describe, expect, it, vi } from 'vitest';

import {
  AUDIO_FILE_ACCEPT,
  BROWSE_AUDIO_FILE_LABEL,
  FileSelectionController,
  UPLOAD_ZONE_IDLE_COPY,
  createLanguagePreferenceControl,
  createUploadZone,
} from '../../src/client';
import {
  AUTOMATIC_LANGUAGE_DETECTION,
  INVALID_AUDIO_SELECTION_MESSAGE,
} from '../../src/shared';
import {
  DEFAULT_LANGUAGE_OPTIONS,
  ENGLISH_LANGUAGE,
  TAGALOG_FILIPINO_LANGUAGE,
} from '../../src/client';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, EventListener[]>();
  readonly attributes = new Map<string, string>();
  id = '';
  className = '';
  hidden = false;
  textContent: string | null = null;
  htmlFor = '';
  value = '';
  disabled = false;
  type = '';
  accept = '';
  multiple = false;

  addEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((handler) => handler !== listener));
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const dispatchedEvent = { ...event, currentTarget: this } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(dispatchedEvent);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  click(): void {
    this.dispatch('click');
  }
}

class FakeInput extends FakeElement {
  files: File[] | null = null;
  clickCount = 0;

  override click(): void {
    this.clickCount += 1;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return tagName === 'input' ? new FakeInput() : new FakeElement();
  }
}

function browserFile(name: string, type: string): File {
  return { name, type } as File;
}

function controllerFixture() {
  const fileInput = new FakeInput();
  const dropZone = new FakeElement();
  const browseButton = new FakeElement();
  const instructionElement = new FakeElement();
  const filenameElement = new FakeElement();
  const errorElement = new FakeElement();
  const controller = new FileSelectionController({
    fileInput: fileInput as unknown as HTMLInputElement,
    dropZone: dropZone as unknown as HTMLElement,
    browseButton: browseButton as unknown as HTMLButtonElement,
    instructionElement: instructionElement as unknown as HTMLElement,
    filenameElement: filenameElement as unknown as HTMLElement,
    errorElement: errorElement as unknown as HTMLElement,
  });

  return { controller, fileInput, dropZone, browseButton, instructionElement, filenameElement, errorElement };
}

describe('FileSelectionController', () => {
  it('configures a semantic single-file browse control and opens it from the button', () => {
    const { controller, fileInput, browseButton } = controllerFixture();

    expect(fileInput.accept).toBe(AUDIO_FILE_ACCEPT);
    expect(fileInput.multiple).toBe(false);
    expect(fileInput.attributes.get('aria-label')).toBe(BROWSE_AUDIO_FILE_LABEL);

    browseButton.dispatch('click');

    expect(fileInput.clickCount).toBe(1);
    controller.destroy();
  });

  it('accepts a native browse selection through the input change event', () => {
    const file = browserFile('meeting.wav', 'audio/wav');
    const { controller, fileInput, filenameElement } = controllerFixture();

    fileInput.files = [file];
    fileInput.dispatch('change');

    expect(controller.selectedFile).toBe(file);
    expect(filenameElement.textContent).toBe('meeting.wav');
  });

  it('accepts a dropped audio file and preserves its supplied filename', () => {
    const file = browserFile('réunion-🎙️.wav', 'audio/wav');
    const { controller, dropZone, filenameElement, errorElement } = controllerFixture();
    const preventDefault = vi.fn();

    dropZone.dispatch('drop', {
      preventDefault,
      dataTransfer: { files: [file] },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(controller.selectedFile).toBe(file);
    expect(filenameElement.textContent).toBe(file.name);
    expect(filenameElement.hidden).toBe(false);
    expect(errorElement.hidden).toBe(true);
  });

  it('clears a prior valid selection and exposes the exact validation error for an invalid drop', () => {
    const validFile = browserFile('voice.wav', 'audio/wav');
    const invalidFile = browserFile('voice.txt', 'text/plain');
    const { controller, dropZone, fileInput, filenameElement, errorElement } = controllerFixture();
    const preventDefault = vi.fn();

    controller.selectFiles([validFile]);
    dropZone.dispatch('drop', {
      preventDefault,
      dataTransfer: { files: [invalidFile] },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(controller.selectedFile).toBeNull();
    expect(filenameElement.textContent).toBe('');
    expect(filenameElement.hidden).toBe(true);
    expect(errorElement.textContent).toBe(INVALID_AUDIO_SELECTION_MESSAGE);
    expect(errorElement.hidden).toBe(false);
    expect(fileInput.attributes.get('aria-invalid')).toBe('true');
  });

  it('keeps the required idle copy visible before a valid selection', () => {
    const { instructionElement, errorElement } = controllerFixture();

    expect(instructionElement.textContent).toBe(UPLOAD_ZONE_IDLE_COPY);
    expect(errorElement.hidden).toBe(true);
  });
});

describe('upload zone and language preference control', () => {
  it('creates an accessible upload zone with the required idle copy', () => {
    const uploadZone = createUploadZone(new FakeDocument() as unknown as Document);

    expect((uploadZone.root as unknown as FakeElement).attributes.get('role')).toBe('group');
    expect(uploadZone.elements.instructionElement.textContent).toBe(UPLOAD_ZONE_IDLE_COPY);
    expect(uploadZone.elements.fileInput.multiple).toBe(false);
    expect(uploadZone.elements.browseButton.type).toBe('button');
  });

  it('offers automatic detection, English, and Tagalog / Filipino with exact provider values', () => {
    const document = new FakeDocument() as unknown as Document;
    const onChange = vi.fn();
    const control = createLanguagePreferenceControl(document, {
      options: DEFAULT_LANGUAGE_OPTIONS,
      onChange,
    });

    expect(DEFAULT_LANGUAGE_OPTIONS).toEqual([
      { value: AUTOMATIC_LANGUAGE_DETECTION, label: 'Automatic language detection' },
      { value: ENGLISH_LANGUAGE, label: 'English' },
      { value: TAGALOG_FILIPINO_LANGUAGE, label: 'Tagalog / Filipino' },
    ]);
    expect(control.control.value).toBe(AUTOMATIC_LANGUAGE_DETECTION);
    expect(control.elements.label.htmlFor).toBe(control.elements.select.id);
    expect((control.elements.select as unknown as FakeElement).attributes.get('aria-label')).toBe('Source language');

    control.elements.select.value = ENGLISH_LANGUAGE;
    (control.elements.select as unknown as FakeElement).dispatch('change');
    expect(control.control.value).toBe(ENGLISH_LANGUAGE);
    expect(onChange).toHaveBeenLastCalledWith(ENGLISH_LANGUAGE);

    control.elements.select.value = TAGALOG_FILIPINO_LANGUAGE;
    (control.elements.select as unknown as FakeElement).dispatch('change');
    expect(control.control.value).toBe(TAGALOG_FILIPINO_LANGUAGE);
    expect(onChange).toHaveBeenLastCalledWith(TAGALOG_FILIPINO_LANGUAGE);
  });
});
