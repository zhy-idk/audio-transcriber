# Requirements Document

## Introduction

Soniox Audio Transcription is a browser-based web application that accepts an audio file, requests a transcription through a protected backend integration with Soniox, presents the transcription lifecycle and result, and downloads the completed result as a plain-text file. The application provides file-browser and drag-and-drop upload paths, a concise technical interface, configurable transcription language preference, and distinct idle, processing, error, and completion states.

## Glossary

- **Audio_Transcription_Application**: The complete feature comprising the Browser_Client and Backend_Service.
- **Browser_Client**: The user-facing web application running in a web browser.
- **Backend_Service**: The server-side component that validates transcription requests, manages Transcription_Jobs, and communicates with the Soniox_API.
- **Soniox_API**: The external Soniox interface used by the Backend_Service to create and retrieve transcriptions.
- **Soniox_Credential**: A secret authentication value that authorizes the Backend_Service to call the Soniox_API.
- **Soniox_Credential_Store**: Server-side configuration or secret storage accessible only to the Backend_Service.
- **File_Selection**: The zero-or-more files supplied by one file-browser selection or one upload-zone drop.
- **Accepted_Audio_File**: A user-supplied file whose browser-provided media type begins with `audio/` and whose supplied filename contains 1 to 255 characters.
- **Transcription_Job**: The uniquely identified backend record for one non-rejected audio-transcription request.
- **Active_Transcription_Job**: The Transcription_Job whose status and result the Browser_Client currently presents.
- **Transcription_Settings**: The source-language preference associated with a Transcription_Job; the default preference is automatic language detection.
- **Status_Update**: A Backend_Service response that identifies a Transcription_Job and reports one of the queued, processing, completed, or failed states; completed updates include Transcript_Text, and failed updates include a Failure_Message.
- **Terminal_Status**: The completed or failed state of a Transcription_Job.
- **Transcript_Text**: The text returned by the Soniox_API for a completed Transcription_Job.
- **Transcript_Viewer**: The Browser_Client region that displays Transcript_Text.
- **Transcript_Exporter**: The Browser_Client capability that generates the downloaded text file.
- **Failure_Message**: A user-visible message describing a rejected request, failed transcription, or failed download without a Soniox_Credential or server-internal error detail. Requirements specify the applicable character limits for each use.
- **Tailwind_CSS**: The utility-first CSS framework used to style the Browser_Client.

## Requirements

### Requirement 1: Select an audio file

**User Story:** As a user, I want to choose an audio file by browsing or dragging it into the application, so that I can begin a transcription request using my preferred input method.

#### Acceptance Criteria

1. WHEN a user selects exactly one file through the file browser whose browser-provided media type begins with `audio/` and whose supplied filename contains 1 to 255 characters, THE Browser_Client SHALL set that file as the sole selected file, display its supplied filename without modification, and enable the transcription action.
2. WHEN a user drops exactly one file in the upload zone whose browser-provided media type begins with `audio/` and whose supplied filename contains 1 to 255 characters, THE Browser_Client SHALL set that file as the sole selected file, display its supplied filename without modification, and enable the transcription action.
3. IF a file-browser selection or upload-zone drop does not contain exactly one file whose browser-provided media type begins with `audio/` and whose supplied filename contains 1 to 255 characters, THEN THE Browser_Client SHALL clear any selected file, disable the transcription action, and display a validation error indicating that exactly one audio file is required.
4. WHILE no file whose browser-provided media type begins with `audio/` and whose supplied filename contains 1 to 255 characters is selected, THE Browser_Client SHALL display an enabled browse control and the text "Browse for or drag one audio file into this upload zone."
5. WHEN a user activates the browse control, THE Browser_Client SHALL open a file browser that permits selection of no more than one file.

### Requirement 2: Submit transcription requests through the backend

**User Story:** As a user, I want the application to submit my selected audio file for transcription, so that I can receive a Transcript_Text without managing provider authentication.

#### Acceptance Criteria

