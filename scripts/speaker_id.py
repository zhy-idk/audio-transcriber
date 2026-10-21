#!/usr/bin/env python3
"""
Speaker Identification Engine using sherpa-onnx (CAM++ model).

Commands:
  enroll <name> <audio_path>        Enrolls a speaker voice profile.
  list                              Lists all enrolled speakers.
  remove <name>                     Removes an enrolled speaker profile.
  identify <audio_path>             Identifies speaker from an audio file.
  relabel <audio_path> <tokens_json> Identifies speakers in Soniox tokens and outputs relabeled tokens.
"""

import argparse
import json
import os
import sys
from pathlib import Path
import numpy as np
import soundfile as sf
import sherpa_onnx

DEFAULT_MODEL_PATH = os.environ.get(
    "SPEAKER_MODEL_PATH",
    str(Path(__file__).resolve().parent.parent / "models" / "campplus.onnx")
)
DEFAULT_SEGMENTATION_MODEL_PATH = os.environ.get(
    "SPEAKER_SEGMENTATION_MODEL_PATH",
    str(Path(__file__).resolve().parent.parent / "models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx")
)
DEFAULT_PROFILES_PATH = os.environ.get(
    "SPEAKER_PROFILES_PATH",
    str(Path(__file__).resolve().parent.parent / "data" / "speaker_profiles.json")
)


def get_extractor(model_path: str = DEFAULT_MODEL_PATH) -> sherpa_onnx.SpeakerEmbeddingExtractor:
    if not os.path.exists(model_path):
        raise FileNotFoundError(
            f"Speaker model not found at '{model_path}'. "
            "Please ensure models/campplus.onnx is downloaded."
        )
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=model_path,
        num_threads=2,
        debug=False,
        provider="cpu",
    )
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


def get_diarizer(
    model_path: str = DEFAULT_MODEL_PATH,
    seg_model_path: str = DEFAULT_SEGMENTATION_MODEL_PATH,
    num_clusters: int = -1,
) -> sherpa_onnx.OfflineSpeakerDiarization:
    if not os.path.exists(seg_model_path):
        raise FileNotFoundError(
            f"Segmentation model not found at '{seg_model_path}'. "
            "Please ensure models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx is downloaded."
        )
    if not os.path.exists(model_path):
        raise FileNotFoundError(
            f"Speaker model not found at '{model_path}'. "
            "Please ensure models/campplus.onnx is downloaded."
        )

    seg_config = sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model_path),
        num_threads=2,
        debug=False,
        provider="cpu",
    )
    emb_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=model_path,
        num_threads=2,
        debug=False,
        provider="cpu",
    )
    cluster_config = sherpa_onnx.FastClusteringConfig(
        num_clusters=num_clusters if num_clusters > 0 else -1
    )
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=seg_config,
        embedding=emb_config,
        clustering=cluster_config,
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise ValueError("Invalid speaker diarization config.")
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def load_audio_samples(file_path: str, start_ms: int = None, end_ms: int = None):
    try:
        samples, sample_rate = sf.read(file_path, dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
    except Exception:
        # Fallback to PyAV for m4a, aac, mp4, etc.
        try:
            import av
            container = av.open(file_path)
            audio_stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
            frames = []
            for frame in container.decode(audio_stream):
                for resampled in resampler.resample(frame):
                    frames.append(resampled.to_ndarray()[0])
            samples = np.concatenate(frames) if frames else np.array([], dtype=np.float32)
            sample_rate = 16000
        except Exception as av_err:
            raise RuntimeError(f"Failed to read audio file '{file_path}': {av_err}")

    if len(samples) == 0:
        raise ValueError(f"Audio file '{file_path}' contains no audio samples.")

    if start_ms is not None or end_ms is not None:
        start_idx = int((start_ms if start_ms is not None else 0) * sample_rate / 1000)
        end_idx = int(end_ms * sample_rate / 1000) if end_ms is not None else len(samples)
        samples = samples[start_idx:end_idx]

    return samples, sample_rate


def compute_embedding(extractor: sherpa_onnx.SpeakerEmbeddingExtractor, samples, sample_rate: int):
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate, samples.tolist())
    return extractor.compute(stream)


