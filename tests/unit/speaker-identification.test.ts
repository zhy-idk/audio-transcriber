import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { SpeakerIdentificationService } from '../../src/server/speaker-identification';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('SpeakerIdentificationService', () => {
  let service: SpeakerIdentificationService;
  const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SpeakerIdentificationService({
      pythonPath: 'python3',
      scriptPath: '/custom/path/speaker_id.py',
      modelPath: '/custom/models/campplus.onnx',
      profilesPath: '/custom/data/profiles.json',
    });
  });

  it('enrolls speaker and constructs correct CLI arguments', async () => {
    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, { stdout: JSON.stringify({ status: 'enrolled', name: 'Alice', embedding_dim: 192 }), stderr: '' });
    });

    const result = await service.enroll('Alice', '/path/to/voice.wav');

    expect(result).toEqual({ status: 'enrolled', name: 'Alice', embedding_dim: 192 });
    expect(mockExecFile).toHaveBeenCalledWith(
      'python3',
      [
        '/custom/path/speaker_id.py',
        '--model',
        '/custom/models/campplus.onnx',
        '--profiles',
        '/custom/data/profiles.json',
        '--json',
        'enroll',
        'Alice',
        '/path/to/voice.wav',
      ],
      expect.any(Function),
    );
  });

  it('lists enrolled speakers', async () => {
    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, { stdout: JSON.stringify({ status: 'ok', speakers: ['Alice', 'Bob'], count: 2 }), stderr: '' });
    });

    const speakers = await service.list();
    expect(speakers).toEqual(['Alice', 'Bob']);
  });

  it('removes an enrolled speaker', async () => {
    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, { stdout: JSON.stringify({ status: 'removed', name: 'Bob' }), stderr: '' });
    });

    const success = await service.remove('Bob');
    expect(success).toBe(true);
  });

  it('identifies a speaker from audio file', async () => {
    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          status: 'ok',
          identified: true,
          match: 'Alice',
          score: 0.88,
          threshold: 0.55,
          all_scores: { Alice: 0.88, Bob: 0.35 },
        }),
        stderr: '',
      });
    });

    const idResult = await service.identify('/audio/test.wav', 0.6);
    expect(idResult.identified).toBe(true);
    expect(idResult.match).toBe('Alice');
    expect(idResult.score).toBe(0.88);
  });

  it('relabels tokens with identified speakers', async () => {
    const inputTokens = [
      { text: 'Hello', speaker: '1', startMs: 0, endMs: 1200 },
      { text: 'Hey', speaker: '2', startMs: 1300, endMs: 2500 },
    ];

    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          status: 'ok',
          tokens: [
            { text: 'Hello', speaker: 'Alice', startMs: 0, endMs: 1200 },
            { text: 'Hey', speaker: 'Bob', startMs: 1300, endMs: 2500 },
          ],
          speaker_mapping: { '1': 'Alice', '2': 'Bob' },
        }),
        stderr: '',
      });
    });

    const result = await service.relabel('/audio/meeting.wav', inputTokens, 0.55);
    expect(result.tokens[0]?.speaker).toBe('Alice');
    expect(result.tokens[1]?.speaker).toBe('Bob');
    expect(result.speaker_mapping).toEqual({ '1': 'Alice', '2': 'Bob' });
  });

  it('runs sherpa-onnx diarization and token alignment', async () => {
    const inputTokens = [
      { text: 'Hello', startMs: 500, endMs: 1200 },
      { text: 'World', startMs: 1400, endMs: 2500 },
    ];

    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          status: 'ok',
          tokens: [
            { text: 'Hello', speaker: 'Alice', startMs: 500, endMs: 1200 },
            { text: 'World', speaker: 'Bob', startMs: 1400, endMs: 2500 },
          ],
          speaker_mapping: { '1': 'Alice', '2': 'Bob' },
        }),
        stderr: '',
      });
    });

    const result = await service.diarize('/audio/groq-transcription.wav', inputTokens, 0.6);
    expect(result.tokens[0]?.speaker).toBe('Alice');
    expect(result.tokens[1]?.speaker).toBe('Bob');
    expect(result.speaker_mapping).toEqual({ '1': 'Alice', '2': 'Bob' });
    expect(mockExecFile).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['diarize', '/audio/groq-transcription.wav', expect.stringContaining('Hello'), '--threshold', '0.6']),
      expect.any(Function),
    );
  });

  it('enrolls speaker from audio recording segments', async () => {
    const inputTokens = [
      { text: 'Hello', speaker: '1', startMs: 500, endMs: 1200 },
      { text: 'World', speaker: '1', startMs: 1400, endMs: 2500 },
    ];

    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          status: 'enrolled',
          name: 'Charlie',
          speaker_id: '1',
          embedding_dim: 192,
          duration_ms: 1800,
        }),
        stderr: '',
      });
    });

    const result = await service.enrollFromAudio('Charlie', '/audio/meeting.wav', inputTokens, '1');
    expect(result.status).toBe('enrolled');
    expect(result.name).toBe('Charlie');
    expect(mockExecFile).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['enroll-from-audio', 'Charlie', '/audio/meeting.wav', expect.stringContaining('Hello'), '1']),
      expect.any(Function),
    );
  });

  it('throws helpful error when CLI outputs invalid JSON or fails', async () => {
    mockExecFile.mockImplementation((bin, args, callback) => {
      callback(new Error('Process failed'), { stdout: '', stderr: 'RuntimeError: File not found' });
    });

    await expect(service.list()).rejects.toThrow('Process failed');
  });
});
