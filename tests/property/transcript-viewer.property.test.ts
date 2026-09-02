import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TranscriptViewer,
  type TranscriptViewerState,
} from '../../src/client/transcript-viewer';

class LocalTextNode {
  public readonly nodeType = 3;
  public readonly nodeName = '#text';
  public readonly textContent: string;

  public constructor(public readonly data: string) {
    this.textContent = data;
  }
}

class LocalClassList {
  public readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }
}

class LocalDocument {
  public createTextNodeCalls = 0;
  public readonly createdElementNames: string[] = [];

  public createTextNode(value: string): LocalTextNode {
    this.createTextNodeCalls += 1;
    return new LocalTextNode(value);
  }

  public createElement(tagName: string): never {
    this.createdElementNames.push(tagName);
    throw new Error('HTML element creation is not permitted in this local DOM');
  }
}

/**
 * A deliberately small DOM fake that makes HTML insertion observable and
 * rejects element creation. The property therefore exercises only the local
 * text-node path rather than a browser or a test-only HTML parser.
 */
class LocalElement {
  public readonly classList = new LocalClassList();
  public readonly attributes = new Map<string, string>();
  public readonly ownerDocument = new LocalDocument();
  public childNodes: LocalTextNode[] = [];
  public unsafeMarkupAssignments = 0;

  public set innerHTML(_value: string) {
    this.unsafeMarkupAssignments += 1;
    throw new Error('HTML insertion is not permitted in this local DOM');
  }

  public insertAdjacentHTML(_position: string, _html: string): never {
    this.unsafeMarkupAssignments += 1;
    throw new Error('HTML insertion is not permitted in this local DOM');
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public replaceChildren(...nodes: LocalTextNode[]): void {
    this.childNodes = nodes;
  }
}

const unicodeFragmentArbitrary = fc
  .array(fc.fullUnicode(), { minLength: 0, maxLength: 64 })
  .map((codePoints) => codePoints.join(''));

const lineBreaksArbitrary = fc
  .array(fc.constantFrom('\n', '\r', '\r\n', '\u2028', '\u2029'), { minLength: 1, maxLength: 8 })
  .map((lineBreaks) => lineBreaks.join(''));

const whitespaceArbitrary = fc
  .array(fc.constantFrom(' ', '\t', '\v', '\f', '\u00a0', '\u2003', '\u3000'), {
    minLength: 1,
    maxLength: 12,
  })
  .map((whitespace) => whitespace.join(''));

const markupLikeArbitrary = fc.constantFrom(
  '<script>alert("not executable")</script>',
  '<img src=x onerror="alert(1)">',
  '<div data-value="&amp;">literal</div>',
  'onclick="alert(1)"',
  '</textarea><script>bad()</script>',
  '&lt;not-an-element&gt;',
);

const transcriptArbitrary = fc
  .record({
    prefix: unicodeFragmentArbitrary,
    lineBreaks: lineBreaksArbitrary,
    whitespace: whitespaceArbitrary,
    markup: markupLikeArbitrary,
    suffix: unicodeFragmentArbitrary,
  })
  .map(({ prefix, lineBreaks, whitespace, markup, suffix }) =>
    `${prefix}${lineBreaks}${whitespace}${markup}${suffix}`,
  );

function viewerState(
  activeJobId: string,
  status: TranscriptViewerState['status'],
  transcriptText: string | null,
): TranscriptViewerState {
  return { activeJobId, status, transcriptText };
}

const requiredViewerClasses = [
  'min-w-0',
  'max-w-full',
  'overflow-hidden',
  'whitespace-pre-wrap',
  'break-words',
] as const;

describe('Property 4: transcript rendering preserves text without executing markup', () => {
  it('renders generated Unicode text literally, clears stale jobs, and remains overflow-safe', () => {
    // Feature: soniox-audio-transcription, Property 4: For every Unicode transcript string T, including markup-like text and every supported line-break sequence, rendering T for a completed active job produces visible text exactly equal to T, preserves each line break, and creates no executable element, event handler, or script content from characters in T.
    // **Validates: Requirements 5.1, 5.2.**
    fc.assert(
      fc.property(transcriptArbitrary, transcriptArbitrary, (transcript, replacementTranscript) => {
        const element = new LocalElement();
        const viewer = new TranscriptViewer(element as unknown as HTMLElement);

        for (const className of requiredViewerClasses) {
          expect(element.classList.values.has(className)).toBe(true);
        }

        viewer.render(viewerState('old-job', 'completed', transcript));

        expect(element.childNodes).toHaveLength(1);
        expect(element.childNodes[0]?.nodeType).toBe(3);
        expect(element.childNodes[0]?.nodeName).toBe('#text');
        expect(element.childNodes[0]?.data).toBe(transcript);
        expect(element.childNodes[0]?.textContent).toBe(transcript);
        expect(element.ownerDocument.createTextNodeCalls).toBe(1);
        expect(element.ownerDocument.createdElementNames).toEqual([]);
        expect(element.unsafeMarkupAssignments).toBe(0);
        expect(element.childNodes.every((node) => node.nodeType === 3)).toBe(true);

        for (const nonCompletedStatus of ['idle', 'queued', 'processing', 'failed'] as const) {
          viewer.render(viewerState('new-job', nonCompletedStatus, null));
          expect(element.childNodes).toHaveLength(0);
        }

        viewer.render(viewerState('new-job', 'completed', replacementTranscript));
        expect(element.childNodes).toHaveLength(1);
        expect(element.childNodes[0]?.nodeType).toBe(3);
        expect(element.childNodes[0]?.data).toBe(replacementTranscript);
        expect(element.childNodes[0]?.data).not.toBe(transcript);
        expect(element.ownerDocument.createdElementNames).toEqual([]);
        expect(element.unsafeMarkupAssignments).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
