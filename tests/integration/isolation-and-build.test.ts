import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SameOriginTranscriptionApi,
  type ClientFetch,
} from '../../src/client';
import {
  createApplicationServer,
  type TranscriptionHttpCoordinator,
} from '../../src/server';
import type { StatusUpdate } from '../../src/shared';
import * as sharedContracts from '../../src/shared';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = join(projectRoot, 'src');
const distRoot = join(projectRoot, 'dist');

const privateImportPattern = /(?:^|\/)(?:server|soniox|job-coordinator|job-repository|public-status|request-validation|http-api)(?:\/|\.|$)/u;
const privateRuntimeMarkerPattern = /SonioxCredential|SonioxProviderHandle|SonioxGateway|SonioxCredentialStore|ProviderFailureContext|ProviderOutcome|providerHandle|providerPayload|SONIOX_API_KEY|Authorization\s*:\s*["'`]Bearer|credentialStore/u;

interface RunningServer {
  readonly baseUrl: string;
  readonly server: Server;
}

const runningServers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(({ server }) => new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  })));
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function audioFile(name = 'meeting.wav'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/wav' });
}

async function startServer(coordinator: TranscriptionHttpCoordinator): Promise<RunningServer> {
  const server = createApplicationServer({ coordinator });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The local integration server did not expose a TCP address.');
  }

  const running = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
  runningServers.push(running);
  return running;
}

function internalCompletedStatus(): StatusUpdate {
  return {
    jobId: 'job-public-1',
    status: 'completed',
    transcriptText: 'safe transcript',
    credential: 'server-secret-credential',
    providerHandle: 'provider-private-handle',
    providerPayload: { secret: 'provider-payload-secret' },
    error: new Error('raw internal error'),
    stack: 'Error: raw internal error\\n    at private-stack (server.ts:1:1)',
  } as unknown as StatusUpdate;
}

describe('client/server isolation integration', () => {
  it('keeps browser and shared static imports away from backend-private modules', () => {
    const browserAndSharedFiles = [
      ...sourceFiles(join(sourceRoot, 'client')),
      ...sourceFiles(join(sourceRoot, 'shared')),
    ];
    const privateImports: string[] = [];

    for (const file of browserAndSharedFiles) {
      for (const specifier of staticImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (privateImportPattern.test(specifier)) {
          privateImports.push(`${relative(projectRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(privateImports).toEqual([]);
    expect(Object.keys(sharedContracts).filter((key) => privateRuntimeMarkerPattern.test(key))).toEqual([]);
  });

  it('sends only the public file and settings fields and receives only public status fields', async () => {
    const observedCreate: { selection: unknown; settings: unknown }[] = [];
    const coordinator: TranscriptionHttpCoordinator = {
      create: async (selection, settings) => {
        observedCreate.push({ selection, settings });
        return { accepted: true, status: internalCompletedStatus() };
      },
      getStatus: async () => internalCompletedStatus(),
    };
    const server = await startServer(coordinator);
    const observedRequests: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    const fetchImplementation: ClientFetch = async (input, init) => {
      observedRequests.push({ input, init });
      return fetch(new URL(String(input), server.baseUrl), init);
    };
    const api = new SameOriginTranscriptionApi({ fetchImplementation });

    const created = await api.create(audioFile(), 'en-US');
    const receivedStatus = await api.getStatus('job-public-1');
    const statusResponse = await fetch(`${server.baseUrl}/api/transcriptions/job-public-1/status`);
    const statusBody = await statusResponse.json() as Record<string, unknown>;

    expect(created).toEqual({
      jobId: 'job-public-1',
      status: 'completed',
      transcriptText: 'safe transcript',
    });
    expect(receivedStatus).toEqual(created);
    expect(observedRequests).toHaveLength(2);
    expect(observedRequests[0]?.input).toBe('/api/transcriptions');
    expect(observedRequests[0]?.init?.method).toBe('POST');
    expect(observedRequests[0]?.init?.headers).toBeUndefined();
    const requestForm = observedRequests[0]?.init?.body;
    expect(requestForm).toBeInstanceOf(FormData);
    expect(Array.from((requestForm as FormData).keys()).sort()).toEqual(['file', 'settings']);
    expect((requestForm as FormData).get('settings')).toBe('en-US');
    expect((requestForm as FormData).get('file')).toMatchObject({ name: 'meeting.wav', type: 'audio/wav' });
    expect(observedRequests[1]?.input).toBe('/api/transcriptions/job-public-1/status');
    expect(observedRequests[1]?.init?.method).toBe('GET');
    expect(observedRequests[1]?.init?.body).toBeUndefined();
    expect(observedCreate).toHaveLength(1);
    expect(observedCreate[0]?.settings).toBe('en-US');
    expect(observedCreate[0]?.selection).toMatchObject([{ name: 'meeting.wav', type: 'audio/wav' }]);

    expect(statusResponse.status).toBe(200);
    expect(Object.keys(statusBody).sort()).toEqual(['jobId', 'status', 'transcriptText']);
    expect(statusBody).toEqual(created);
    const publicWire = JSON.stringify(statusBody);
    expect(publicWire).not.toContain('server-secret-credential');
    expect(publicWire).not.toContain('provider-private-handle');
    expect(publicWire).not.toContain('provider-payload-secret');
    expect(publicWire).not.toContain('raw internal error');
  });

  it('builds expected production client and server artifacts without private markers in the client bundle', () => {
    const clientBuild = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const serverBuild = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.server.json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(clientBuild.error).toBeUndefined();
    expect(clientBuild.status, `${clientBuild.stdout}\n${clientBuild.stderr}`).toBe(0);
    expect(serverBuild.error).toBeUndefined();
    expect(serverBuild.status, `${serverBuild.stdout}\n${serverBuild.stderr}`).toBe(0);

    const clientIndex = join(distRoot, 'client', 'index.html');
    const clientAssetsDirectory = join(distRoot, 'client', 'assets');
    const clientJavaScript = readdirSync(clientAssetsDirectory)
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(clientAssetsDirectory, name));
    const clientStylesheets = readdirSync(clientAssetsDirectory)
      .filter((name) => name.endsWith('.css'))
      .map((name) => join(clientAssetsDirectory, name));
    const serverEntry = join(distRoot, 'server', 'server', 'index.js');
    const sharedContract = join(distRoot, 'server', 'shared', 'transcription.js');
    const privateServerAdapter = join(distRoot, 'server', 'server', 'soniox.js');

    expect(statSync(clientIndex).isFile()).toBe(true);
    expect(clientJavaScript.length).toBeGreaterThan(0);
    expect(clientStylesheets.length).toBeGreaterThan(0);
    expect(statSync(serverEntry).isFile()).toBe(true);
    expect(statSync(sharedContract).isFile()).toBe(true);
    expect(statSync(privateServerAdapter).isFile()).toBe(true);

    const clientOutput = clientJavaScript
      .concat(clientStylesheets)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(clientOutput).not.toMatch(privateRuntimeMarkerPattern);
    expect(readFileSync(clientIndex, 'utf8')).toContain('/assets/');
  }, 20_000);
});
