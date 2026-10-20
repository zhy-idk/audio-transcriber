import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import * as esbuild from 'esbuild';

import {
  AUTOMATIC_LANGUAGE_DETECTION,
  type StatusUpdate,
} from '../../src/shared';
import {
  createTranscriptionPage,
  TranscriptExporter,
  type StatusPollingController,
  type TranscriptionApi,
} from '../../src/client';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

class FakeClassList {
  public readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  public remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }

  public contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeTextNode {
  public readonly nodeType = 3;

  public constructor(public readonly data: string) {}
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
  public clickCount = 0;

  public constructor(document: FakeDocument, tagName: string) {
    this.ownerDocument = document;
    this.tagName = tagName;
  }

  public addEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((handler) => handler !== listener));
  }

  public dispatch(type: string, event: Record<string, unknown> = {}): void {
    const dispatchedEvent = {
      preventDefault: () => undefined,
      ...event,
      currentTarget: this,
    } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(dispatchedEvent);
    }
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public append(...nodes: FakeChild[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement?.removeChild(node);
        node.parentElement = this;
        this.children.push(node);
      }
      this.childNodes.push(node);
    }
  }

  public replaceChildren(...nodes: FakeChild[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  public removeChild(child: FakeElement): void {
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

  public click(): void {
    this.clickCount += 1;
    this.dispatch('click');
  }
}

class FakeDocument {
  public createElement<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K] {
    return new FakeElement(this, tagName) as unknown as HTMLElementTagNameMap[K];
  }

  public createTextNode(value: string): Text {
    return new FakeTextNode(value) as unknown as Text;
  }
}

function audioFile(name = 'meeting.wav'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/wav' });
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

function visibleLayouts(page: ReturnType<typeof createTranscriptionPage>): string[] {
  const layouts: Array<readonly [string, HTMLElement]> = [
    ['idle', page.elements.idleLayout],
    ['queued', page.elements.queuedLayout],
    ['processing', page.elements.processingLayout],
    ['failed', page.elements.failedLayout],
    ['completed', page.elements.completedLayout],
  ];
  return layouts
    .filter(([, layout]) => !layout.hidden)
    .map(([name]) => name);
}

function fakeElement(element: Element): FakeElement {
  return element as unknown as FakeElement;
}

function textNodeData(page: ReturnType<typeof createTranscriptionPage>): string {
  const node = page.elements.transcriptViewerMount.childNodes[0];
  return node instanceof FakeTextNode ? node.data : '';
}

let devServer: ViteDevServer | undefined;
let previewUrl = '';

describe('browser preview and complete page workflow', () => {
  beforeAll(async () => {
    devServer = await createServer({
      appType: 'spa',
      configFile: false,
      logLevel: 'silent',
      root: projectRoot,
      server: { host: '127.0.0.1', port: 0 },
    });
    await devServer.listen();
    previewUrl = devServer.resolvedUrls?.local[0] ?? '';
  });

  afterAll(async () => {
    await devServer?.close();
    devServer = undefined;
    await esbuild.stop();
  });

  it('serves the local preview entry, client module, and Tailwind stylesheet without external requests', async () => {
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    const [htmlResponse, moduleResponse, stylesheetResponse] = await Promise.all([
      fetch(previewUrl),
      fetch(new URL('/src/client/main.ts', previewUrl)),
      fetch(new URL('/src/client/styles.css', previewUrl)),
    ]);
    const html = await htmlResponse.text();
    const module = await moduleResponse.text();
    const stylesheet = await stylesheetResponse.text();

    expect(htmlResponse.ok).toBe(true);
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('/src/client/main.ts');
    expect(moduleResponse.ok).toBe(true);
    expect(module).toContain('createTranscriptionPage');
    expect(stylesheetResponse.ok).toBe(true);
    expect(stylesheet).toContain('outline-offset');
    expect(stylesheet).toContain('2px');
  });

  it('covers keyboard-facing upload, complete lifecycle, safe export, and responsive layout contracts', async () => {
    const document = new FakeDocument();
    const file = audioFile('réunion-🎙️.wav');
    const transcript = '<script>alert("literal")</script>\r\n第二行\nemoji 🎙️';
    const updates: StatusUpdate[] = [
      { jobId: 'job-complete', status: 'queued' },
      { jobId: 'job-complete', status: 'processing' },
      { jobId: 'job-complete', status: 'completed', transcriptText: transcript },
    ];
    const api: TranscriptionApi = {
      create: vi.fn().mockResolvedValue(updates[0]),
      getStatus: vi.fn(),
    };
    const { polling, callbacks } = pollingFake();
    const downloads: Array<{ blob: Blob; filename: string }> = [];
    const exporter = new TranscriptExporter(document as unknown as Document, {
      download: (blob, filename) => downloads.push({ blob, filename }),
    });
    const page = createTranscriptionPage(document as unknown as Document, {
      api,
      exporter,
      polling,
    });

    expect(visibleLayouts(page)).toEqual(['idle']);
    expect(page.uploadZone.elements.instructionElement.textContent).toBe(
      'Browse for or drag one audio file into this upload zone.',
    );
    expect(page.uploadZone.elements.fileInput.accept).toBe('audio/*');
    expect(page.uploadZone.elements.fileInput.multiple).toBe(false);
    expect(page.languageControl.control.value).toBe(AUTOMATIC_LANGUAGE_DETECTION);
    expect(page.elements.startButton.disabled).toBe(true);

    expect(fakeElement(page.uploadZone.elements.root).attributes.get('role')).toBe('group');
    expect(fakeElement(page.uploadZone.elements.root).attributes.get('aria-label')).toBe('Audio file upload');
    expect(fakeElement(page.uploadZone.elements.fileInput).attributes.get('aria-label')).toBe('Browse for an audio file');
    expect(page.languageControl.elements.label.htmlFor).toBe('language-preference');
    expect(fakeElement(page.languageControl.elements.select).attributes.get('aria-label')).toBe('Source language');
    expect(page.elements.startButton.className).toContain('focus-visible:outline-2');
    expect(page.elements.startButton.className).toContain('outline-offset-focus');
    expect(page.elements.startButton.className).toContain('focus-visible:outline-secondary');

    page.uploadZone.elements.browseButton.click();
    const fileInput = fakeElement(page.uploadZone.elements.fileInput);
    expect(fileInput.clickCount).toBe(1);
    fileInput.files = [file];
    fileInput.dispatch('change');
    expect(page.uploadZone.controller.selectedFile).toBe(file);
    expect(page.uploadZone.elements.filenameElement.textContent).toBe(file.name);
    expect(page.elements.startButton.disabled).toBe(false);

    page.elements.startButton.click();
    await Promise.resolve();
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create).toHaveBeenCalledWith(file, AUTOMATIC_LANGUAGE_DETECTION);
    expect(page.state.status).toBe('queued');
    expect(visibleLayouts(page)).toEqual(['queued']);
    expect(page.languageControl.control.disabled).toBe(true);
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.onUpdate(updates[1]!);
    expect(visibleLayouts(page)).toEqual(['processing']);
    expect(page.statusRegion.elements.statusLabel.textContent).toBe('Processing');
    expect(page.statusRegion.elements.processingIndicator.hidden).toBe(false);
    expect(fakeElement(page.statusRegion.elements.processingIndicator).attributes.get('aria-hidden')).toBe('true');
    expect(fakeElement(page.statusRegion.elements.root).attributes.get('role')).toBe('status');
    expect(fakeElement(page.statusRegion.elements.root).attributes.get('aria-live')).toBe('polite');
    expect(fakeElement(page.statusRegion.elements.root).attributes.get('aria-atomic')).toBe('true');
    expect(page.languageControl.control.disabled).toBe(true);

    callbacks[0]?.onUpdate(updates[2]!);
    expect(visibleLayouts(page)).toEqual(['completed']);
    expect(page.state.status).toBe('completed');
    expect(page.languageControl.control.disabled).toBe(false);
    expect(textNodeData(page)).toBe(transcript);
    expect(page.elements.downloadButton.hidden).toBe(false);
    expect(page.elements.downloadButton.disabled).toBe(false);
    expect(page.elements.transcriptViewerMount.className).toContain('overflow-hidden');
    expect(page.elements.transcriptViewerMount.className).toContain('min-w-0');

    page.elements.downloadButton.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.filename).toMatch(/\.txt$/u);
    await expect(downloads[0]?.blob.text()).resolves.toBe(transcript);
    expect(textNodeData(page)).toBe(transcript);

    page.elements.completedStartNewButton.click();
    expect(visibleLayouts(page)).toEqual(['idle']);
    expect(page.state.activeJobId).toBeNull();
    expect(page.languageControl.control.disabled).toBe(false);
    expect(page.elements.transcriptViewerMount.childNodes).toHaveLength(0);
    page.destroy();
  });

  it('covers drag/drop, failure recovery, live failure semantics, and overflow-safe responsive classes', async () => {
    const document = new FakeDocument();
    const file = audioFile('dragged.wav');
    const api: TranscriptionApi = {
      create: vi.fn().mockResolvedValue({ jobId: 'job-failed', status: 'queued' }),
      getStatus: vi.fn(),
    };
    const { polling, callbacks } = pollingFake();
    const page = createTranscriptionPage(document as unknown as Document, { api, polling });

    const dropPrevented = vi.fn();
    fakeElement(page.uploadZone.elements.dropZone).dispatch('drop', {
      preventDefault: dropPrevented,
      dataTransfer: { files: [file] },
    });
    expect(dropPrevented).toHaveBeenCalledOnce();
    expect(page.uploadZone.controller.selectedFile).toBe(file);
    expect(page.elements.startButton.disabled).toBe(false);

    page.elements.startButton.click();
    await Promise.resolve();
    expect(page.languageControl.control.disabled).toBe(true);
    callbacks[0]?.onUpdate({
      jobId: 'job-failed',
      status: 'failed',
      failureMessage: 'Provider submission failed.',
    });

    expect(visibleLayouts(page)).toEqual(['failed']);
    expect(page.statusRegion.elements.statusLabel.textContent).toBe('Failed');
    expect(page.statusRegion.elements.failureMessage.textContent).toBe('Provider submission failed.');
    expect(page.statusRegion.elements.failureMessage.hidden).toBe(false);
    expect(fakeElement(page.statusRegion.elements.failureMessage).attributes.get('data-failure-message')).toBe('true');
    expect(page.statusRegion.elements.startNewButton.hidden).toBe(false);
    expect(page.statusRegion.elements.startNewButton.disabled).toBe(false);
    expect(fakeElement(page.statusRegion.elements.startNewButton).attributes.get('aria-describedby')).toBe('transcription-failure-message');
    expect(page.languageControl.control.disabled).toBe(false);

    page.statusRegion.elements.startNewButton.click();
    expect(visibleLayouts(page)).toEqual(['idle']);
    expect(page.uploadZone.controller.selectedFile).toBeNull();
    expect(page.elements.startButton.disabled).toBe(true);

    const grid = page.root.children[0];
    const shell = grid?.children[0];
    expect(page.root.className).toContain('overflow-x-clip');
    expect(page.root.className).toContain('min-w-0');
    expect(grid?.className).toContain('grid-cols-1');
    expect(grid?.className).toContain('md:grid-cols-12');
    expect(shell?.className).toContain('w-full');
    expect(shell?.className).toContain('min-w-0');
    expect(shell?.className).toContain('overflow-hidden');
    expect(page.elements.transcriptViewerMount.className).toContain('w-full');
    expect(page.elements.transcriptViewerMount.className).toContain('max-w-full');
    expect(page.elements.transcriptViewerMount.className).toContain('overflow-hidden');
    page.destroy();
  });
});
