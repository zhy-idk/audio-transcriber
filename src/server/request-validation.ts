/**
 * Backend-side request validation.
 *
 * The browser applies the same rule for usability, but the backend must repeat
 * it before a coordinator creates a job or calls a provider adapter. This
 * module is deliberately pure: invalid input produces no side effects.
 */

import {
  validateFileSelection,
  type AcceptedAudioFile,
  type FileSelectionValidation,
} from '../shared/transcription.js';

/** The result shape is shared with the browser validator for one public rule. */
export type BackendUploadValidation = FileSelectionValidation;

/**
 * Revalidates a browser-provided file collection at the backend boundary.
 *
 * A selection is accepted only when it contains exactly one file whose
 * browser-provided type begins with `audio/` and whose supplied filename has
 * 1–255 Unicode code points. The selected file object and filename are not
 * rewritten.
 */
export function validateBackendFileSelection(selection: unknown): BackendUploadValidation {
  return validateFileSelection(selection);
}

/** Semantic alias for callers validating a multipart upload. */
export const validateAudioUpload = validateBackendFileSelection;

/** Semantic alias used by the backend request handler. */
export const validateTranscriptionUpload = validateBackendFileSelection;

/** Type guard for the accepted branch of the backend validation result. */
export function isAcceptedBackendUpload(
  result: BackendUploadValidation,
): result is BackendUploadValidation & { readonly accepted: true; readonly selectedFile: AcceptedAudioFile } {
  return result.accepted && result.selectedFile !== null;
}

/**
 * Validates an upload and returns the accepted file for coordinator callers.
 * Rejected results retain the bounded public validation message and a null
 * file, allowing callers to reject before creating a job or submitting audio.
 */
export function getAcceptedAudioFile(selection: unknown): AcceptedAudioFile | null {
  const result = validateBackendFileSelection(selection);
  return isAcceptedBackendUpload(result) ? result.selectedFile : null;
}
