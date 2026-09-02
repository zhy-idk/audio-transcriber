import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE,
  TranscriptExporter,
} from '../../src/client/transcript-exporter';
import { createInitialClientState, startClientJob } from '../../src/client/state';
import { TranscriptViewer } from '../../src/client/transcript-viewer';

class PropertyTextNode {
  public readonly nodeType = 3;

  public constructor(public readonly data: string) {}
}

class PropertyClassList {
  public add(..._tokens: string[]): void {}
}

class PropertyElement {
  public readonly classList = new PropertyClassList();
  public readonly ownerDocument = {
    createTextNode: (value: string) => new PropertyTextNode(value),
  };
  public childNodes: PropertyTextNode[] = [];

  public setAttribute(_name: string, _value: string): void {}

  public replaceChildren(...nodes: PropertyTextNode[]): void {
    this.childNodes = nodes;
  }
}

const transcriptArbitrary = fc
  .tuple(
    fc.array(fc.fullUnicode(), { minLength: 0, maxLength: 24 }),
    fc.constantFrom('\n', '\r', '\r\n', '\n\r'),
    fc.constantFrom(' ', '  ', '\t', ' \t '),
    fc.constantFrom(
      '<script>alert("literal")</script>',
      '<img src=x onerror="alert(1)">',
      '<b>markup-like text</b>',
      'onclick="doNotRun()"',
    ),
    fc.string({ maxLength: 80 }),
  )
  .map(([prefix, lineBreak, whitespace, markup, suffix]) =>
    `${prefix.join('')}🎙️中${lineBreak}${whitespace}${markup}${lineBreak}${suffix}`,
  );

function completedState(transcriptText: string) {
  return startClientJob(createInitialClientState(), {
    jobId: 'property-job',
    status: 'completed',
    transcriptText,
  });
}

function renderedText(element: PropertyElement): string {
  return element.childNodes.map((node) => node.data).join('');
}

describe('Property 5: text download is a lossless UTF-8 transformation', () => {
  it('exports only completed transcripts exactly once and preserves viewer text on success or failure', async () => {
    // Feature: soniox-audio-transcription, Property 5: For every Unicode Transcript_Text value T, a transcript download produces exactly one file whose filename ends with .txt and whose UTF-8-decoded byte content equals T, including all characters and line breaks.
    let generatedCases = 0;

    await fc.assert(
      fc.asyncProperty(transcriptArbitrary, async (transcript) => {
        generatedCases += 1;
        const state = completedState(transcript);
        const stateBeforeExport = { ...state };
        const element = new PropertyElement();
        const viewer = new TranscriptViewer(element as unknown as HTMLElement);
        viewer.render(state);
        const viewerTextBeforeExport = renderedText(element);

        const downloads: Array<{ readonly blob: Blob; readonly filename: string }> = [];
        const exporter = new TranscriptExporter({} as Document, {
          download: (blob, filename) => downloads.push({ blob, filename }),
        });
        const queued = startClientJob(createInitialClientState(), {
          jobId: 'queued-job',
          status: 'queued',
        });
        const processing = startClientJob(createInitialClientState(), {
          jobId: 'processing-job',
          status: 'processing',
        });
        const failed = startClientJob(createInitialClientState(), {
          jobId: 'failed-job',
          status: 'failed',
          failureMessage: 'Transcription failed.',
        });

        expect(exporter.export(queued)).toEqual({ downloaded: false, failureMessage: null });
        expect(exporter.export(processing)).toEqual({ downloaded: false, failureMessage: null });
        expect(exporter.export(failed)).toEqual({ downloaded: false, failureMessage: null });
        expect(downloads).toHaveLength(0);

        expect(exporter.export(state)).toEqual({ downloaded: true, failureMessage: null });
        expect(downloads).toHaveLength(1);
        const download = downloads[0];
        expect(download).toBeDefined();
        if (download === undefined) return;

        expect(download.filename.endsWith('.txt')).toBe(true);
        expect(download.blob.type).toBe('text/plain;charset=utf-8');
        const bytes = new Uint8Array(await download.blob.arrayBuffer());
        expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(transcript)));
        expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(transcript);
        expect(renderedText(element)).toBe(viewerTextBeforeExport);
        expect(state).toEqual(stateBeforeExport);

        let failureAttempts = 0;
        const failures: string[] = [];
        const failingExporter = new TranscriptExporter({} as Document, {
          download: () => {
            failureAttempts += 1;
            throw new Error(`raw browser detail: ${transcript}`);
          },
          onFailure: (message) => failures.push(message),
        });
        const viewerTextBeforeFailure = renderedText(element);
        const failureResult = failingExporter.export(state);

        expect(failureAttempts).toBe(1);
        expect(failureResult).toEqual({
          downloaded: false,
          failureMessage: TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE,
        });
        expect(failingExporter.failureMessage).toBe(TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE);
        expect(failures).toEqual([TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE]);
        expect(renderedText(element)).toBe(viewerTextBeforeFailure);
        expect(state).toEqual(stateBeforeExport);
      }),
      { numRuns: 100 },
    );

    expect(generatedCases).toBeGreaterThanOrEqual(100);
  });
});
