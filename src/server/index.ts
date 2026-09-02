import { createServer, type Server } from 'node:http';
import {
  handleRequest,
  type ApplicationServerOptions,
} from './http-api.js';

export {
  createTranscriptionHttpHandler,
  handleRequest,
} from './http-api.js';
export type {
  ApplicationServerOptions,
  TranscriptionHttpCoordinator,
} from './http-api.js';

export {
  getAcceptedAudioFile,
  isAcceptedBackendUpload,
  validateAudioUpload,
  validateBackendFileSelection,
  validateTranscriptionUpload,
} from './request-validation.js';
export type { BackendUploadValidation } from './request-validation.js';
export {
  GENERIC_PUBLIC_FAILURE_MESSAGE,
  REJECTED_REQUEST_FAILURE_MESSAGE,
  SUBMISSION_FAILED_FAILURE_MESSAGE,
  SUBMISSION_UNAVAILABLE_FAILURE_MESSAGE,
  mapPublicFailure,
  mapPublicStatus,
  sanitizeFailureMessage,
  sanitizePublicFailureMessage,
  sanitizeStatusUpdate,
  toPublicStatusUpdate,
} from './public-status.js';
export type { BackendStatusInput } from './public-status.js';
export {
  InMemoryJobRepository,
  InMemoryTranscriptionJobRepository,
} from './job-repository.js';
export type {
  CreateStoredJobInput,
  JobLifecyclePatch,
  JobRepository,
  StoredTranscriptionJob,
} from './job-repository.js';
export {
  createInMemoryJobCoordinator,
  JobCoordinator,
} from './job-coordinator.js';
export { SonioxApiGateway } from './soniox-api.js';
export type { SonioxApiGatewayOptions } from './soniox-api.js';
export type {
  AcceptedTranscriptionResult,
  BackendClock,
  CreateTranscriptionResult,
  JobCoordinatorOptions,
  JobIdGenerator,
  RejectedTranscriptionResult,
} from './job-coordinator.js';

/** Creates the same-origin HTTP server boundary used by the backend API. */
export function createApplicationServer(options: ApplicationServerOptions = {}): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options.coordinator).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ failureMessage: 'Transcription failed.' }));
    });
  });
}