def load_profiles(profiles_path: str = DEFAULT_PROFILES_PATH) -> dict:
    if not os.path.exists(profiles_path):
        return {}
    try:
        with open(profiles_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_profiles(profiles: dict, profiles_path: str = DEFAULT_PROFILES_PATH):
    os.makedirs(os.path.dirname(os.path.abspath(profiles_path)), exist_ok=True)
    with open(profiles_path, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2)


def cosine_similarity(v1, v2) -> float:
    a = np.array(v1, dtype=np.float32)
    b = np.array(v2, dtype=np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def cmd_enroll(name: str, audio_path: str, model_path: str, profiles_path: str):
    extractor = get_extractor(model_path)
    samples, sample_rate = load_audio_samples(audio_path)
    emb = compute_embedding(extractor, samples, sample_rate)

    profiles = load_profiles(profiles_path)
    profiles[name] = emb
    save_profiles(profiles, profiles_path)
    return {"status": "enrolled", "name": name, "embedding_dim": len(emb)}


def cmd_list(profiles_path: str):
    profiles = load_profiles(profiles_path)
    return {"status": "ok", "speakers": list(profiles.keys()), "count": len(profiles)}


def cmd_remove(name: str, profiles_path: str):
    profiles = load_profiles(profiles_path)
    if name in profiles:
        del profiles[name]
        save_profiles(profiles, profiles_path)
        return {"status": "removed", "name": name}
    return {"status": "not_found", "name": name}


def cmd_identify(audio_path: str, threshold: float, model_path: str, profiles_path: str, start_ms=None, end_ms=None):
    profiles = load_profiles(profiles_path)
    if not profiles:
        return {"status": "no_profiles", "identified": False, "match": None, "score": 0.0}

    extractor = get_extractor(model_path)
    samples, sample_rate = load_audio_samples(audio_path, start_ms, end_ms)
    test_emb = compute_embedding(extractor, samples, sample_rate)

    best_name = None
    best_score = 0.0
    scores = {}

    for name, enrolled_emb in profiles.items():
        score = cosine_similarity(test_emb, enrolled_emb)
        scores[name] = round(score, 4)
        if score > best_score:
            best_score = score
            best_name = name

    matched = best_score >= threshold
    return {
        "status": "ok",
        "identified": matched,
        "match": best_name if matched else None,
        "score": round(best_score, 4),
        "threshold": threshold,
        "all_scores": scores,
    }


def get_token_time(token: dict, *keys):
    for key in keys:
        if key in token and token[key] is not None:
            return token[key]
    return None


def cmd_relabel(audio_path: str, tokens_json_str: str, threshold: float, model_path: str, profiles_path: str):
    profiles = load_profiles(profiles_path)
    tokens = json.loads(tokens_json_str)

    if not profiles or not tokens:
        return {"status": "ok", "tokens": tokens, "speaker_mapping": {}}

    extractor = get_extractor(model_path)
    samples_full, sample_rate = load_audio_samples(audio_path)

    # Group time bounds by speaker tag (e.g. "1", "2")
    speaker_segments = {}
    for token in tokens:
        spk = token.get("speaker")
        if not spk:
            continue
        start = get_token_time(token, "startMs", "start_ms")
        end = get_token_time(token, "endMs", "end_ms")
        if start is not None and end is not None:
            if spk not in speaker_segments:
                speaker_segments[spk] = []
            speaker_segments[spk].append((start, end))

    speaker_mapping = {}
    for spk, segs in speaker_segments.items():
        # Concatenate audio frames for this speaker (up to ~10 seconds)
        speaker_samples = []
        total_duration_ms = 0
        for start, end in segs:
            s_idx = int(start * sample_rate / 1000)
            e_idx = int(end * sample_rate / 1000)
            speaker_samples.append(samples_full[s_idx:e_idx])
            total_duration_ms += (end - start)
            if total_duration_ms >= 10000:
                break

        if not speaker_samples:
            continue

        spk_audio = np.concatenate(speaker_samples)
        if len(spk_audio) < int(sample_rate * 0.5):  # Ignore < 0.5 sec
            continue

        spk_emb = compute_embedding(extractor, spk_audio, sample_rate)

        best_name = None
        best_score = 0.0
        for name, enrolled_emb in profiles.items():
            score = cosine_similarity(spk_emb, enrolled_emb)
            if score > best_score:
                best_score = score
                best_name = name

        if best_score >= threshold:
            speaker_mapping[spk] = best_name

    # Apply mapping to tokens
    relabeled_tokens = []
    for token in tokens:
        spk = token.get("speaker")
        new_token = dict(token)
        if spk in speaker_mapping:
            new_token["speaker"] = speaker_mapping[spk]
        relabeled_tokens.append(new_token)

    return {
        "status": "ok",
        "tokens": relabeled_tokens,
        "speaker_mapping": speaker_mapping,
    }


def cmd_diarize(
    audio_path: str,
    tokens_json_str: str,
    threshold: float,
    model_path: str,
    profiles_path: str,
    seg_model_path: str = DEFAULT_SEGMENTATION_MODEL_PATH,
):
    tokens = json.loads(tokens_json_str) if isinstance(tokens_json_str, str) else tokens_json_str
    if not tokens:
        return {"status": "ok", "tokens": [], "speaker_mapping": {}}

    samples_full, sample_rate = load_audio_samples(audio_path)

    # 1. Run sherpa-onnx OfflineSpeakerDiarization
    segments = []
    try:
        diarizer = get_diarizer(model_path, seg_model_path)
        diar_result = diarizer.process(samples_full)
        segments = diar_result.sort_by_start_time()
    except Exception as e:
        sys.stderr.write(f"Warning: sherpa-onnx diarization fallback: {e}\n")

    # 2. Align tokens with diarized segments
    if segments:
        for token in tokens:
            t_start = (token.get("startMs") or token.get("start_ms") or 0) / 1000.0
            t_end = (token.get("endMs") or token.get("end_ms") or (t_start + 0.1)) / 1000.0
            t_mid = (t_start + t_end) / 2.0

            best_seg = None
            min_dist = float("inf")
            for seg in segments:
                if seg.start <= t_mid <= seg.end:
                    best_seg = seg
                    break
                dist = min(abs(t_mid - seg.start), abs(t_mid - seg.end))
                if dist < min_dist:
                    min_dist = dist
                    best_seg = seg

            spk_num = best_seg.speaker + 1 if best_seg else 1
            token["speaker"] = str(spk_num)
    else:
        for token in tokens:
            if not token.get("speaker"):
                token["speaker"] = "1"

    # 3. Match against enrolled profiles (CAM++)
    profiles = load_profiles(profiles_path)
    if not profiles:
        return {"status": "ok", "tokens": tokens, "speaker_mapping": {}}

    extractor = get_extractor(model_path)
    speaker_segments = {}
    for token in tokens:
        spk = token.get("speaker")
        if not spk:
            continue
        start = get_token_time(token, "startMs", "start_ms")
        end = get_token_time(token, "endMs", "end_ms")
        if start is not None and end is not None:
            if spk not in speaker_segments:
                speaker_segments[spk] = []
            speaker_segments[spk].append((start, end))

    speaker_mapping = {}
    for spk, segs in speaker_segments.items():
        speaker_samples = []
        total_duration_ms = 0
        for start, end in segs:
            s_idx = int(start * sample_rate / 1000)
            e_idx = int(end * sample_rate / 1000)
            if s_idx < len(samples_full) and e_idx <= len(samples_full):
                speaker_samples.append(samples_full[s_idx:e_idx])
                total_duration_ms += (end - start)
                if total_duration_ms >= 10000:
                    break

        if not speaker_samples:
            continue

        spk_audio = np.concatenate(speaker_samples)
        if len(spk_audio) < int(sample_rate * 0.5):
            continue

        spk_emb = compute_embedding(extractor, spk_audio, sample_rate)

        best_name = None
        best_score = 0.0
        for name, enrolled_emb in profiles.items():
            score = cosine_similarity(spk_emb, enrolled_emb)
            if score > best_score:
                best_score = score
                best_name = name

        if best_score >= threshold:
            speaker_mapping[spk] = best_name

    relabeled_tokens = []
    for token in tokens:
        spk = token.get("speaker")
        new_token = dict(token)
        if spk in speaker_mapping:
            new_token["speaker"] = speaker_mapping[spk]
        relabeled_tokens.append(new_token)

    return {
        "status": "ok",
        "tokens": relabeled_tokens,
        "speaker_mapping": speaker_mapping,
    }


def main():
    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument("--model", default=DEFAULT_MODEL_PATH, help="Path to campplus.onnx")
    common_parser.add_argument("--profiles", default=DEFAULT_PROFILES_PATH, help="Path to speaker profiles JSON")
    common_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    parser = argparse.ArgumentParser(
        description="Sherpa-ONNX Speaker Identification Engine",
        parents=[common_parser]
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    enroll_p = subparsers.add_parser("enroll", parents=[common_parser], help="Enroll a speaker")
    enroll_p.add_argument("name", help="Speaker name (e.g. Alice)")
    enroll_p.add_argument("audio", help="Path to WAV voice sample")

    subparsers.add_parser("list", parents=[common_parser], help="List enrolled speakers")

    remove_p = subparsers.add_parser("remove", parents=[common_parser], help="Remove an enrolled speaker")
    remove_p.add_argument("name", help="Speaker name to remove")

    id_p = subparsers.add_parser("identify", parents=[common_parser], help="Identify a speaker from audio")
    id_p.add_argument("audio", help="Path to test WAV audio")
    id_p.add_argument("--threshold", type=float, default=0.55, help="Cosine similarity threshold (default 0.55)")
    id_p.add_argument("--start_ms", type=int, default=None, help="Start timestamp in ms")
    id_p.add_argument("--end_ms", type=int, default=None, help="End timestamp in ms")

    relabel_p = subparsers.add_parser("relabel", parents=[common_parser], help="Relabel Soniox tokens with identified speakers")
    relabel_p.add_argument("audio", help="Path to full audio file")
    relabel_p.add_argument("tokens", help="JSON string or file path containing tokens")
    relabel_p.add_argument("--threshold", type=float, default=0.55, help="Similarity threshold")

    diarize_p = subparsers.add_parser("diarize", parents=[common_parser], help="Diarize audio using sherpa-onnx and relabel tokens")
    diarize_p.add_argument("audio", help="Path to full audio file")
    diarize_p.add_argument("tokens", help="JSON string or file path containing tokens")
    diarize_p.add_argument("--threshold", type=float, default=0.55, help="Similarity threshold")
    diarize_p.add_argument("--seg-model", default=DEFAULT_SEGMENTATION_MODEL_PATH, help="Path to segmentation model.onnx")

    args = parser.parse_args()

    if args.command == "enroll":
        res = cmd_enroll(args.name, args.audio, args.model, args.profiles)
    elif args.command == "list":
        res = cmd_list(args.profiles)
    elif args.command == "remove":
        res = cmd_remove(args.name, args.profiles)
    elif args.command == "identify":
        res = cmd_identify(args.audio, args.threshold, args.model, args.profiles, args.start_ms, args.end_ms)
    elif args.command == "relabel":
        tokens_val = args.tokens
        if os.path.exists(tokens_val):
            with open(tokens_val, "r", encoding="utf-8") as f:
                tokens_val = f.read()
        res = cmd_relabel(args.audio, tokens_val, args.threshold, args.model, args.profiles)
    elif args.command == "diarize":
        tokens_val = args.tokens
        if os.path.exists(tokens_val):
            with open(tokens_val, "r", encoding="utf-8") as f:
                tokens_val = f.read()
        res = cmd_diarize(args.audio, tokens_val, args.threshold, args.model, args.profiles, args.seg_model)
    else:
        res = {"status": "invalid_command"}

    if args.json:
        print(json.dumps(res))
    else:
        print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
