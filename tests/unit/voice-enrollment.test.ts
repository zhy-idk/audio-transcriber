import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceEnrollmentControl,
  type TranscriptionApi,
} from '../../src/client';

class FakeElement {
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
  files: File[] | null = null;

  addEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((h) => h !== listener));
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  click(): void {
    for (const handler of this.listeners.get('click') ?? []) {
      handler({ currentTarget: this } as unknown as Event);
    }
  }

  dispatchInput(): void {
    for (const handler of this.listeners.get('input') ?? []) {
      handler({ currentTarget: this } as unknown as Event);
    }
  }

  dispatchChange(): void {
    for (const handler of this.listeners.get('change') ?? []) {
      handler({ currentTarget: this } as unknown as Event);
    }
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    const el = new FakeElement();
    el.type = tagName === 'button' ? 'button' : '';
    return el;
  }
}

describe('VoiceEnrollmentControl', () => {
  it('creates elements and starts in collapsed state', () => {
    const doc = new FakeDocument();
    const instance = createVoiceEnrollmentControl(doc as unknown as Document);

    expect(instance.root.id).toBe('voice-enrollment-section');
    expect(instance.elements.contentPanel.hidden).toBe(true);
    expect(instance.elements.toggleButton.textContent).toContain('Manage Voice Profiles');
    expect(instance.elements.enrollButton.disabled).toBe(true);
  });

  it('toggles expansion state when toggle button is clicked', () => {
    const doc = new FakeDocument();
    const instance = createVoiceEnrollmentControl(doc as unknown as Document);

    expect(instance.elements.contentPanel.hidden).toBe(true);

    instance.elements.toggleButton.click();
    expect(instance.elements.contentPanel.hidden).toBe(false);
    expect(instance.elements.toggleButton.textContent).toContain('Hide Profiles');

    instance.elements.toggleButton.click();
    expect(instance.elements.contentPanel.hidden).toBe(true);
  });

  it('loads and renders enrolled speakers', async () => {
    const doc = new FakeDocument();
    const api: TranscriptionApi = {
      create: vi.fn(),
      getStatus: vi.fn(),
      listSpeakers: vi.fn().mockResolvedValue(['Alice', 'Bob']),
      removeSpeaker: vi.fn().mockResolvedValue(true),
    };

    const instance = createVoiceEnrollmentControl(doc as unknown as Document, { api });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.listSpeakers).toHaveBeenCalled();
    expect(instance.control.enrolledSpeakers).toEqual(['Alice', 'Bob']);
    expect(instance.elements.speakersList.children).toHaveLength(2);
    expect(instance.elements.toggleButton.textContent).toContain('(2)');
  });

  it('removes a speaker when remove button is clicked', async () => {
    const doc = new FakeDocument();
    const api: TranscriptionApi = {
      create: vi.fn(),
      getStatus: vi.fn(),
      listSpeakers: vi.fn()
        .mockResolvedValueOnce(['Alice'])
        .mockResolvedValueOnce([]),
      removeSpeaker: vi.fn().mockResolvedValue(true),
    };

    const instance = createVoiceEnrollmentControl(doc as unknown as Document, { api });
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.elements.speakersList.children).toHaveLength(1);
    const chip = instance.elements.speakersList.children[0] as unknown as FakeElement;
    const removeBtn = chip?.children.find((c: FakeElement) => c.textContent === '✕');
    expect(removeBtn).toBeDefined();

    removeBtn?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.removeSpeaker).toHaveBeenCalledWith('Alice');
    expect(instance.elements.feedback.textContent).toContain('Removed speaker "Alice"');
  });

  it('enables enroll button when name and audio file are present, and successfully enrolls', async () => {
    const doc = new FakeDocument();
    const mockFile = { name: 'sample.wav', type: 'audio/wav' } as File;
    const api: TranscriptionApi = {
      create: vi.fn(),
      getStatus: vi.fn(),
      listSpeakers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['Charlie']),
      enrollSpeaker: vi.fn().mockResolvedValue({ status: 'enrolled', name: 'Charlie' }),
    };

    const instance = createVoiceEnrollmentControl(doc as unknown as Document, { api });
    await Promise.resolve();

    expect(instance.elements.enrollButton.disabled).toBe(true);

    // Enter name
    instance.elements.nameInput.value = 'Charlie';
    (instance.elements.nameInput as unknown as FakeElement).dispatchInput();
    expect(instance.elements.enrollButton.disabled).toBe(true);

    // Select file
    (instance.elements.fileInput as unknown as FakeElement).files = [mockFile];
    (instance.elements.fileInput as unknown as FakeElement).dispatchChange();
    expect(instance.elements.enrollButton.disabled).toBe(false);

    // Submit
    instance.elements.enrollButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.enrollSpeaker).toHaveBeenCalledWith('Charlie', mockFile);
    expect(instance.elements.feedback.textContent).toContain('Charlie" enrolled successfully');
    expect(instance.elements.nameInput.value).toBe('');
  });

  it('displays error feedback when enrollment fails', async () => {
    const doc = new FakeDocument();
    const mockFile = { name: 'sample.wav', type: 'audio/wav' } as File;
    const api: TranscriptionApi = {
      create: vi.fn(),
      getStatus: vi.fn(),
      listSpeakers: vi.fn().mockResolvedValue([]),
      enrollSpeaker: vi.fn().mockRejectedValue(new Error('Audio too short')),
    };

    const instance = createVoiceEnrollmentControl(doc as unknown as Document, { api });
    instance.elements.nameInput.value = 'David';
    (instance.elements.fileInput as unknown as FakeElement).files = [mockFile];
    (instance.elements.fileInput as unknown as FakeElement).dispatchChange();

    instance.elements.enrollButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.elements.feedback.textContent).toContain('Audio too short');
  });
});
