import type { JobId, StatusUpdate } from '../shared/transcription';
import type { TranscriptionApi } from './transcription-api';

export const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;

export interface StatusPollingCallbacks {
  readonly onUpdate: (update: StatusUpdate) => void;
  readonly onError: (error: unknown) => void;
}

export interface StatusPollingControllerOptions {
  readonly intervalMs?: number;
}

/**
 * Polls one active backend job with a one-request-at-a-time timer loop.
 * Starting or stopping a loop invalidates all late responses from its prior
 * generation and aborts any request that is still in flight.
 */
export class StatusPollingController {
  private readonly intervalMs: number;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;

  constructor(
    private readonly api: Pick<TranscriptionApi, 'getStatus'>,
    options: StatusPollingControllerOptions = {},
  ) {
    this.intervalMs =
      typeof options.intervalMs === 'number' && Number.isFinite(options.intervalMs) && options.intervalMs >= 0
        ? options.intervalMs
        : DEFAULT_STATUS_POLL_INTERVAL_MS;
  }

  start(jobId: JobId, callbacks: StatusPollingCallbacks): void {
    this.stop();
    const generation = this.generation;

    const poll = async (): Promise<void> => {
      if (generation !== this.generation) {
        return;
      }

      const controller = new AbortController();
      this.inFlight = controller;
      try {
        const update = await this.api.getStatus(jobId, controller.signal);
        if (generation !== this.generation || update.jobId !== jobId) {
          if (generation === this.generation) {
            this.timer = setTimeout(() => {
              void poll();
            }, this.intervalMs);
          }
          return;
        }

        callbacks.onUpdate(update);
        if (update.status === 'queued' || update.status === 'processing') {
          this.timer = setTimeout(() => {
            void poll();
          }, this.intervalMs);
        } else {
          this.stopIfCurrent(generation);
        }
      } catch (error) {
        if (generation === this.generation && !controller.signal.aborted) {
          callbacks.onError(error);
          this.stopIfCurrent(generation);
        }
      } finally {
        if (generation === this.generation && this.inFlight === controller) {
          this.inFlight = null;
        }
      }
    };

    this.timer = setTimeout(() => {
      void poll();
    }, this.intervalMs);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
  }

  destroy(): void {
    this.stop();
  }

  private stopIfCurrent(generation: number): void {
    if (generation === this.generation) {
      this.stop();
    }
  }
}

export function createStatusPollingController(
  api: Pick<TranscriptionApi, 'getStatus'>,
  options: StatusPollingControllerOptions = {},
): StatusPollingController {
  return new StatusPollingController(api, options);
}