1. WHEN a user initiates transcription for one Accepted_Audio_File, THE Browser_Client SHALL send one transcription request containing that Accepted_Audio_File and the selected Transcription_Settings to the Backend_Service.
2. WHEN the Backend_Service receives a transcription request containing an Accepted_Audio_File and Transcription_Settings and does not reject the request, THE Backend_Service SHALL create exactly one Transcription_Job with an identifier unique among every Transcription_Job created by the Backend_Service.
3. WHEN the Backend_Service creates a Transcription_Job after retrieving a Soniox_Credential from the Soniox_Credential_Store, THE Backend_Service SHALL submit that Transcription_Job's Accepted_Audio_File and Transcription_Settings to the Soniox_API using that Soniox_Credential.
4. WHEN the Soniox_API reports a queued or processing state for a Transcription_Job, THE Backend_Service SHALL return exactly one Status_Update identifying that Transcription_Job and reporting the same queued or processing state to the Browser_Client.
5. WHEN the Soniox_API returns Transcript_Text for a completed Transcription_Job, THE Backend_Service SHALL return a Status_Update identifying that Transcription_Job and reporting a completed state, together with the same Transcript_Text, to the Browser_Client.
6. IF the Soniox_API reports failure for a Transcription_Job, THEN THE Backend_Service SHALL set that Transcription_Job to a failed state and return a Status_Update identifying it and reporting the failed state, together with a Failure_Message of 1 to 500 characters indicating the reported failure, to the Browser_Client.
7. THE Browser_Client SHALL NOT send requests to the Soniox_API except through the Backend_Service.
8. THE Backend_Service SHALL retrieve a Soniox_Credential only from the Soniox_Credential_Store.
9. IF the Backend_Service rejects a transcription request, THEN THE Backend_Service SHALL return a Failure_Message of 1 to 500 characters indicating that the request was rejected, SHALL NOT create a Transcription_Job or submit the Accepted_Audio_File to the Soniox_API, and SHALL preserve no submitted Transcription_Job for that request.
10. IF the Backend_Service cannot retrieve a Soniox_Credential from the Soniox_Credential_Store for a Transcription_Job, THEN THE Backend_Service SHALL set that Transcription_Job to a failed state and return a Status_Update identifying it and reporting the failed state, together with a Failure_Message of 1 to 500 characters indicating that submission could not occur, to the Browser_Client.
11. IF the Backend_Service cannot submit a Transcription_Job to the Soniox_API, THEN THE Backend_Service SHALL set that Transcription_Job to a failed state and return a Status_Update identifying it and reporting the failed state, together with a Failure_Message of 1 to 500 characters indicating that submission failed, to the Browser_Client.
12. THE Backend_Service SHALL NOT include a Soniox_Credential or server-internal error detail in any response sent to the Browser_Client.

### Requirement 3: Configure transcription language preference

**User Story:** As a user, I want to select a transcription language preference, so that I can provide language context when automatic detection is not appropriate.

#### Acceptance Criteria

1. WHEN the Browser_Client displays the Transcription_Settings control before a Transcription_Job request has been submitted, THE Browser_Client SHALL show automatic language detection as the selected Transcription_Settings value.
2. WHEN a user submits a Transcription_Job request after selecting a Transcription_Settings value, THE Browser_Client SHALL associate exactly the selected Transcription_Settings value, including automatic language detection when selected, with that Transcription_Job request.
3. WHILE the Active_Transcription_Job has not reached a Terminal_Status, THE Browser_Client SHALL disable the Transcription_Settings control so that the user cannot change its value.
4. WHEN the Active_Transcription_Job reaches a Terminal_Status, THE Browser_Client SHALL enable the Transcription_Settings control within 1 second and allow the user to select a Transcription_Settings value for the next Transcription_Job.

### Requirement 4: Communicate transcription status and failures

**User Story:** As a user, I want visible transcription status and actionable failure information, so that I can understand whether a transcription is still running, complete, or needs to be retried.

#### Acceptance Criteria

