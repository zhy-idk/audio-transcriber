import { describe, expect, it, vi } from 'vitest';

import {
  AUTOMATIC_LANGUAGE_DETECTION,
  type StatusUpdate,
} from '../../src/shared';
import {
  createTranscriptionPage,
  type StatusPollingController,
  type TranscriptionApi,
} from '../../src/client';

class FakeClassList {
  public readonly values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }
}

class FakeTextNode {
  public readonly nodeType = 3;

  constructor(public readonly data: string) {}
}

type FakeChild = FakeElement | FakeTextNode;

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, EventListener[]>();
  public readonly children: FakeElement[] = [];
  public readonly childNodes: FakeChild[] = [];
  public readonly style = { display: '' };
  public readonly ownerDocument: FakeDocument;
  public readonly tagName: string;
  public className = '';
  public hidden = false;
  public disabled = false;
  public id = '';
  public textContent: string | null = null;
  public htmlFor = '';
  public value = '';
  public type = '';
  public accept = '';
  public multiple = false;
  public tabIndex = 0;
  public files: File[] | null = null;
  public parentElement: FakeElement | null = null;

  constructor(document: FakeDocument, tagName: string) {
    this.ownerDocument = document;
    this.tagName = tagName;
  }

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
    const dispatchedEvent = {
      preventDefault: () => undefined,
      ...event,
      currentTarget: this,
    } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(dispatchedEvent);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: FakeChild[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement?.removeChild(node);
        node.parentElement = this;
        this.children.push(node);
      }
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes: FakeChild[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  removeChild(child: FakeElement): void {
    const childIndex = this.children.indexOf(child);
    if (childIndex >= 0) {
      this.children.splice(childIndex, 1);
    }
    const nodeIndex = this.childNodes.indexOf(child);
    if (nodeIndex >= 0) {
      this.childNodes.splice(nodeIndex, 1);
    }
    child.parentElement = null;
  }

  click(): void {
    this.dispatch('click');
  }
}

class FakeDocument {
  createElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K] {
    return new FakeElement(this, tagName) as unknown as HTMLElementTagNameMap[K];
  }

  createTextNode(value: string): Text {
    return new FakeTextNode(value) as unknown as Text;
  }
}

function browserFile(name = 'meeting.wav', type = 'audio/wav'): File {
  return { name, type } as File;
}

function pollingFake() {
  const callbacks: Array<{
    onUpdate: (update: StatusUpdate) => void;
    onError: (error: unknown) => void;
  }> = [];
  const polling = {
    start: vi.fn((_jobId: string, callback: (typeof callbacks)[number]) => {
      callbacks.push(callback);
    }),
    stop: vi.fn(),
    destroy: vi.fn(),
  } as unknown as StatusPollingController;
  return { polling, callbacks };
}

describe('TranscriptionPage', () => {
  it('composes idle, active, failed-safe, completed, export, and start-new workflow states', async () => {
    const document = new FakeDocument();
    const file = browserFile('réunion-🎙️.wav');
    const updates: StatusUpdate[] = [
      { jobId: 'job-1', status: 'queued' },
      { jobId: 'job-1', status: 'processing' },
      { jobId: 'job-1', status: 'completed', transcriptText: '<literal>\n第二行' },
    ];
    const api: TranscriptionApi = {
      create: vi.fn().mockResolvedValue(updates[0]),
      getStatus: vi.fn(),
    };
    const { polling, callbacks } = pollingFake();
    const page = createTranscriptionPage(document as unknown as Document, { api, polling });

    expect(page.elements.idleLayout.hidden).toBe(false);
    expect(page.elements.queuedLayout.hidden).toBe(true);
    expect(page.elements.processingLayout.hidden).toBe(true);
    expect(page.elements.failedLayout.hidden).toBe(true);
    expect(page.elements.completedLayout.hidden).toBe(true);
    expect(page.languageControl.control.value).toBe(AUTOMATIC_LANGUAGE_DETECTION);
    expect(page.voiceEnrollment).toBeDefined();
    expect(page.elements.voiceEnrollmentMount).toBeDefined();
    expect(page.uploadZone.elements.instructionElement.textContent).toBe(
      'Browse for or drag one audio file into this upload zone.',
    );
    expect(page.uploadZone.elements.fileInput.multiple).toBe(false);
    expect(page.elements.startButton.className).toContain('focus-visible:outline-secondary');
    expect(page.elements.startButton.disabled).toBe(true);

    page.uploadZone.controller.selectFiles([file]);
    expect(page.elements.startButton.disabled).toBe(false);
    page.elements.startButton.click();
    await Promise.resolve();

    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create).toHaveBeenCalledWith(file, AUTOMATIC_LANGUAGE_DETECTION);
    expect(page.state.status).toBe('queued');
    expect(page.elements.queuedLayout.hidden).toBe(false);
    expect(page.elements.processingLayout.hidden).toBe(true);
    expect(page.languageControl.control.disabled).toBe(true);
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.onUpdate(updates[1]!);
    expect(page.elements.processingLayout.hidden).toBe(false);
    expect(page.elements.queuedLayout.hidden).toBe(true);
    expect(page.statusRegion.elements.statusLabel.textContent).toBe('Processing');
    expect(page.statusRegion.elements.processingIndicator.hidden).toBe(false);

    callbacks[0]?.onUpdate({
      jobId: 'job-1',
      status: 'failed',
    } as StatusUpdate);
    expect(page.elements.failedLayout.hidden).toBe(false);
    expect(page.statusRegion.elements.statusLabel.textContent).toBe('Failed');
    expect(page.statusRegion.elements.failureMessage.textContent).toBe('Failure details are unavailable.');
    expect(page.statusRegion.elements.startNewButton.hidden).toBe(false);
    expect(page.languageControl.control.disabled).toBe(false);

    // A fresh completed run renders literal transcript text and enables export.
    page.statusRegion.elements.startNewButton.click();
    page.uploadZone.controller.selectFiles([file]);
    (api.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updates[2]);
    page.elements.startButton.click();
    await Promise.resolve();

    expect(page.elements.completedLayout.hidden).toBe(false);
    expect(page.viewer).toBeDefined();
    expect(page.elements.transcriptViewerMount.childNodes).toHaveLength(1);
    expect((page.elements.transcriptViewerMount.childNodes[0] as unknown as FakeTextNode).data).toBe('<literal>\n第二行');
    expect(page.elements.downloadButton.hidden).toBe(false);
    expect(page.elements.downloadButton.disabled).toBe(false);
    expect(page.elements.completedStartNewButton.hidden).toBe(false);

    page.elements.completedStartNewButton.click();
    expect(page.state.status).toBe('idle');
    expect(page.elements.idleLayout.hidden).toBe(false);
    expect(page.elements.completedLayout.hidden).toBe(true);
    expect(page.elements.transcriptViewerMount.childNodes).toHaveLength(0);
    expect(page.elements.startButton.disabled).toBe(true);

    page.destroy();
    expect(polling.stop).toHaveBeenCalled();
  });
});
