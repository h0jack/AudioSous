"""Whole-file level, loudness, and band-energy measurements.

The numbers are raw measurements. Nothing here decides whether a stem is too loud,
too wide, or in need of EQ.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import welch

from audiosous_analysis.bands import band_energy
from audiosous_analysis.errors import AnalysisError
from audiosous_analysis.visuals import loudness_timeline, spectrogram, spectrum_points

ANALYSIS_SCHEMA_VERSION = 2
ANALYSIS_ENGINE_VERSION = "0.3.0"
MAX_MIX_FILES = 32
# One stem at a time. 10 minutes of 48 kHz stereo is about 58 million samples.
MAX_SAMPLES = 250_000_000
SILENCE_LINEAR = 1e-10
LUFS_MIN_SECONDS = 0.4


def measure_file(path: Path, scope: dict | None = None) -> dict:
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
        raise AnalysisError(
            "too-large",
            f"Unable to analyze {path.name}",
            "This stem is too long to measure in one pass.",
        )
    try:
        with path.open("rb") as handle:
            audio, sample_rate = sf.read(handle, always_2d=True, dtype="float32")
    except sf.LibsndfileError as exc:
        raise _unsupported(path, exc) from exc
    if audio.size == 0:
        raise AnalysisError("empty-audio", f"Unable to analyze {path.name}", "The file has no audio samples.")
    if not np.isfinite(audio).all():
        raise AnalysisError("invalid-samples", f"Unable to analyze {path.name}", "The file contains invalid samples.")
    window, reported = _apply_scope(audio, int(sample_rate), scope, path.name)
    return measure_audio(window, int(sample_rate), reported)


def measure_mix(paths: list[Path]) -> dict:
    if not paths:
        raise AnalysisError("invalid-request", "The mix measurement needs at least one stem.", "")
    if len(paths) > MAX_MIX_FILES:
        raise AnalysisError("too-large", "Unable to measure this mix.", "Too many stems were included.")
    pieces: list[np.ndarray] = []
    sample_rate: int | None = None
    channels: int | None = None
    total_samples = 0
    longest = 0
    for path in paths:
        audio, rate = _read_audio(path)
        if sample_rate is None:
            sample_rate = rate
        elif rate != sample_rate:
            raise AnalysisError(
                "mixed-sample-rate",
                "Unable to measure this mix.",
                "Every stem in the mix measurement has to use the same sample rate.",
            )
        if channels is None:
            channels = int(audio.shape[1])
        audio = _match_channels(audio, channels)
        total_samples += int(audio.shape[0]) * int(audio.shape[1])
        if total_samples > MAX_SAMPLES:
            raise AnalysisError("too-large", "Unable to measure this mix.", "The stems are too long to sum in one pass.")
        longest = max(longest, int(audio.shape[0]))
        pieces.append(audio)
    assert sample_rate is not None and channels is not None
    mixed = np.zeros((longest, channels), dtype=np.float64)
    for piece in pieces:
        mixed[: piece.shape[0]] += piece
    return measure_audio(mixed.astype(np.float32), sample_rate, {"type": "mix"})


def _read_audio(path: Path) -> tuple[np.ndarray, int]:
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
    try:
        with path.open("rb") as handle:
            audio, sample_rate = sf.read(handle, always_2d=True, dtype="float32")
    except sf.LibsndfileError as exc:
        raise _unsupported(path, exc) from exc
    if audio.size == 0:
        raise AnalysisError("empty-audio", f"Unable to analyze {path.name}", "The file has no audio samples.")
    if not np.isfinite(audio).all():
        raise AnalysisError("invalid-samples", f"Unable to analyze {path.name}", "The file contains invalid samples.")
    return audio, int(sample_rate)


def _apply_scope(audio: np.ndarray, sample_rate: int, scope: dict | None, filename: str) -> tuple[np.ndarray, dict]:
    reported = {"type": "track"}
    if not scope or scope.get("type") in (None, "track"):
        return audio, reported
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
    start_frame = min(int(audio.shape[0]), max(0, int(round(start * sample_rate))))
    end_frame = min(int(audio.shape[0]), max(0, int(round(end * sample_rate))))
    if end_frame <= start_frame:
        raise AnalysisError("empty-audio", f"Unable to analyze {filename}", "The selection does not contain audio.")
    return audio[start_frame:end_frame], {
        "type": kind,
        "startSeconds": round(start_frame / sample_rate, 6),
        "endSeconds": round(end_frame / sample_rate, 6),
    }


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


def measure_audio(audio: np.ndarray, sample_rate: int, scope: dict | None = None) -> dict:
    if audio.ndim != 2 or sample_rate <= 0:
        raise AnalysisError("invalid-samples", "Unable to analyze this stem.", "Audio samples were not readable.")
    frames = int(audio.shape[0])
    channels = int(audio.shape[1])
    duration = frames / sample_rate
    peak = float(np.max(np.abs(audio))) if frames else 0.0
    mean_square = float(np.mean(np.square(audio.astype(np.float64)))) if frames else 0.0
    rms = math.sqrt(mean_square) if mean_square > 0.0 else 0.0
    peak_db = _to_dbfs(peak)
    rms_db = _to_dbfs(rms)
    crest = None if peak_db is None or rms_db is None else round(max(0.0, peak_db - rms_db), 2)
    integrated, lufs_status = _integrated_lufs(audio, sample_rate, duration, peak_db is None)
    freqs, power = _average_spectrum(audio, sample_rate)
    return {
        "schemaVersion": ANALYSIS_SCHEMA_VERSION,
        "analysisVersion": ANALYSIS_ENGINE_VERSION,
        "scope": scope or {"type": "track"},
        "source": {
            "sampleRate": sample_rate,
            "channelCount": channels,
            "durationSeconds": round(duration, 6),
            "frameCount": frames,
        },
        "levels": {
            "peakDbfs": _clamp_db(peak_db),
            "rmsDbfs": _clamp_db(rms_db),
            "integratedLufs": _clamp_db(integrated),
            "crestFactorDb": crest,
            "integratedLufsStatus": lufs_status,
        },
        "bandEnergy": band_energy(freqs, power) if freqs.size else band_energy(np.zeros(0), np.zeros(0)),
        "spectrum": spectrum_points(freqs, power, sample_rate),
        "loudnessTimeline": loudness_timeline(audio, sample_rate),
        "spectrogram": spectrogram(audio, sample_rate),
    }


def _average_spectrum(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    if audio.shape[0] < 16:
        return np.zeros(0), np.zeros(0)
    nperseg = min(8192, int(audio.shape[0]))
    noverlap = nperseg // 2
    spectra: list[np.ndarray] = []
    freqs: np.ndarray | None = None
    for channel in range(audio.shape[1]):
        freqs, power = welch(
            audio[:, channel].astype(np.float64),
            fs=sample_rate,
            window="hann",
            nperseg=nperseg,
            noverlap=noverlap,
            scaling="spectrum",
            detrend=False,
        )
        spectra.append(power)
    averaged = np.mean(spectra, axis=0) if spectra else np.zeros(0)
    return freqs if freqs is not None else np.zeros(0), averaged


def _integrated_lufs(audio: np.ndarray, sample_rate: int, duration: float, silent: bool) -> tuple[float | None, str]:
    if silent:
        return None, "silent"
    if duration < LUFS_MIN_SECONDS:
        return None, "too-short"
    try:
        meter = pyln.Meter(sample_rate)
        loudness = float(meter.integrated_loudness(audio.astype(np.float64)))
    except ValueError:
        return None, "too-short"
    if not math.isfinite(loudness):
        return None, "silent"
    return round(loudness, 2), "measured"


def _clamp_db(value: float | None) -> float | None:
    if value is None:
        return None
    return round(max(-200.0, min(80.0, value)), 2)


def _to_dbfs(linear: float) -> float | None:
    if linear <= SILENCE_LINEAR or not math.isfinite(linear):
        return None
    decibels = 20.0 * math.log10(linear)
    if not math.isfinite(decibels):
        return None
    return round(decibels, 2)


def _unsupported(path: Path, exc: BaseException) -> AnalysisError:
    detail = str(exc).replace(str(path), path.name)
    return AnalysisError("unsupported-audio", f"Unable to analyze {path.name}", detail or "Unsupported sample encoding")
