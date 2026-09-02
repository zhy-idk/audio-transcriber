import { describe, expect, it, vi } from 'vitest';

import { JobCoordinator } from '../../src/server/job-coordinator';
import {
  InMemoryJobRepository,
  type JobRepository,
} from '../../src/server/job-repository';
import type {
  ProviderOutcome,
  SonioxCredential,
  SonioxCredentialStore,
  SonioxGateway,
  SonioxProviderHandle,
} from '../../src/server/soniox';
import type { AcceptedAudioFile } from '../../src/shared/transcription';

const credential = 'server-only-credential' as SonioxCredential;
const providerHandle = 'provider-handle-1' as SonioxProviderHandle;

function audioFile(name = 'recording.wav'): AcceptedAudioFile {
  return { name, type: 'audio/wav' } as AcceptedAudioFile;
}

function createFakes(outcome: ProviderOutcome = { status: 'queued' }) {
  const getCredential = vi.fn<SonioxCredentialStore['getCredential']>().mockResolvedValue(credential);
  const submit = vi.fn<SonioxGateway['submit']>().mockResolvedValue({ providerHandle, outcome });
  const refresh = vi.fn<SonioxGateway['refresh']>();

  const credentialStore: SonioxCredentialStore = { getCredential };
  const gateway: SonioxGateway = { submit, refresh };
  return { credentialStore, gateway, getCredential, submit, refresh };
}

