# Implementation Plan: Soniox Audio Transcription

## Overview

Implement the feature as one TypeScript application with a Tailwind-styled Browser Client, a same-origin protected Backend API, and backend-private Soniox adapter boundaries. Build shared public contracts first, then independently implement secure backend lifecycle handling and client workflow components, before wiring polling and the five mutually exclusive UI states together. All provider and credential tests use only local fakes or mocks; no task sends audio, credentials, transcripts, or requests to Soniox.

## Tasks

- [x] 1. Establish the TypeScript application foundation and shared transcription contract
  - [x] 1.1 Initialize the TypeScript browser/server project, Tailwind build, and local test tooling
    - Create the client, server, shared, and test source layout; use pinned package versions and scripts for one-shot unit/property tests, type checking, and production builds.
    - Configure Tailwind as the sole browser-visible styling mechanism, including the Precision Core color, typography, radius, spacing, focus-outline, and processing-animation tokens.
    - Configure fast-check so property tests run at least 100 cases and can use only in-memory data, local fakes, or mocks.
    - _Requirements: 7.1, 7.5_
  - [x] 1.2 Define shared public models and client-state primitives
    - Create TypeScript types and runtime guards for accepted audio files, settings (default automatic detection), job IDs, queued/processing/completed/failed status updates, transcript text, and public failure messages.
    - Keep credential values, provider correlation handles, raw exceptions, and internal diagnostics out of every browser-visible model.
    - _Requirements: 1.1–1.3, 2.4–2.6, 2.12, 3.1–3.2, 4.1–4.6, 5.1, 6.1_

- [x] 2. Implement the secure backend transcription lifecycle
  - [x] 2.1 Implement request validation and public-status sanitization modules
    - Add backend validation that accepts exactly one upload only when its browser-provided media type starts with `audio/` and its supplied filename is 1–255 characters; reject before job creation or gateway submission otherwise.
    - Add public-status/failure mapping that preserves completed transcripts, bounds backend-created failure text to 1–500 characters, and strips credentials, stack traces, provider payloads, and internal errors.
    - _Requirements: 1.1–1.3, 2.5–2.6, 2.9, 2.12_
  - [x] 2.2 Create backend-private credential and Soniox gateway boundaries
    - Define `SonioxCredentialStore` and `SonioxGateway` TypeScript interfaces plus production adapters that are reachable only from server modules.
    - Model provider outcomes as queued, processing, completed with opaque transcript text, or failed with backend-private context; do not expose provider handles or credential retrieval through HTTP routes.
    - _Requirements: 2.3, 2.7–2.8, 2.12_
  - [x] 2.3 Implement the in-memory job repository and job coordinator
    - Create unique cryptographically strong opaque job IDs and persist each non-rejected job’s selected setting, lifecycle state, timestamps, provider handle, transcript, and sanitized failure message without storing credentials or raw internal errors.
    - Coordinate credential retrieval, gateway submission, provider refresh, terminal-state persistence, and the required rejected/missing-credential/submission-failure outcomes.
    - _Requirements: 2.2–2.6, 2.9–2.12_
  - [x] 2.4 Expose same-origin create and status API handlers
    - Implement multipart creation and active-job status-read handlers using the validator and coordinator. Return one correlated initial/latest public status update for accepted jobs and a bounded public rejection failure without creating or submitting a job for rejected input.
    - Ensure status reads preserve stored terminal states and return no credential, internal diagnostic, or raw provider object.
    - _Requirements: 2.1–2.12, 4.5, 4.8_
  - [x]* 2.5 Write Property 2 test for submission isolation, setting preservation, and job-ID uniqueness
    - **Property 2: Requests preserve settings, job identifiers are unique, and credentials remain server-side.**
    - Use in-memory repository, local credential-store fake, and local Soniox-gateway fake to generate accepted files, settings, credentials, and finite submission sequences. Assert exactly one backend request per submission, pairwise-unique IDs, exact setting forwarding, and no credential/internal-detail leakage.
    - Add the required design-traceability comment and run at least 100 cases without any external request.
    - **Validates: Requirements 2.1–2.3, 2.7–2.8, 2.12, 3.2.**
  - [x]* 2.6 Write Property 7 test for exact backend lifecycle and safe failure outcomes
    - **Property 7: Backend lifecycle outcomes are exact and client-safe.**
    - Generate queued, processing, completed, failed, rejected, missing-credential, and gateway-submission outcomes against local fakes; assert correlated status mapping, no prohibited side effects, bounded safe failure text, and no false completion.
    - Add the required design-traceability comment and run at least 100 cases without any external request.
    - **Validates: Requirements 2.4–2.6, 2.9–2.11.**
  - [x]* 2.7 Write backend unit and local-fake integration tests
    - Cover filename/media-type boundary cases, one-job creation for accepted requests, rejected-request no-call behavior, credential outage, submission failure, provider queued-to-processing-to-completed flow, terminal-state retention, and redaction from every public response.
    - _Requirements: 1.1–1.3, 2.1–2.12, 4.5_

