import { canDownloadTranscript, type ClientTranscriptionState } from './state';

/** Public message shown when the browser reports that a transcript download failed. */
export const TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE = 'Transcript was not downloaded.';
export const TRANSCRIPT_DOWNLOAD_FILENAME = 'transcript.txt';

export interface TranscriptExportResult {
  readonly downloaded: boolean;
  readonly failureMessage: string | null;
}

/**
 * The browser operation is injectable so export behavior can be tested without
 * opening a browser download or making any external request.
 */
export type TranscriptDownloadOperation = (blob: Blob, filename: string) => void;

export interface TranscriptExporterOptions {
  readonly download?: TranscriptDownloadOperation;
  readonly filename?: string;
  readonly onFailure?: (message: string) => void;
}

function browserDownload(document: Document): TranscriptDownloadOperation {
  return (blob, filename): void => {
    const browserUrl = document.defaultView?.URL ?? globalThis.URL;
    if (typeof browserUrl.createObjectURL !== 'function' || typeof browserUrl.revokeObjectURL !== 'function') {
      throw new Error('Browser download support is unavailable.');
    }

    const objectUrl = browserUrl.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.setAttribute('aria-hidden', 'true');
    anchor.style.display = 'none';

    try {
      document.body?.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      browserUrl.revokeObjectURL(objectUrl);
    }
  };
}

/**
 * Exports only a completed active transcript as one UTF-8 plain-text file.
 *
 * The exporter does not receive or mutate the transcript viewer. Consequently,
 * a failed browser operation cannot clear or alter the text already displayed.
 */
export class TranscriptExporter {
  private readonly downloadOperation: TranscriptDownloadOperation;
  private readonly filename: string;
  private readonly onFailure: (message: string) => void;
  private lastFailureMessage: string | null = null;

  public constructor(
    document: Document,
    options: TranscriptExporterOptions = {},
  ) {
    this.downloadOperation = options.download ?? browserDownload(document);
    this.filename = options.filename?.endsWith('.txt') ? options.filename : TRANSCRIPT_DOWNLOAD_FILENAME;
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  public get failureMessage(): string | null {
    return this.lastFailureMessage;
  }

  /**
   * Starts one download when the state contains a completed transcript.
   * Non-completed states are intentionally ignored and do not report a
   * download failure because no download was requested.
   */
  public export(state: ClientTranscriptionState): TranscriptExportResult {
    this.lastFailureMessage = null;

    if (!canDownloadTranscript(state) || state.transcriptText === null) {
      return { downloaded: false, failureMessage: null };
    }

    const blob = new Blob([state.transcriptText], { type: 'text/plain;charset=utf-8' });

    try {
      this.downloadOperation(blob, this.filename);
      return { downloaded: true, failureMessage: null };
    } catch {
      this.lastFailureMessage = TRANSCRIPT_DOWNLOAD_FAILURE_MESSAGE;
      this.onFailure(this.lastFailureMessage);
      return { downloaded: false, failureMessage: this.lastFailureMessage };
    }
  }

  /** Alias kept for call sites that name the user action rather than the capability. */
  public download(state: ClientTranscriptionState): TranscriptExportResult {
    return this.export(state);
  }
}

export function createTranscriptExporter(
  document: Document,
  options: TranscriptExporterOptions = {},
): TranscriptExporter {
  return new TranscriptExporter(document, options);
}
