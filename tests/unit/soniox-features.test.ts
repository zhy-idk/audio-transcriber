import { describe, expect, it, vi } from 'vitest';
import {
  AUTOMATIC_LANGUAGE_DETECTION,
  computeConfidenceScore,
  formatDiarizedTranscript,
  isStatusUpdate,
  normalizeTranscriptionSettings,
  serializeTranscriptionSettings,
  type AcceptedAudioFile,
  type StatusUpdate,
  type TranscriptToken,
} from '../../src/shared';
import { SonioxApiGateway } from '../../src/server/soniox-api';
import type { SonioxCredential, SonioxProviderHandle } from '../../src/server/soniox';
import { createTranscriptionPage } from '../../src/client';
import type { TranscriptionApi } from '../../src/client/transcription-api';

const credential = 'test-soniox-key' as SonioxCredential;

function createAudioFile(name = 'sample.wav'): AcceptedAudioFile {
  const file = new Blob(['sample audio bytes'], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: name });
  return file as AcceptedAudioFile;
}

describe('Soniox Feature Helpers', () => {
  it('normalizes string and JSON transcription settings', () => {
    expect(normalizeTranscriptionSettings(AUTOMATIC_LANGUAGE_DETECTION)).toEqual({
      languagePreference: AUTOMATIC_LANGUAGE_DETECTION,
      languageHints: [],
      enableDiarization: false,
      contextTerms: [],
      contextText: undefined,
    });

    expect(normalizeTranscriptionSettings('en')).toEqual({
      languagePreference: 'en',
      languageHints: ['en'],
      enableDiarization: false,
      contextTerms: [],
      contextText: undefined,
    });

    const structured = {
      languagePreference: 'en',
      languageHints: ['en', 'tl', 'es'],
      enableDiarization: true,
      contextTerms: ['Soniox', 'Speech'],
      contextText: 'Meeting on AI speech recognition',
    };
    const serialized = serializeTranscriptionSettings(structured);
    expect(normalizeTranscriptionSettings(serialized)).toEqual(structured);
  });

  it('formats diarized tokens into speaker paragraphs', () => {
    const tokens: TranscriptToken[] = [
      { text: 'Hello', speaker: '1', confidence: 0.98 },
      { text: ' world,', speaker: '1', confidence: 0.95 },
      { text: ' how', speaker: '1', confidence: 0.92 },
      { text: ' are', speaker: '1', confidence: 0.96 },
      { text: ' you?', speaker: '1', confidence: 0.99 },
      { text: 'I', speaker: '2', confidence: 0.94 },
      { text: ' am', speaker: '2', confidence: 0.97 },
      { text: ' doing', speaker: '2', confidence: 0.91 },
      { text: ' well.', speaker: '2', confidence: 0.98 },
    ];

    const formatted = formatDiarizedTranscript(tokens);
    expect(formatted).toBe('Speaker 1: Hello world, how are you?\n\nSpeaker 2: I am doing well.');

    const namedTokens: TranscriptToken[] = [
      { text: 'Hello', speaker: 'Alice' },
      { text: ' there.', speaker: 'Alice' },
      { text: 'Hey', speaker: 'Bob' },
      { text: ' Alice!', speaker: 'Bob' },
    ];
    expect(formatDiarizedTranscript(namedTokens)).toBe('Alice: Hello there.\n\nBob: Hey Alice!');

    const timestampedTokens: TranscriptToken[] = [
      { text: 'Hello', speaker: 'Alice', startMs: 1200, endMs: 1800 },
      { text: ' there.', speaker: 'Alice', startMs: 1850, endMs: 2500 },
      { text: 'Hey', speaker: 'Bob', startMs: 3100, endMs: 3500 },
      { text: ' Alice!', speaker: 'Bob', startMs: 3600, endMs: 4200 },
    ];
    expect(formatDiarizedTranscript(timestampedTokens, { includeTimestamps: true })).toBe(
      '[00:01 - 00:02] Alice: Hello there.\n\n[00:03 - 00:04] Bob: Hey Alice!',
    );
  });

  it('computes confidence score as rounded average', () => {
    const tokens: TranscriptToken[] = [
      { text: 'Word1', confidence: 0.9 },
      { text: 'Word2', confidence: 0.8 },
      { text: 'Word3', confidence: null },
      { text: 'Word4', confidence: 1.0 },
    ];

    // (0.9 + 0.8 + 1.0) / 3 = 0.9
    expect(computeConfidenceScore(tokens)).toBe(0.9);

    expect(computeConfidenceScore([])).toBeNull();
    expect(computeConfidenceScore([{ text: 'NoScore', confidence: null }])).toBeNull();
  });

  it('validates completed StatusUpdate with confidenceScore and tokens', () => {
    const update = {
      jobId: 'job-1',
      status: 'completed' as const,
      transcriptText: 'Speaker 1: Hi',
      confidenceScore: 0.94,
      tokens: [{ text: 'Hi', confidence: 0.94, speaker: '1' }],
    };

    expect(isStatusUpdate(update)).toBe(true);

    // Private field rejection
    expect(isStatusUpdate({ ...update, credential: 'secret' })).toBe(false);
  });
});

