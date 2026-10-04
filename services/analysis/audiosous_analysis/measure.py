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

ANALYSIS_SCHEMA_VERSION = 1
ANALYSIS_ENGINE_VERSION = "0.2.0"
# One stem at a time. 10 minutes of 48 kHz stereo is about 58 million samples.
MAX_SAMPLES = 250_000_000
SILENCE_LINEAR = 1e-10
LUFS_MIN_SECONDS = 0.4


def measure_file(path: Path) -> dict:
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
    return measure_audio(audio, int(sample_rate))


def measure_audio(audio: np.ndarray, sample_rate: int) -> dict:
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
    return {
        "schemaVersion": ANALYSIS_SCHEMA_VERSION,
        "analysisVersion": ANALYSIS_ENGINE_VERSION,
        "scope": {"type": "track"},
        "source": {
            "sampleRate": sample_rate,
            "channelCount": channels,
            "durationSeconds": round(duration, 6),
            "frameCount": frames,
        },
        "levels": {
            "peakDbfs": peak_db,
            "rmsDbfs": rms_db,
            "integratedLufs": integrated,
            "crestFactorDb": crest,
            "integratedLufsStatus": lufs_status,
        },
        "bandEnergy": _bands(audio, sample_rate),
    }


def _bands(audio: np.ndarray, sample_rate: int) -> list[dict[str, float | str]]:
    if audio.shape[0] < 16:
        return band_energy(np.zeros(0), np.zeros(0))
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
    return band_energy(freqs if freqs is not None else np.zeros(0), averaged)


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
