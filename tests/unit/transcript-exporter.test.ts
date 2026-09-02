import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE,
  TranscriptExporter,
} from '../../src/client/transcript-exporter';
import { createInitialClientState, startClientJob } from '../../src/client/state';
import { TranscriptViewer } from '../../src/client/transcript-viewer';

class FakeTextNode {
  public readonly nodeType = 3;

  public constructor(public readonly data: string) {}
}

class FakeClassList {
  public add(..._tokens: string[]): void {}
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly ownerDocument = {
    createTextNode: (value: string) => new FakeTextNode(value),
  };
  public childNodes: FakeTextNode[] = [];

  public setAttribute(_name: string, _value: string): void {}

  public replaceChildren(...nodes: FakeTextNode[]): void {
    this.childNodes = nodes;
  }
}

function completedState(transcriptText: string) {
  return startClientJob(createInitialClientState(), {
    jobId: 'job-1',
    status: 'completed',
    transcriptText,
  });
}

describe('TranscriptExporter', () => {
  it('creates one UTF-8 text download from the exact completed transcript', async () => {
    const downloads: Array<{ blob: Blob; filename: string }> = [];
    const transcript = 'Réunion 🎙️\r\n<script>literal</script>\n最後';
    const exporter = new TranscriptExporter({} as Document, {
      download: (blob, filename) => downloads.push({ blob, filename }),
    });

    const result = exporter.export(completedState(transcript));

    expect(result).toEqual({ downloaded: true, failureMessage: null });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.filename).toBe('transcript.txt');
    expect(downloads[0]?.blob.type).toBe('text/plain;charset=utf-8');

    const encodedTranscript = new TextEncoder().encode(transcript);
    const downloadedBytes = new Uint8Array(await downloads[0]!.blob.arrayBuffer());
    expect(Array.from(downloadedBytes)).toEqual(Array.from(encodedTranscript));
    await expect(downloads[0]?.blob.text()).resolves.toBe(transcript);
  });

  it('does not download until the active job is completed with transcript text', () => {
    const downloads: Blob[] = [];
    const exporter = new TranscriptExporter({} as Document, {
      download: (blob) => downloads.push(blob),
    });
    const initial = createInitialClientState();
    const queued = startClientJob(initial, { jobId: 'job-1', status: 'queued' });
    const processing = startClientJob(initial, { jobId: 'job-2', status: 'processing' });
    const failed = startClientJob(initial, {
      jobId: 'job-3',
      status: 'failed',
      failureMessage: 'Transcription failed.',
    });

    expect(exporter.export(initial)).toEqual({ downloaded: false, failureMessage: null });
    expect(exporter.export(queued)).toEqual({ downloaded: false, failureMessage: null });
    expect(exporter.export(processing)).toEqual({ downloaded: false, failureMessage: null });
    expect(exporter.export(failed)).toEqual({ downloaded: false, failureMessage: null });
    expect(downloads).toHaveLength(0);
  });

  it('reports browser download failure and leaves the viewer text unchanged', () => {
    const element = new FakeElement();
    const viewer = new TranscriptViewer(element as unknown as HTMLElement);
    const state = completedState('unchanged transcript\n第二行');
    const stateBeforeFailure = { ...state };
    viewer.render(state);
    const beforeFailure = element.childNodes[0]?.data;
    const failures: string[] = [];
    const exporter = new TranscriptExporter({} as Document, {
      download: () => {
        throw new Error('browser operation failed');
      },
      onFailure: (message) => failures.push(message),
    });

    const result = exporter.export(state);

    expect(result).toEqual({ downloaded: false, failureMessage: TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE });
    expect(exporter.failureMessage).toBe(TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE);
    expect(failures).toEqual([TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE]);
    expect(state).toEqual(stateBeforeFailure);
    expect(element.childNodes).toHaveLength(1);
    expect(element.childNodes[0]?.data).toBe(beforeFailure);
  });
});