- [x] 3. Implement client selection, status, and settings state
  - [x] 3.1 Implement `FileSelectionController`, upload zone, and initial language-preference control
    - Handle one-file native browse and drag/drop paths; provide an enabled browse control limited to one selection and the exact idle copy: “Browse for or drag one audio file into this upload zone.”
    - Preserve a valid supplied filename without modification, clear all previous selection on invalid input, display the exact-one-audio-file validation outcome, default language selection to automatic detection, and expose semantic accessible controls.
    - _Requirements: 1.1–1.5, 3.1–3.2, 7.2, 7.5_
  - [x]* 3.2 Write Property 1 test for deterministic file-selection validation
    - **Property 1: Audio-file selection validation is deterministic.**
    - Generate zero, one, and multiple browser-file selections including audio/non-audio types, Unicode names, and 0/1/255/256-character names; assert accepted state and rejected clearing behavior exactly match the rule.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 1.1–1.3.**
  - [x] 3.3 Implement the client status reducer, status region, and terminal control behavior
    - Reduce only updates whose ID matches the active job; render Queued, Processing with a distinct non-text indicator, Completed, or Failed. Keep terminal status immutable, ignore mismatched updates, and normalize invalid failed details to “Failure details are unavailable.”
    - Lock settings only during queued/processing, unlock them immediately on terminal receipt, expose the enabled start-new action on failure, and use an accessible polite status announcement.
    - _Requirements: 3.3–3.4, 4.1–4.8, 7.2, 7.5_
  - [x]* 3.4 Write Property 3 test for terminal and active-job status stability
    - **Property 3: Terminal status and active-job display are stable.**
    - Generate terminal updates, later updates for the same job, active-job identifiers, and mismatched updates; assert terminal status cannot roll back and unrelated updates change no displayed field.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 4.5, 4.8.**
  - [x]* 3.5 Write Property 6 test for active-job transcript replacement
    - **Property 6: Active job replacement clears stale transcript data.**
    - Generate prior transcripts and new job IDs; assert starting a new job atomically replaces the active ID/status and exposes no prior transcript until a completed update for the new job arrives.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 5.3–5.4.**
  - [x]* 3.6 Write Property 8 test for active-state control locking and failure-detail normalization
    - **Property 8: Active-state controls and failure details normalize safely.**
    - Generate active lifecycle states plus valid and invalid failed-detail values; assert the settings lock is exact and the browser displays either the complete valid text or the standard unavailable-details text.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 3.3, 4.3, 4.6.**
  - [x]* 3.7 Write focused client unit/component tests for upload, status, and language controls
    - Test browse-input single-file configuration, exact idle copy, drag/drop selection, invalid reset, visible status and processing indicator within fake-timer limits, terminal settings unlock within one second, failed retry action, semantics, and live-region behavior.
    - _Requirements: 1.1–1.5, 3.1–3.4, 4.1–4.8, 7.2, 7.5_

