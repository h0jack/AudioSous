"""Downsampled drawings derived from one measurement.

Spectrum, loudness timeline, and spectrogram stay small enough for one JSON
response. They describe the audio that was measured. They do not suggest a mix.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import welch

SPECTRUM_BINS = 48
TIMELINE_POINTS = 160
SPECTROGRAM_BANDS = 24
SPECTROGRAM_COLUMNS = 80
F_MIN = 20.0
F_MAX = 20_000.0
DB_FLOOR = -200.0
DB_CEILING = 40.0


def spectrum_points(freqs: np.ndarray, power: np.ndarray, sample_rate: int) -> list[dict[str, float]]:
    if freqs.size < 2 or power.size < 2:
        return []
    nyquist = sample_rate / 2
    high = min(F_MAX, nyquist)
    if high <= F_MIN:
        return []
    edges = np.geomspace(F_MIN, high, SPECTRUM_BINS + 1)
    points: list[dict[str, float]] = []
    for index in range(SPECTRUM_BINS):
        low = float(edges[index])
        upper = float(edges[index + 1])
        if index == SPECTRUM_BINS - 1:
            mask = (freqs >= low) & (freqs <= upper)
        else:
            mask = (freqs >= low) & (freqs < upper)
        magnitude = float(np.mean(power[mask])) if np.any(mask) else 0.0
        points.append({"hz": round(math.sqrt(low * upper), 2), "magnitudeDb": _power_db(magnitude)})
    return points


def loudness_timeline(audio: np.ndarray, sample_rate: int) -> list[dict[str, float | None]]:
    frames = int(audio.shape[0])
    if frames == 0 or sample_rate <= 0:
        return []
    mono = np.mean(audio.astype(np.float64), axis=1)
    window = max(1, math.ceil(frames / TIMELINE_POINTS))
    points: list[dict[str, float | None]] = []
    for start in range(0, frames, window):
        if len(points) >= TIMELINE_POINTS:
            break
        chunk = mono[start : start + window]
        mean_square = float(np.mean(np.square(chunk))) if chunk.size else 0.0
        rms = math.sqrt(mean_square) if mean_square > 0.0 else 0.0
        points.append(
            {
                "timeSeconds": round(start / sample_rate, 4),
                "rmsDbfs": None if rms <= 1e-10 else round(max(DB_FLOOR, min(DB_CEILING, 20.0 * math.log10(rms))), 2),
            }
        )
    return points


def spectrogram(audio: np.ndarray, sample_rate: int) -> dict[str, float | int | list[dict[str, float | list[float]]]]:
    frames = int(audio.shape[0])
    empty: dict[str, float | int | list] = {
        "hopSeconds": 0.0,
        "lowHz": F_MIN,
        "highHz": min(F_MAX, sample_rate / 2) if sample_rate > 0 else F_MAX,
        "bandCount": SPECTROGRAM_BANDS,
        "columns": [],
    }
    if frames < 32 or sample_rate <= 0:
        return empty
    mono = np.mean(audio.astype(np.float64), axis=1)
    hop = max(32, math.ceil(frames / SPECTROGRAM_COLUMNS))
    high = min(F_MAX, sample_rate / 2)
    if high <= F_MIN:
        return empty
    edges = np.geomspace(F_MIN, high, SPECTROGRAM_BANDS + 1)
    columns: list[dict[str, float | list[float]]] = []
    for start in range(0, frames, hop):
        if len(columns) >= SPECTROGRAM_COLUMNS:
            break
        chunk = mono[start : start + hop]
        if chunk.size < 16:
            break
        nperseg = min(1024, int(chunk.size))
        freqs, power = welch(
            chunk,
            fs=sample_rate,
            window="hann",
            nperseg=nperseg,
            noverlap=nperseg // 2,
            scaling="spectrum",
            detrend=False,
        )
        magnitudes: list[float] = []
        for index in range(SPECTROGRAM_BANDS):
            low = float(edges[index])
            upper = float(edges[index + 1])
            if index == SPECTROGRAM_BANDS - 1:
                mask = (freqs >= low) & (freqs <= upper)
            else:
                mask = (freqs >= low) & (freqs < upper)
            magnitude = float(np.sum(power[mask])) if np.any(mask) else 0.0
            magnitudes.append(_power_db(magnitude))
        columns.append({"timeSeconds": round(start / sample_rate, 4), "magnitudesDb": magnitudes})
    return {
        "hopSeconds": round(hop / sample_rate, 4),
        "lowHz": F_MIN,
        "highHz": round(high, 2),
        "bandCount": SPECTROGRAM_BANDS,
        "columns": columns,
    }


def _power_db(power: float) -> float:
    if power <= 0.0 or not math.isfinite(power):
        return DB_FLOOR
    return round(max(DB_FLOOR, min(DB_CEILING, 10.0 * math.log10(power))), 2)
