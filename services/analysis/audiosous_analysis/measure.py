"""Level, stereo, dynamics, and spectral measurements.

Audio is read in short blocks. The numbers describe the file. Nothing here
decides a mix move.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf

from audiosous_analysis import ANALYSIS_ENGINE_VERSION, ANALYSIS_SCHEMA_VERSION
from audiosous_analysis.accumulate import Accumulator
from audiosous_analysis.errors import AnalysisError

MAX_MIX_FILES = 32
MAX_SAMPLES = 250_000_000
CHUNK_FRAMES = 65_536

__all__ = ["ANALYSIS_ENGINE_VERSION", "ANALYSIS_SCHEMA_VERSION", "measure_file", "measure_mix"]


def measure_file(path: Path, scope: dict | None = None) -> dict:
    path = Path(path)
    info = _info(path)
    start, end, reported = _scope_frames(info.frames, int(info.samplerate), scope, path.name)
    if end <= start:
        raise AnalysisError("empty-audio", f"Unable to analyze {path.name}", "The selection does not contain audio.")
    accumulator = Accumulator(int(info.samplerate), int(info.channels), end - start)
    with sf.SoundFile(path) as handle:
        handle.seek(start)
        remaining = end - start
        while remaining > 0:
            block = handle.read(min(CHUNK_FRAMES, remaining), dtype="float32", always_2d=True)
            if block.size == 0:
                break
            _reject_invalid(block, path.name)
            accumulator.add(block)
            remaining -= int(block.shape[0])
    if accumulator.seen == 0:
        raise AnalysisError("empty-audio", f"Unable to analyze {path.name}", "The file has no audio samples.")
    return accumulator.finish(reported)


def measure_mix(paths: list[Path]) -> dict:
    if not paths:
        raise AnalysisError("invalid-request", "The mix measurement needs at least one stem.", "")
    if len(paths) > MAX_MIX_FILES:
        raise AnalysisError("too-large", "Unable to measure this mix.", "Too many stems were included.")
    infos = [_info(Path(path)) for path in paths]
    sample_rate = int(infos[0].samplerate)
    channels = int(infos[0].channels)
    total = 0
    longest = 0
    for info in infos:
        if int(info.samplerate) != sample_rate:
            raise AnalysisError(
                "mixed-sample-rate",
                "Unable to measure this mix.",
                "Every stem in the mix measurement has to use the same sample rate.",
            )
        total += int(info.frames) * int(info.channels)
        if total > MAX_SAMPLES:
            raise AnalysisError("too-large", "Unable to measure this mix.", "The stems are too long to sum in one pass.")
        longest = max(longest, int(info.frames))
    handles = [sf.SoundFile(path) for path in paths]
    try:
        accumulator = Accumulator(sample_rate, channels, longest)
        remaining = [int(info.frames) for info in infos]
        while any(left > 0 for left in remaining):
            width = min(CHUNK_FRAMES, max(remaining))
            mixed = np.zeros((width, channels), dtype=np.float64)
            for index, handle in enumerate(handles):
                if remaining[index] <= 0:
                    continue
                block = handle.read(min(width, remaining[index]), dtype="float32", always_2d=True)
                if block.size == 0:
                    remaining[index] = 0
                    continue
                _reject_invalid(block, Path(paths[index]).name)
                matched = _match_channels(block, channels)
                mixed[: matched.shape[0]] += matched
                remaining[index] -= int(block.shape[0])
            accumulator.add(mixed.astype(np.float32))
    finally:
        for handle in handles:
            handle.close()
    if accumulator.seen == 0:
        raise AnalysisError("empty-audio", "Unable to measure this mix.", "The stems have no audio samples.")
    return accumulator.finish({"type": "mix"})


def _info(path: Path):
    path = Path(path)
    if not path.is_file():
        raise AnalysisError("missing-audio", f"Unable to analyze {path.name}", "The stem file is missing.")
    try:
        info = sf.info(str(path))
    except sf.LibsndfileError as exc:
        raise _unsupported(path, exc) from exc
    if info.samplerate <= 0 or info.frames <= 0 or info.channels <= 0:
        raise AnalysisError("empty-audio", f"Unable to analyze {path.name}", "The file has no audio samples.")
    if info.frames * info.channels > MAX_SAMPLES:
        raise AnalysisError("too-large", f"Unable to analyze {path.name}", "This stem is too long to measure in one pass.")
    return info


def _scope_frames(frames: int, sample_rate: int, scope: dict | None, filename: str) -> tuple[int, int, dict]:
    if not scope or scope.get("type") in (None, "track"):
        return 0, frames, {"type": "track"}
    kind = scope.get("type")
    if kind not in ("section", "time-range"):
        raise AnalysisError("unsupported-operation", "That analysis is not available yet.", str(kind))
    try:
        start = float(scope["startSeconds"])
        end = float(scope["endSeconds"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AnalysisError("invalid-request", f"Unable to analyze {filename}", "The selection did not include a time range.") from exc
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise AnalysisError("invalid-request", f"Unable to analyze {filename}", "The selection did not include a time range.")
    start_frame = min(frames, max(0, int(round(start * sample_rate))))
    end_frame = min(frames, max(0, int(round(end * sample_rate))))
    reported = {
        "type": kind,
        "startSeconds": round(start_frame / sample_rate, 6),
        "endSeconds": round(end_frame / sample_rate, 6),
    }
    return start_frame, end_frame, reported


def _match_channels(audio: np.ndarray, channels: int) -> np.ndarray:
    current = int(audio.shape[1])
    if current == channels:
        return audio
    if current == 1:
        return np.repeat(audio, channels, axis=1)
    mono = np.mean(audio, axis=1, keepdims=True)
    if channels == 1:
        return mono.astype(np.float32)
    return np.repeat(mono, channels, axis=1).astype(np.float32)


def _reject_invalid(audio: np.ndarray, filename: str) -> None:
    if not np.isfinite(audio).all():
        raise AnalysisError("invalid-samples", f"Unable to analyze {filename}", "The file contains invalid samples.")


def _unsupported(path: Path, exc: BaseException) -> AnalysisError:
    detail = str(exc).replace(str(path), path.name)
    return AnalysisError("unsupported-audio", f"Unable to analyze {path.name}", detail or "Unsupported sample encoding")