- [x] 4. Implement lossless transcript viewing and export
  - [x] 4.1 Implement the safe `TranscriptViewer`
    - Render only the completed active job’s transcript through a text-node-based path, never HTML insertion or evaluation; preserve every Unicode character and line break with whitespace-preserving wrapping that cannot force horizontal page overflow.
    - Clear the viewer whenever a new active job starts or the active job is not completed.
    - _Requirements: 5.1–5.4, 7.3–7.4_
  - [x]* 4.2 Write Property 4 test for safe, lossless transcript rendering
    - **Property 4: Transcript rendering preserves text without executing markup.**
    - Generate Unicode text, markup-like strings, and supported line-break sequences; assert visible text equality, preserved line breaks, and absence of created scripts, event handlers, or executable elements.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 5.1–5.2.**
  - [x] 4.3 Implement `TranscriptExporter` download handling
    - For a completed transcript only, create exactly one `.txt` download encoded as UTF-8 from the same transcript string. Catch a reported browser download-operation failure, show a public download failure message, and retain the unchanged viewer text.
    - _Requirements: 6.1–6.3_
  - [x]* 4.4 Write Property 5 test for lossless UTF-8 download generation
    - **Property 5: Text download is a lossless UTF-8 transformation.**
    - Generate Unicode transcript strings and use a local download spy to assert one `.txt` artifact and byte content that decodes exactly to the source string, including line breaks.
    - Add the required design-traceability comment and run at least 100 cases locally.
    - **Validates: Requirements 6.1–6.2.**
  - [x]* 4.5 Write transcript viewer and exporter unit/component tests
    - Cover completed-only visibility, new-job clearing, literal display of script-like text, preserved whitespace, enabled completed download, and reported-download-failure recovery without transcript loss.
    - _Requirements: 5.1–5.4, 6.1–6.3_

- [x] 5. Wire the client workflow to the backend and complete the responsive interface
  - [x] 5.1 Implement the same-origin client API and polling controller
    - Send exactly one multipart create request containing the current accepted file and selected setting. Poll only the active queued/processing job at one-second intervals with at most one request in flight; cancel or discard stale work after a new job, unmount, or terminal update.
    - Route all provider-facing activity through the backend API and stop polling once the reducer records completion or failure.
    - _Requirements: 2.1, 2.7, 3.2–3.4, 4.1–4.8, 5.4_
  - [x] 5.2 Compose `TranscriptionPage` and apply all Precision Core Tailwind layouts
    - Wire upload, settings, status, transcript viewer, exporter, API client, reducer, and retry/start-new behavior into one active-job flow with exactly one idle/upload, queued, processing, failed, or completed layout at a time.
    - Apply the fixed-width focused column, tonal cards, Tailwind-only responsive single-column mobile behavior, overflow-safe desktop behavior, semantic controls, and continuous 2px/2px-offset high-contrast focus outline.
    - _Requirements: 1.1–1.5, 3.1–3.4, 4.1–4.8, 5.1–5.4, 6.1–6.3, 7.1–7.5_
  - [x]* 5.3 Write browser integration, accessibility, and responsive regression tests
    - With only local backend/gateway/credential fakes, cover all five UI layouts, native keyboard workflow, disabled/enabled settings lifecycle, status rendering, failed retry, completed export, and literal transcript display.
    - Inspect 320px, 767px, 768px, and 3840px viewports for document scroll width no greater than the viewport; assert Tailwind focus outline width/offset and adjacent-surface contrast of at least 3:1.
    - _Requirements: 1.4–1.5, 3.1–3.4, 4.1–4.8, 5.1–5.4, 6.1–6.3, 7.1–7.5_
  - [x]* 5.4 Write automated integration checks for client/server isolation and production build output
    - Verify no browser module imports the credential-store or Soniox gateway implementations, local fakes remain the only test provider path, public client responses omit credentials/internal diagnostics, and the Tailwind production build, TypeScript check, and non-watch test suite complete successfully.
    - _Requirements: 2.7–2.8, 2.12, 7.1_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks are ordered so the shared TypeScript contract enables independent server and client implementation before the final workflow composition.
- Tasks marked with `*` are optional test/validation work and can be skipped for a faster MVP; all property tests are local-only and each maps to exactly one documented correctness property.
- The production Soniox gateway remains a backend-private adapter. Provider-specific URLs, payloads, model identifiers, and callback mechanisms remain behind that boundary until separately specified.
- The implementation must keep all browser-visible styling in Tailwind utilities or Tailwind theme tokens and must never send test or production browser traffic directly to Soniox.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "3.1", "4.1", "4.3"] },
    { "id": 3, "tasks": ["2.3", "3.2", "3.3", "4.2", "4.4"] },
    { "id": 4, "tasks": ["2.4", "3.4", "3.5", "3.6", "3.7", "4.5"] },
    { "id": 5, "tasks": ["2.5", "2.6", "2.7", "5.1"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["5.3", "5.4"] }
  ]
}
```
