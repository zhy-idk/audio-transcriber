import {
  createApplicationServer,
  SpeakerIdentificationService,
} from './index.js';
import { createInMemoryJobCoordinator } from './job-coordinator.js';
import {
  createProductionSonioxCredentialStore,
} from './soniox.js';
import { SonioxApiGateway } from './soniox-api.js';

const host = process.env.SERVER_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SERVER_PORT ?? '3001', 10);
const baseUrl = process.env.SONIOX_API_BASE_URL ?? 'https://api.soniox.com/v1';
const model = process.env.SONIOX_MODEL ?? 'stt-async-v5';

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('SERVER_PORT must be an integer between 1 and 65535.');
}

const speakerService = new SpeakerIdentificationService();
const coordinator = createInMemoryJobCoordinator({
  credentialStore: createProductionSonioxCredentialStore(),
  gateway: new SonioxApiGateway({ baseUrl, model }),
  speakerService,
});
const server = createApplicationServer({ coordinator, speakerService });

server.listen(port, host, () => {
  console.log(`Transcription backend listening on http://${host}:${port}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
