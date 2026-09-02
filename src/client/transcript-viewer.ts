import type { ClientTranscriptionState } from './state';

/**
 * The portion of client state that determines what the transcript viewer may
 * display. Keeping this boundary state-based prevents the viewer from
 * accepting arbitrary markup or provider-owned objects.
 */
export type TranscriptViewerState = Pick<ClientTranscriptionState, 'activeJobId' | 'status' | 'transcriptText'>;

const TRANSCRIPT_VIEWER_CLASSES = [
  'min-w-0',
  'max-w-full',
  'overflow-hidden',
  'whitespace-pre-wrap',
  'break-words',
  'font-inter',
  'text-body-md',
  'text-on-surface',
] as const;

/**
 * Renders the active completed transcript as a literal text node.
 *
 * The viewer deliberately uses `createTextNode` and `replaceChildren` rather
 * than an HTML insertion API. Transcript characters therefore remain data,
 * including markup-like text, and `whitespace-pre-wrap` keeps line breaks and
 * other whitespace visible while `break-words` prevents long text from
 * creating horizontal page overflow.
 */
export class TranscriptViewer {
  private readonly container: HTMLElement;
  private activeJobId: TranscriptViewerState['activeJobId'] = null;

  public constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add(...TRANSCRIPT_VIEWER_CLASSES);
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Transcript');
    this.clear();
  }

  /**
   * Reconciles the viewer with the current client state.
   *
   * Non-completed states always clear the viewer. This also clears stale text
   * as soon as a new active job is started, before that job can complete.
   */
  public render(state: TranscriptViewerState): void {
    const activeJobChanged = state.activeJobId !== this.activeJobId;
    this.activeJobId = state.activeJobId;

    if (
      activeJobChanged ||
      state.activeJobId === null ||
      state.status !== 'completed' ||
      state.transcriptText === null
    ) {
      this.clear();
    }

    if (state.activeJobId === null || state.status !== 'completed' || state.transcriptText === null) {
      return;
    }

    // A Text node is the only content inserted into the viewer.
    this.container.replaceChildren(this.container.ownerDocument.createTextNode(state.transcriptText));
  }

  /** Removes every rendered transcript character from the viewer. */
  public clear(): void {
    this.container.replaceChildren();
  }
}
