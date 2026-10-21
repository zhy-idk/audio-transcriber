import type {
  AcceptedAudioFile,
  TranscriptionSettings,
} from '../shared/transcription.js';
import type { ProviderOutcome } from './soniox.js';

export type GroqCredential = string & { readonly __brand: unique symbol };

export function toGroqCredential(value: string): GroqCredential {
  return value as GroqCredential;
}

export interface GroqCredentialStore {
  getCredential(): Promise<GroqCredential>;
}

export class EnvironmentGroqCredentialStore implements GroqCredentialStore {
  private readonly credentialKey: string;

  public constructor(
    private readonly environment: Record<string, string | undefined> = process.env,
    credentialKey = 'GROQ_API_KEY',
  ) {
    this.credentialKey = credentialKey;
  }

  public async getCredential(): Promise<GroqCredential> {
    const raw = this.environment[this.credentialKey];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return toGroqCredential(raw.trim());
    }
    throw new Error('Groq credential is unavailable. Please set GROQ_API_KEY in your environment or .env file.');
  }
}

export interface GroqSubmissionResult {
  readonly providerHandle: string | null;
  readonly outcome: ProviderOutcome;
}

export interface GroqGateway {
  submit(
    submission: { readonly file: AcceptedAudioFile; readonly settings: TranscriptionSettings },
    credential: GroqCredential,
  ): Promise<GroqSubmissionResult>;
}