1. WHEN the Browser_Client receives a queued Status_Update associated with a currently displayed Transcription_Job, THE Browser_Client SHALL display a visible "Queued" status label for that Transcription_Job within 1 second.
2. WHEN the Browser_Client receives a processing Status_Update associated with a currently displayed Transcription_Job, THE Browser_Client SHALL display a visible "Processing" status label and a visible non-text processing indicator distinct from that label for the Transcription_Job within 1 second.
3. WHEN the Browser_Client receives a failed Status_Update associated with a currently displayed Transcription_Job that contains a Failure_Message of 1 to 1,024 characters, THE Browser_Client SHALL display a visible "Failed" status label and the complete Failure_Message for that Transcription_Job within 1 second.
4. WHEN the Browser_Client receives a completed Status_Update associated with a currently displayed Transcription_Job, THE Browser_Client SHALL display a visible "Completed" status label for that Transcription_Job within 1 second.
5. WHEN the Browser_Client receives a Status_Update associated with a Transcription_Job for which it has recorded a Terminal_Status of completed or failed, THE Browser_Client SHALL retain and display the recorded Terminal_Status for that Transcription_Job within 1 second.
6. IF a failed Status_Update associated with a currently displayed Transcription_Job has a Failure_Message that is absent, empty, or exceeds 1,024 characters, THEN THE Browser_Client SHALL display a visible "Failed" status label and an error message indicating that failure details are unavailable for that Transcription_Job within 1 second.
7. WHILE the Browser_Client displays a failed status for a Transcription_Job, THE Browser_Client SHALL display a visible, enabled action that allows the user to start a new transcription.
8. IF the Browser_Client receives a Status_Update that does not identify a currently displayed Transcription_Job, THEN THE Browser_Client SHALL not change the displayed status of any Transcription_Job.

### Requirement 5: View completed transcription text safely

**User Story:** As a user, I want to read the completed transcription in the application, so that I can review the result before downloading it.

#### Acceptance Criteria

1. WHEN the Browser_Client receives Transcript_Text for a Transcription_Job whose state is completed, THE Transcript_Viewer SHALL display all received Transcript_Text characters, represent each received line break as a line break, and add, omit, or alter no characters.
2. WHEN Transcript_Text contains a sequence that the browser would otherwise interpret as executable content, THE Transcript_Viewer SHALL display that sequence as visible text and SHALL NOT execute it.
3. WHILE the Active_Transcription_Job state is not completed, THE Transcript_Viewer SHALL display zero characters from the Active_Transcription_Job Transcript_Text.
4. WHEN a user initiates a new Transcription_Job, THE Browser_Client SHALL designate the new Transcription_Job as the Active_Transcription_Job, display the new Transcription_Job current status, and remove the prior Active_Transcription_Job Transcript_Text from the Transcript_Viewer.

### Requirement 6: Download a plain-text transcript

**User Story:** As a user, I want to download the completed transcription as a text file, so that I can retain and use the result outside the application.

#### Acceptance Criteria

1. WHEN a Transcription_Job reaches the completed state and has an associated Transcript_Text value, THE Browser_Client SHALL display an enabled transcript download action associated with that Transcription_Job.
2. WHEN a user initiates the transcript download action for a completed Transcription_Job, THE Transcript_Exporter SHALL generate exactly one downloadable file with a filename ending in `.txt`, UTF-8 encoding, and decoded content equal to the associated Transcript_Text value, including all characters and line breaks.
3. IF a browser download operation for a completed Transcription_Job reports failure, THEN THE Browser_Client SHALL display a Failure_Message indicating that the transcript was not downloaded and continue to display the unchanged Transcript_Text for that Transcription_Job in the Transcript_Viewer.

### Requirement 7: Provide a responsive technical interface

**User Story:** As a user, I want a clear and consistent interface for every transcription state, so that I can operate the application efficiently on desktop and mobile devices.

#### Acceptance Criteria

