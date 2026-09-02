import { describe, expect, it, vi } from 'vitest';

import {
  JobStatusRegion,
  areSettingsLocked,
  canStartNewTranscription,
  createInitialClientState,
  reduceClientStatus,
  startClientJob,
} from '../../src/client';
import { FAILURE_DETAILS_UNAVAILABLE_MESSAGE } from '../../src/shared';
import type { ClientTranscriptionState } from '../../src/client';

class FakeClassList {
  public readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, EventListener[]>();
  public className = '';
  public hidden = false;
  public disabled = false;
  public id = '';
  public textContent: string | null = null;
  public type = '';

  public addEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((handler) => handler !== listener));
  }

  public dispatch(type: string): void {
    const event = { currentTarget: this } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

function stateFor(update: Parameters<typeof startClientJob>[1]): ClientTranscriptionState {
  return startClientJob(createInitialClientState(), update);
}

function regionFixture(onStartNew = vi.fn()) {
  const elements = {
    root: new FakeElement(),
    statusLabel: new FakeElement(),
    processingIndicator: new FakeElement(),
    failureMessage: new FakeElement(),
    startNewButton: new FakeElement(),
  };
  elements.failureMessage.id = 'failure-message';
  const region = new JobStatusRegion(
    elements as unknown as ConstructorParameters<typeof JobStatusRegion>[0],
    { onStartNew },
  );
  return { elements, region, onStartNew };
}

describe('client status reducer', () => {
  it('correlates active updates, locks only active settings, and prevents terminal rollback', () => {
    const queued = stateFor({ jobId: 'job-1', status: 'queued' });
    expect(areSettingsLocked(queued)).toBe(true);

    const mismatched = reduceClientStatus(queued, { jobId: 'job-2', status: 'processing' });
    expect(mismatched).toBe(queued);

    const processing = reduceClientStatus(queued, { jobId: 'job-1', status: 'processing' });
    expect(processing.status).toBe('processing');
    expect(areSettingsLocked(processing)).toBe(true);

    const completed = reduceClientStatus(processing, {
      jobId: 'job-1',
      status: 'completed',
      transcriptText: 'completed transcript',
    });
    expect(completed.status).toBe('completed');
    expect(completed.transcriptText).toBe('completed transcript');
    expect(areSettingsLocked(completed)).toBe(false);

    const lateUpdate = reduceClientStatus(completed, { jobId: 'job-1', status: 'processing' });
    expect(lateUpdate).toBe(completed);
  });

  it('normalizes absent, empty, and oversized failed details and exposes start-new eligibility', () => {
    const queued = stateFor({ jobId: 'job-1', status: 'queued' });
    const failed = reduceClientStatus(queued, { jobId: 'job-1', status: 'failed' });

    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toBe(FAILURE_DETAILS_UNAVAILABLE_MESSAGE);
    expect(canStartNewTranscription(failed)).toBe(true);
    expect(areSettingsLocked(failed)).toBe(false);

    const empty = reduceClientStatus(
      stateFor({ jobId: 'job-2', status: 'queued' }),
      { jobId: 'job-2', status: 'failed', failureMessage: '' },
    );
    expect(empty.failureMessage).toBe(FAILURE_DETAILS_UNAVAILABLE_MESSAGE);

    const oversized = reduceClientStatus(
      stateFor({ jobId: 'job-3', status: 'queued' }),
      { jobId: 'job-3', status: 'failed', failureMessage: 'x'.repeat(1_025) },
    );
    expect(oversized.failureMessage).toBe(FAILURE_DETAILS_UNAVAILABLE_MESSAGE);
  });
});

describe('JobStatusRegion', () => {
  it('announces statuses politely and renders a distinct processing indicator', () => {
    const { elements, region } = regionFixture();

    expect(elements.root.hidden).toBe(true);
    expect(elements.root.attributes.get('role')).toBe('status');
    expect(elements.root.attributes.get('aria-live')).toBe('polite');
    expect(elements.root.attributes.get('aria-atomic')).toBe('true');

    region.render(stateFor({ jobId: 'job-1', status: 'queued' }));
    expect(elements.root.hidden).toBe(false);
    expect(elements.statusLabel.textContent).toBe('Queued');
    expect(elements.processingIndicator.hidden).toBe(true);
    expect(elements.startNewButton.hidden).toBe(true);

    region.render(stateFor({ jobId: 'job-1', status: 'processing' }));
    expect(elements.statusLabel.textContent).toBe('Processing');
    expect(elements.processingIndicator.hidden).toBe(false);
    expect(elements.processingIndicator.attributes.get('aria-hidden')).toBe('true');
    expect(elements.processingIndicator.attributes.get('data-processing-indicator')).toBe('true');
  });

  it('shows an enabled start-new action for failed jobs and hides it for terminal success', () => {
    const onStartNew = vi.fn();
    const { elements, region } = regionFixture(onStartNew);
    const failed = reduceClientStatus(
      stateFor({ jobId: 'job-1', status: 'queued' }),
      { jobId: 'job-1', status: 'failed', failureMessage: 'Submission failed.' },
    );

    region.render(failed);

    expect(elements.statusLabel.textContent).toBe('Failed');
    expect(elements.failureMessage.textContent).toBe('Submission failed.');
    expect(elements.failureMessage.hidden).toBe(false);
    expect(elements.startNewButton.hidden).toBe(false);
    expect(elements.startNewButton.disabled).toBe(false);
    expect(elements.startNewButton.textContent).toBe('Start new transcription');
    expect(elements.startNewButton.attributes.get('aria-describedby')).toBe('failure-message');
    elements.startNewButton.dispatch('click');
    expect(onStartNew).toHaveBeenCalledOnce();

    region.render(
      stateFor({
        jobId: 'job-2',
        status: 'completed',
        transcriptText: 'done',
      }),
    );
    expect(elements.statusLabel.textContent).toBe('Completed');
    expect(elements.startNewButton.hidden).toBe(true);
    expect(elements.startNewButton.disabled).toBe(true);
    expect(elements.startNewButton.attributes.has('aria-describedby')).toBe(false);
  });
});