describe('JobCoordinator and InMemoryJobRepository', () => {
  it('rejects invalid uploads before creating a job or calling backend dependencies', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes();
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const result = await coordinator.create([{ name: 'not-audio.txt', type: 'text/plain' }], 'en-US');

    expect(result).toEqual({
      accepted: false,
      failureMessage: 'Exactly one audio file is required.',
    });
    expect(repository.count()).toBe(0);
    expect(fakes.getCredential).not.toHaveBeenCalled();
    expect(fakes.submit).not.toHaveBeenCalled();
  });

  it('creates unique opaque jobs, preserves settings, and keeps credentials out of stored data', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes();
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const first = await coordinator.create([audioFile('first.wav')], 'en-US');
    const second = await coordinator.create([audioFile('second.wav')], 'automatic');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;

    expect(first.status.status).toBe('queued');
    expect(second.status.status).toBe('queued');
    expect(first.status.jobId).not.toBe(second.status.jobId);
    expect(first.status.jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fakes.getCredential).toHaveBeenCalledTimes(2);
    expect(fakes.submit).toHaveBeenCalledTimes(2);
    expect(fakes.submit.mock.calls[0]?.[0]).toMatchObject({ settings: 'en-US', file: { name: 'first.wav' } });
    expect(fakes.submit.mock.calls[1]?.[0]).toMatchObject({ settings: 'automatic', file: { name: 'second.wav' } });
    expect(fakes.submit.mock.calls[0]?.[1]).toBe(credential);

    const stored = repository.find(first.status.jobId);
    expect(stored).toMatchObject({
      settings: 'en-US',
      status: 'queued',
      providerHandle,
      transcriptText: null,
      failureMessage: null,
    });
    expect(JSON.stringify(stored)).not.toContain(credential);
    expect(JSON.stringify(first.status)).not.toContain(credential);
  });

  it('persists a correlated failed job when credential retrieval is unavailable', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes();
    fakes.getCredential.mockRejectedValue(new Error('secret store outage details'));
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const result = await coordinator.create([audioFile()], 'en-US');

    expect(result).toEqual({
      accepted: true,
      status: {
        jobId: expect.any(String),
        status: 'failed',
        failureMessage: 'Transcription submission could not occur.',
      },
    });
    if (!result.accepted) return;

    const stored = repository.find(result.status.jobId);
    expect(stored?.status).toBe('failed');
    expect(stored?.failureMessage).toBe('Transcription submission could not occur.');
    expect(fakes.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret store outage details');
  });

  it('maps gateway submission failures to bounded public text without retaining raw errors', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes({
      status: 'failed',
      context: {
        kind: 'provider',
        message: 'token=server-only-credential provider payload details',
        providerCode: 'PROVIDER_FAILURE',
        statusCode: 502,
        providerPayload: { secret: 'provider-secret' },
        cause: new Error('internal stack details'),
      },
    });
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const result = await coordinator.create([audioFile()], 'en-US');

    expect(result.accepted).toBe(true);
    if (!result.accepted || result.status.status !== 'failed') return;
    expect(result.status.failureMessage).toBe('Transcription failed.');
    expect(JSON.stringify(result)).not.toContain('server-only-credential');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(JSON.stringify(repository.find(result.status.jobId))).not.toContain('internal stack details');
  });

  it('persists a failed job when provider submission throws and redacts the raw error', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes();
    fakes.submit.mockRejectedValue(new Error(`credential=${credential}; provider stack details`));
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const result = await coordinator.create([audioFile()], 'en-US');

    expect(result).toEqual({
      accepted: true,
      status: {
        jobId: expect.any(String),
        status: 'failed',
        failureMessage: 'Transcription submission failed.',
      },
    });
    if (!result.accepted) return;

    expect(repository.count()).toBe(1);
    expect(repository.find(result.status.jobId)?.status).toBe('failed');
    expect(fakes.submit).toHaveBeenCalledTimes(1);
    expect(fakes.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(repository.find(result.status.jobId))).not.toContain('provider stack details');
  });

  it('maps a thrown refresh failure to a terminal public failure for the opaque job', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes({ status: 'queued' });
    fakes.refresh.mockRejectedValue(new Error('private refresh transport details'));
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const created = await coordinator.create([audioFile()], 'en-US');
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;

    const refreshed = await coordinator.getStatus(created.status.jobId);

    expect(refreshed).toEqual({
      jobId: created.status.jobId,
      status: 'failed',
      failureMessage: 'Transcription submission failed.',
    });
    expect(created.status.jobId).not.toBe(providerHandle);
    expect(fakes.refresh).toHaveBeenCalledWith(providerHandle, credential);
    expect(repository.find(created.status.jobId)?.status).toBe('failed');
    expect(JSON.stringify(refreshed)).not.toContain('private refresh transport details');
  });

  it('refreshes non-terminal jobs, preserves the exact transcript, and retains terminal state', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes({ status: 'queued' });
    fakes.refresh
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'completed', transcriptText: '<literal>\n✓' })
      .mockResolvedValueOnce({ status: 'processing' });
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const created = await coordinator.create([audioFile()], 'en-US');
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;

    await expect(coordinator.getStatus(created.status.jobId)).resolves.toEqual({
      jobId: created.status.jobId,
      status: 'processing',
    });
    await expect(coordinator.getStatus(created.status.jobId)).resolves.toEqual({
      jobId: created.status.jobId,
      status: 'completed',
      transcriptText: '<literal>\n✓',
    });
    await expect(coordinator.getStatus(created.status.jobId)).resolves.toEqual({
      jobId: created.status.jobId,
      status: 'completed',
      transcriptText: '<literal>\n✓',
    });

    expect(fakes.refresh).toHaveBeenCalledTimes(2);
    expect(fakes.getCredential).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(repository.find(created.status.jobId))).not.toContain(credential);
  });

  it('marks an active job failed when refresh credential retrieval fails', async () => {
    const repository = new InMemoryJobRepository();
    const fakes = createFakes({ status: 'queued' });
    fakes.getCredential.mockResolvedValueOnce(credential).mockRejectedValueOnce(new Error('private outage'));
    const coordinator = new JobCoordinator({
      repository,
      credentialStore: fakes.credentialStore,
      gateway: fakes.gateway,
    });

    const created = await coordinator.create([audioFile()], 'en-US');
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;

    await expect(coordinator.getStatus(created.status.jobId)).resolves.toEqual({
      jobId: created.status.jobId,
      status: 'failed',
      failureMessage: 'Transcription submission could not occur.',
    });
    expect(fakes.refresh).not.toHaveBeenCalled();
    expect(repository.find(created.status.jobId)?.status).toBe('failed');
  });

  it('retains a completed job when a later lifecycle update attempts rollback', () => {
    const repository = new InMemoryJobRepository();
    const created = repository.create({ jobId: 'job-terminal', settings: 'automatic', createdAt: 1 });

    const completed = repository.update(
      created.jobId,
      { status: 'completed', transcriptText: '終わり\n<script>literal</script> ✓' },
      2,
    );
    const afterRollback = repository.update(
      created.jobId,
      { status: 'processing', providerHandle },
      3,
    );

    expect(completed).toMatchObject({
      jobId: 'job-terminal',
      status: 'completed',
      transcriptText: '終わり\n<script>literal</script> ✓',
    });
    expect(afterRollback).toEqual(completed);
    expect(repository.find(created.jobId)).toEqual(completed);
  });

  it('does not expose mutable repository records to callers', () => {
    const repository: JobRepository = new InMemoryJobRepository();
    const created = repository.create({ jobId: 'job-1', settings: 'automatic', createdAt: 1 });
    const read = repository.find(created.jobId);

    expect(read).not.toBe(created);
    if (read === null) return;
    expect(() => {
      (read as { status: string }).status = 'completed';
    }).not.toThrow();
    expect(repository.find(created.jobId)?.status).toBe('queued');
  });
});