1. THE Browser_Client SHALL use Tailwind_CSS for all Browser_Client visual styling.
2. WHILE a Transcription_Job is in the idle upload, queued, processing, failed, or completed state, THE Browser_Client SHALL display exactly one layout associated with that state, including the upload region for idle upload, the status region for queued or processing, a visible failure indication for failed, and the Transcript_Viewer region for completed.
3. WHEN the Browser_Client viewport width is from 320 through 767 CSS pixels inclusive, THE Browser_Client SHALL arrange each visible upload, settings, status, and Transcript_Viewer region in a single vertical column and SHALL maintain a document scrollable width no greater than the viewport width.
4. WHEN the Browser_Client viewport width is from 768 through 3840 CSS pixels inclusive, THE Browser_Client SHALL maintain a document scrollable width no greater than the viewport width.
5. WHILE a keyboard-focusable Browser_Client control has keyboard focus, THE Browser_Client SHALL display a continuous solid 2 CSS pixel outline separated from the control by a 2 CSS pixel offset, with a contrast ratio of at least 3:1 against the immediately adjacent background.

## Executable Correctness Properties

The following properties are intended for property-based tests of Browser_Client and Backend_Service code. Tests must use local fakes or mocks for Soniox_API and Soniox_Credential_Store rather than sending test data to Soniox.

### Property 1: Audio-file selection validation is deterministic

**Validates:** Requirement 1, acceptance criteria 1–3.

For every generated File_Selection `S`, the Browser_Client accepts `S` if and only if `S` contains exactly one file `F` whose media type begins with `audio/` and whose supplied filename contains 1 to 255 characters. When the Browser_Client accepts `S`, the Browser_Client state contains `F` as the sole selected file, displays the supplied filename of `F` without modification, and enables the transcription action. When the Browser_Client rejects `S`, the Browser_Client state contains no selected file, disables the transcription action, and exposes a validation error indicating that exactly one audio file is required.

### Property 2: Requests preserve settings, job identifiers are unique, and credentials remain server-side

**Validates:** Requirement 2, acceptance criteria 1–3, 7–8, and 12, and Requirement 3, acceptance criterion 2.

For every Accepted_Audio_File `A`, Transcription_Settings value `S`, and arbitrary Soniox_Credential `C`, a non-rejected submission causes the Browser_Client to send exactly one request containing `A` and `S` to the Backend_Service, without a direct Soniox_API request. With local fakes for the Soniox_API and Soniox_Credential_Store, the Backend_Service retrieves `C` only from the Soniox_Credential_Store and submits `A` and `S` to the Soniox_API using `C`. For every finite sequence of non-rejected submissions, all created Transcription_Job identifiers are pairwise unique, and no client-visible request, response, state object, or rendered output includes `C` or server-internal error detail.

### Property 3: Terminal status and active-job display are stable

**Validates:** Requirement 4, acceptance criteria 5 and 8.

For every Transcription_Job identifier `J`, Terminal_Status `T`, and sequence of later Status_Updates identifying `J`, reducing the sequence after recording `T` retains `T` as the Browser_Client state for `J`. For every distinct Transcription_Job identifier `K`, a Status_Update identifying `K` does not change the displayed status of the Active_Transcription_Job `J`.

### Property 4: Transcript rendering preserves text without executing markup

**Validates:** Requirement 5, acceptance criteria 1–2.

For every Unicode Transcript_Text value `T`, including markup-like strings and every supported line-break sequence, rendering `T` produces visible text equal to `T`, preserves every line break, and does not create executable elements, event handlers, or script content from characters in `T`.

### Property 5: Text download is a lossless UTF-8 transformation

**Validates:** Requirement 6, acceptance criteria 1–2.

For every Unicode Transcript_Text value `T`, a transcript download produces exactly one file whose filename ends with `.txt` and whose UTF-8-decoded byte content equals `T`, including all characters and line breaks.

### Property 6: Active job replacement clears stale transcript data

**Validates:** Requirement 5, acceptance criteria 3–4.

For every prior Transcript_Text value `T` and new Transcription_Job identifier `J`, initiating `J` designates `J` as the Active_Transcription_Job, replaces the displayed status with the current status of `J`, and results in a Transcript_Viewer containing zero characters from `T` until a completed Status_Update for `J` supplies new Transcript_Text.