describe('SonioxApiGateway with Diarization, Language Hints, Context, and Confidence', () => {
  it('sends diarization, language hints, and context in Soniox create request', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/files')) {
        return new Response(JSON.stringify({ id: 'file-123' }), { status: 200 });
      }
      if (url.endsWith('/transcriptions')) {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: 'soniox-job-456', status: 'queued' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const gateway = new SonioxApiGateway({ fetchImplementation });
    const settings = serializeTranscriptionSettings({
      languagePreference: 'en',
      languageHints: ['en', 'tl', 'es'],
      enableDiarization: true,
      contextTerms: ['Soniox', 'MedicalTerm'],
      contextText: 'Clinical discussion',
    });

    const result = await gateway.submit(
      { file: createAudioFile(), settings },
      credential,
    );

    expect(result.providerHandle).toBe('soniox-job-456');
    expect(result.outcome.status).toBe('queued');
    expect(capturedBody).toEqual({
      model: 'stt-async-v5',
      file_id: 'file-123',
      enable_speaker_diarization: true,
      language_hints: ['en', 'tl', 'es'],
      context: {
        terms: ['Soniox', 'MedicalTerm'],
        text: 'Clinical discussion',
      },
    });
  });

  it('fetches transcript, computes confidence, and formats diarized speakers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/status') || url.endsWith('/soniox-job-456')) {
        return new Response(JSON.stringify({ id: 'soniox-job-456', status: 'completed' }), { status: 200 });
      }
      if (url.endsWith('/soniox-job-456/transcript')) {
        return new Response(
          JSON.stringify({
            text: 'Hello world',
            tokens: [
              { text: 'Hello', speaker: '1', confidence: 0.98, start_ms: 0, end_ms: 400 },
              { text: ' world', speaker: '1', confidence: 0.92, start_ms: 450, end_ms: 800 },
              { text: 'Good', speaker: '2', confidence: 0.75, start_ms: 900, end_ms: 1200 },
              { text: ' morning', speaker: '2', confidence: 0.95, start_ms: 1250, end_ms: 1600 },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const gateway = new SonioxApiGateway({ fetchImplementation });
    const outcome = await gateway.refresh('soniox-job-456' as SonioxProviderHandle, credential);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.transcriptText).toBe('Speaker 1: Hello world\n\nSpeaker 2: Good morning');
      expect(outcome.confidenceScore).toBe(0.9); // (0.98+0.92+0.75+0.95)/4 = 0.9
      expect(outcome.tokens).toHaveLength(4);
    }
  });
});

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
  public checked = false;
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
      type,
      currentTarget: this,
    } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(dispatchedEvent);
    }
  }

  dispatchEvent(event: { type: string }): boolean {
    this.dispatch(event.type, event as Record<string, unknown>);
    return true;
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

describe('TranscriptionPage Controls and UI for Soniox Features', () => {
  it('manages language hints, diarization, and context controls and presents confidence badges', async () => {
    const document = new FakeDocument() as unknown as Document;
    const file = createAudioFile('test.wav');
    const api: TranscriptionApi = {
      create: vi.fn().mockResolvedValue({
        jobId: 'job-999',
        status: 'completed' as const,
        transcriptText: 'Speaker 1: Welcome to Soniox.',
        confidenceScore: 0.94,
        tokens: [
          { text: 'Welcome', confidence: 0.98, speaker: '1' },
          { text: ' to', confidence: 0.96, speaker: '1' },
          { text: ' Soniox.', confidence: 0.72, speaker: '1' },
        ],
      }),
      getStatus: vi.fn(),
    };

    const page = createTranscriptionPage(document, { api });

    // Initial controls are present and enabled
    expect(page.elements.languageHintsInput.disabled).toBe(false);
    expect(page.elements.diarizationCheckbox.disabled).toBe(false);
    expect(page.elements.contextTermsInput.disabled).toBe(false);
    expect(page.elements.contextTextInput.disabled).toBe(false);

    // Fill settings
    page.elements.languageHintsInput.value = 'en, tl';
    page.elements.languageHintsInput.dispatchEvent(new Event('input'));
    page.elements.diarizationCheckbox.checked = true;
    page.elements.diarizationCheckbox.dispatchEvent(new Event('change'));
    page.elements.contextTermsInput.value = 'Soniox, AI';
    page.elements.contextTermsInput.dispatchEvent(new Event('input'));
    page.elements.contextTextInput.value = 'Discussion on AI audio transcription';
    page.elements.contextTextInput.dispatchEvent(new Event('input'));

    // Select file and start
    page.uploadZone.controller.selectFiles([file]);
    page.elements.startButton.click();
    await Promise.resolve();

    // Verify api.create received serialized structured settings
    expect(api.create).toHaveBeenCalledOnce();
    const passedSettings = vi.mocked(api.create).mock.calls[0]?.[1] as string;
    const parsed = normalizeTranscriptionSettings(passedSettings);
    expect(parsed.enableDiarization).toBe(true);
    expect(parsed.languageHints).toEqual(['en', 'tl']);
    expect(parsed.contextTerms).toEqual(['Soniox', 'AI']);
    expect(parsed.contextText).toBe('Discussion on AI audio transcription');

    // Completed state displays confidence badge and low-confidence warning
    expect(page.state.status).toBe('completed');
    expect(page.elements.confidenceBadge.hidden).toBe(false);
    expect(page.elements.confidenceBadge.textContent).toBe('Confidence: 94%');
    expect(page.elements.lowConfidenceReview.hidden).toBe(false);
    expect(page.elements.lowConfidenceReview.textContent).toContain('Soniox');
    expect(page.elements.lowConfidenceReview.textContent).toContain('72%');

    // Viewer displays diarized text
    expect((page.elements.transcriptViewerMount.childNodes[0] as unknown as FakeTextNode).data).toBe('Speaker 1: Welcome to Soniox.');

    // Starting new transcription clears controls
    page.elements.completedStartNewButton.click();
    expect(page.state.status).toBe('idle');
    expect(page.elements.languageHintsInput.value).toBe('');
    expect(page.elements.diarizationCheckbox.checked).toBe(false);
    expect(page.elements.contextTermsInput.value).toBe('');
    expect(page.elements.contextTextInput.value).toBe('');
    expect(page.elements.confidenceBadge.hidden).toBe(true);

    page.destroy();
  });
});
