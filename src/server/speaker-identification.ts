import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { TranscriptToken } from '../shared/transcription.js';

const execFileAsync = promisify(execFile);

export interface SpeakerIdentificationConfig {
  readonly pythonPath?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly modelPath?: string | undefined;
  readonly profilesPath?: string | undefined;
}

export interface EnrollResult {
  readonly status: string;
  readonly name: string;
  readonly embedding_dim?: number | undefined;
}

export interface ListSpeakersResult {
  readonly status: string;
  readonly speakers: readonly string[];
  readonly count: number;
}

export interface IdentifyResult {
  readonly status: string;
  readonly identified: boolean;
  readonly match: string | null;
  readonly score: number;
  readonly threshold: number;
  readonly all_scores?: Readonly<Record<string, number>> | undefined;
}

export interface RelabelResult {
  readonly status: string;
  readonly tokens: readonly TranscriptToken[];
  readonly speaker_mapping: Readonly<Record<string, string>>;
}

export class SpeakerIdentificationService {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly modelPath: string | undefined;
  private readonly profilesPath: string | undefined;

  constructor(config: SpeakerIdentificationConfig = {}) {
    this.pythonPath = config.pythonPath || process.env.PYTHON_PATH || 'python';
    this.scriptPath = config.scriptPath || resolve(process.cwd(), 'scripts', 'speaker_id.py');
    this.modelPath = config.modelPath;
    this.profilesPath = config.profilesPath;
  }

  private getBaseArgs(): string[] {
    const args: string[] = [];
    if (this.modelPath) {
      args.push('--model', this.modelPath);
    }
    if (this.profilesPath) {
      args.push('--profiles', this.profilesPath);
    }
    args.push('--json');
    return args;
  }

  private async runCommand<T>(subcommand: string, extraArgs: readonly string[]): Promise<T> {
    const args = [this.scriptPath, ...this.getBaseArgs(), subcommand, ...extraArgs];
    try {
      const { stdout, stderr } = await execFileAsync(this.pythonPath, args);
      const output = stdout.trim();
      if (!output) {
        throw new Error(stderr.trim() || 'No output received from speaker_id CLI.');
      }
      return JSON.parse(output) as T;
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(String(err));
    }
  }

  async enroll(name: string, audioPath: string): Promise<EnrollResult> {
    return this.runCommand<EnrollResult>('enroll', [name, audioPath]);
  }

  async list(): Promise<readonly string[]> {
    const res = await this.runCommand<ListSpeakersResult>('list', []);
    return res.speakers || [];
  }

  async remove(name: string): Promise<boolean> {
    const res = await this.runCommand<{ status: string }>('remove', [name]);
    return res.status === 'removed';
  }

  async identify(audioPath: string, threshold = 0.55): Promise<IdentifyResult> {
    return this.runCommand<IdentifyResult>('identify', [audioPath, '--threshold', String(threshold)]);
  }

  async relabel(
    audioPath: string,
    tokens: readonly TranscriptToken[],
    threshold = 0.55,
  ): Promise<RelabelResult> {
    return this.runCommand<RelabelResult>('relabel', [
      audioPath,
      JSON.stringify(tokens),
      '--threshold',
      String(threshold),
    ]);
  }

  async diarize(
    audioPath: string,
    tokens: readonly TranscriptToken[],
    threshold = 0.55,
  ): Promise<RelabelResult> {
    return this.runCommand<RelabelResult>('diarize', [
      audioPath,
      JSON.stringify(tokens),
      '--threshold',
      String(threshold),
    ]);
  }

  async enrollFromAudio(
    name: string,
    audioPath: string,
    tokens: readonly TranscriptToken[],
    speakerId: string,
  ): Promise<EnrollResult> {
    return this.runCommand<EnrollResult>('enroll-from-audio', [
      name,
      audioPath,
      JSON.stringify(tokens),
      speakerId,
    ]);
  }
}
