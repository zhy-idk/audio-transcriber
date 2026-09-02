import { describe, expect, it } from 'vitest';

import { TranscriptViewer } from '../../src/client/transcript-viewer';
import { createInitialClientState, startClientJob } from '../../src/client/state';

class FakeTextNode {
  public readonly nodeType = 3;

  public constructor(public readonly data: string) {}
}

class FakeClassList {
  public readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly attributes = new Map<string, string>();
  public readonly ownerDocument = {
    createTextNode: (value: string) => new FakeTextNode(value),
  };
  public childNodes: FakeTextNode[] = [];
  public replaceChildrenCallCount = 0;

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public replaceChildren(...nodes: FakeTextNode[]): void {
    this.replaceChildrenCallCount += 1;
    this.childNodes = nodes;
  }
}

function completedState(jobId: string, transcriptText: string) {
  return startClientJob(createInitialClientState(), {
    jobId,
    status: 'completed',
    transcriptText,
  });
}

describe('TranscriptViewer', () => {
  it('renders completed transcript as one literal text node with Unicode and line breaks intact', () => {
    const element = new FakeElement();
    const viewer = new TranscriptViewer(element as unknown as HTMLElement);
    const transcript = 'Réunion 🎙️\r\n<script>alert("not executable")</script>\n最後';

    viewer.render(completedState('job-1', transcript));

    expect(element.childNodes).toHaveLength(1);
    expect(element.childNodes[0]?.nodeType).toBe(3);
    expect(element.childNodes[0]?.data).toBe(transcript);
    expect(element.attributes.get('role')).toBe('region');
    expect(element.attributes.get('aria-label')).toBe('Transcript');
  });

  it('uses whitespace-preserving and overflow-safe Tailwind classes', () => {
    const element = new FakeElement();
    new TranscriptViewer(element as unknown as HTMLElement);

    expect(element.classList.values).toEqual(
      new Set([
        'min-w-0',
        'max-w-full',
        'overflow-hidden',
        'whitespace-pre-wrap',
        'break-words',
        'font-inter',
        'text-body-md',
        'text-on-surface',
      ]),
    );
  });

  it('clears prior transcript when a new job starts or the active job is not completed', () => {
    const element = new FakeElement();
    const viewer = new TranscriptViewer(element as unknown as HTMLElement);
    const completed = completedState('old-job', 'old transcript');

    viewer.render(completed);
    expect(element.childNodes[0]?.data).toBe('old transcript');

    viewer.render({ ...completed, activeJobId: 'new-job', status: 'queued', transcriptText: null });
    expect(element.childNodes).toHaveLength(0);

    viewer.render({ ...completed, activeJobId: 'new-job', status: 'processing', transcriptText: null });
    expect(element.childNodes).toHaveLength(0);

    viewer.render({ ...completed, activeJobId: 'new-job', status: 'failed', transcriptText: null });
    expect(element.childNodes).toHaveLength(0);
  });
});
