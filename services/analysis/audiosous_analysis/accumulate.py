"""Chunked measurement state.

Callers feed short blocks and keep only this state. A long stem or a source
mix never has to sit in memory as one array.
"""

from __future__ import annotations

import math

import numpy as np
import pyloudnorm as pyln
from scipy.signal import lfilter, welch

from audiosous_analysis import ANALYSIS_ENGINE_VERSION, ANALYSIS_SCHEMA_VERSION
from audiosous_analysis.bands import band_energy
from audiosous_analysis.visuals import (
    SPECTROGRAM_BANDS,
    SPECTROGRAM_COLUMNS,
    TIMELINE_POINTS,
    frequency_edges,
    spectrum_points,
    summed_band_db,
)

SPECTRUM_NPERSEG = 8192
SPECTROGRAM_PIECE = 8192
ONSET_RISE_DB = 6.0
ONSET_FLOOR_DB = -40.0
ACTIVE_FLOOR_DB = -60.0
SILENCE_FLOOR_DB = -120.0
MAX_DYNAMIC_RANGE_DB = 120.0
SILENCE_LINEAR = 1e-10


class Accumulator:
    def __init__(self, sample_rate: int, channels: int, total_frames: int) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.total_frames = max(0, total_frames)
        self.seen = 0
        self.peak = 0.0
        self.sum_squares = 0.0
        self.sample_count = 0
        self.left_squares = 0.0
        self.right_squares = 0.0
        self.cross = 0.0
        self.mid_squares = 0.0
        self.side_squares = 0.0
        self.stereo_count = 0
        self.loudness = _LoudnessBlocks(sample_rate, channels, total_frames)
        self._spectrum_nperseg = min(SPECTRUM_NPERSEG, total_frames) if total_frames >= 16 else 0
        self._spectrum_buffer = np.zeros((0, channels), dtype=np.float64)
        self._freqs: np.ndarray | None = None
        self._power_sum: np.ndarray | None = None
        self._power_count = 0
        self._timeline_window = max(1, math.ceil(total_frames / TIMELINE_POINTS)) if total_frames else 1
        self._timeline_sum = 0.0
        self._timeline_count = 0
        self._timeline_origin = 0
        self.timeline: list[dict[str, float | None]] = []
        hop = max(32, math.ceil(total_frames / SPECTROGRAM_COLUMNS)) if total_frames else 32
        self._spec_hop = hop
        self._spec_into = 0
        self._spec_cursor = 0
        self._spec_piece = np.zeros(0, dtype=np.float64)
        self._column_sums: list[np.ndarray] = []
        self._column_weights: list[float] = []
        self._column_times: list[float] = []
        self._edges = frequency_edges(sample_rate, SPECTROGRAM_BANDS)
        self._onset_hop = max(1, int(round(0.01 * sample_rate)))
        self._onset_sum = 0.0
        self._onset_count = 0
        self._onset_previous = -200.0
        self._onset_wait = 0
        self.onset_count = 0

    def add(self, audio: np.ndarray) -> None:
        if audio.size == 0:
            return
        block = np.asarray(audio, dtype=np.float32)
        if block.ndim == 1:
            block = block.reshape(-1, 1)
        self.seen += int(block.shape[0])
        self.peak = max(self.peak, float(np.max(np.abs(block))))
        squared = np.square(block.astype(np.float64))
        self.sum_squares += float(np.sum(squared))
        self.sample_count += int(squared.size)
        self._add_stereo(block, squared)
        self.loudness.add(block)
        mono = np.mean(block.astype(np.float64), axis=1)
        self._add_timeline(mono)
        self._add_onsets(mono)
        self._add_spectrum(block.astype(np.float64))
        self._add_spectrogram(mono)

    def finish(self, scope: dict) -> dict:
        self._flush_timeline()
        integrated, lufs_status = self._levels_lufs()
        peak_db = _to_dbfs(self.peak)
        rms = math.sqrt(self.sum_squares / self.sample_count) if self.sample_count else 0.0
        rms_db = _to_dbfs(rms)
        crest = None if peak_db is None or rms_db is None else round(max(0.0, peak_db - rms_db), 2)
        freqs = self._freqs if self._freqs is not None else np.zeros(0)
        power = (self._power_sum / self._power_count) if self._power_sum is not None and self._power_count else np.zeros(0)
        duration = self.seen / self.sample_rate if self.sample_rate else 0.0
        return {
            "schemaVersion": ANALYSIS_SCHEMA_VERSION,
            "analysisVersion": ANALYSIS_ENGINE_VERSION,
            "scope": scope,
            "source": {
                "sampleRate": self.sample_rate,
                "channelCount": self.channels,
                "durationSeconds": round(duration, 6),
                "frameCount": self.seen,
            },
            "levels": {
                "peakDbfs": _clamp_db(peak_db),
                "rmsDbfs": _clamp_db(rms_db),
                "integratedLufs": _clamp_db(integrated),
                "crestFactorDb": crest,
                "integratedLufsStatus": lufs_status,
            },
            "stereo": self._stereo(rms_db),
            "dynamics": self._dynamics(duration),
            "spectral": _spectral(freqs, power),
            "bandEnergy": band_energy(freqs, power),
            "spectrum": spectrum_points(freqs, power, self.sample_rate),
            "loudnessTimeline": self.timeline[:TIMELINE_POINTS],
            "spectrogram": self._spectrogram(),
        }

    def _add_stereo(self, block: np.ndarray, squared: np.ndarray) -> None:
        left = block[:, 0].astype(np.float64)
        if self.channels == 1:
            right = left
            side = np.zeros_like(left)
        else:
            right = block[:, 1].astype(np.float64)
            side = 0.5 * (left - right)
        mid = 0.5 * (left + right) if self.channels > 1 else left
        self.left_squares += float(np.sum(np.square(left)))
        self.right_squares += float(np.sum(np.square(right if self.channels > 1 else left)))
        if self.channels > 1:
            self.cross += float(np.sum(left * right))
        self.mid_squares += float(np.sum(np.square(mid)))
        self.side_squares += float(np.sum(np.square(side)))
        self.stereo_count += int(left.size)
        del squared

    def _add_timeline(self, mono: np.ndarray) -> None:
        offset = 0
        while offset < mono.size and len(self.timeline) < TIMELINE_POINTS:
            need = self._timeline_window - self._timeline_count
            take = mono[offset : offset + need]
            self._timeline_sum += float(np.sum(np.square(take)))
            self._timeline_count += int(take.size)
            offset += int(take.size)
            if self._timeline_count >= self._timeline_window:
                self._emit_timeline(self._timeline_origin)
                self._timeline_origin += self._timeline_count
                self._timeline_sum = 0.0
                self._timeline_count = 0

    def _flush_timeline(self) -> None:
        if self._timeline_count > 0 and len(self.timeline) < TIMELINE_POINTS:
            self._emit_timeline(self._timeline_origin)

    def _emit_timeline(self, origin: int) -> None:
        mean_square = self._timeline_sum / self._timeline_count if self._timeline_count else 0.0
        rms = math.sqrt(mean_square) if mean_square > 0.0 else 0.0
        self.timeline.append(
            {
                "timeSeconds": round(origin / self.sample_rate, 4),
                "rmsDbfs": None if rms <= SILENCE_LINEAR else round(max(-200.0, min(40.0, 20.0 * math.log10(rms))), 2),
            }
        )

    def _add_onsets(self, mono: np.ndarray) -> None:
        offset = 0
        while offset < mono.size:
            need = self._onset_hop - self._onset_count
            take = mono[offset : offset + need]
            self._onset_sum += float(np.sum(np.square(take)))
            self._onset_count += int(take.size)
            offset += int(take.size)
            if self._onset_count < self._onset_hop:
                continue
            mean_square = self._onset_sum / self._onset_count
            rms = math.sqrt(mean_square) if mean_square > 0.0 else 0.0
            current = -200.0 if rms <= SILENCE_LINEAR else 20.0 * math.log10(rms)
            if self._onset_wait > 0:
                self._onset_wait -= self._onset_count
            elif current >= ONSET_FLOOR_DB and current - self._onset_previous >= ONSET_RISE_DB:
                self.onset_count += 1
                self._onset_wait = self._onset_hop * 5
            self._onset_previous = current
            self._onset_sum = 0.0
            self._onset_count = 0

    def _add_spectrum(self, block: np.ndarray) -> None:
        if self._spectrum_nperseg < 16:
            return
        self._spectrum_buffer = np.concatenate([self._spectrum_buffer, block])
        hop = max(1, self._spectrum_nperseg // 2)
        while self._spectrum_buffer.shape[0] >= self._spectrum_nperseg:
            frame = self._spectrum_buffer[: self._spectrum_nperseg]
            self._spectrum_buffer = self._spectrum_buffer[hop:]
            powers: list[np.ndarray] = []
            freqs: np.ndarray | None = None
            for channel in range(frame.shape[1]):
                freqs, power = welch(
                    frame[:, channel],
                    fs=self.sample_rate,
                    window="hann",
                    nperseg=self._spectrum_nperseg,
                    noverlap=0,
                    scaling="spectrum",
                    detrend=False,
                )
                powers.append(power)
            averaged = np.mean(powers, axis=0)
            if self._power_sum is None:
                self._freqs = freqs
                self._power_sum = averaged
            else:
                self._power_sum = self._power_sum + averaged
            self._power_count += 1

    def _add_spectrogram(self, mono: np.ndarray) -> None:
        if self._edges is None or self.total_frames < 32:
            return
        pending = mono
        while pending.size and len(self._column_times) < SPECTROGRAM_COLUMNS:
            room = self._spec_hop - self._spec_into
            take = pending[: min(room, SPECTROGRAM_PIECE, pending.size)]
            pending = pending[take.size :]
            if self._spec_into == 0 and len(self._column_times) == len(self._column_sums):
                self._column_times.append(round(self._spec_cursor / self.sample_rate, 4))
                self._column_sums.append(np.zeros(SPECTROGRAM_BANDS, dtype=np.float64))
                self._column_weights.append(0.0)
            self._spec_piece = np.concatenate([self._spec_piece, take])
            self._spec_into += int(take.size)
            self._spec_cursor += int(take.size)
            if self._spec_piece.size >= min(1024, max(16, room)) or self._spec_into >= self._spec_hop:
                self._fold_spectrogram_piece()
            if self._spec_into >= self._spec_hop:
                self._spec_into = 0

    def _fold_spectrogram_piece(self) -> None:
        if self._edges is None or self._spec_piece.size < 16:
            self._spec_piece = np.zeros(0, dtype=np.float64)
            return
        nperseg = min(1024, int(self._spec_piece.size))
        freqs, power = welch(
            self._spec_piece,
            fs=self.sample_rate,
            window="hann",
            nperseg=nperseg,
            noverlap=nperseg // 2,
            scaling="spectrum",
            detrend=False,
        )
        bands = np.array(summed_band_db(freqs, power, self._edges), dtype=np.float64)
        if not self._column_sums:
            self._spec_piece = np.zeros(0, dtype=np.float64)
            return
        linear = np.power(10.0, np.clip(bands, -200.0, 40.0) / 10.0)
        self._column_sums[-1] += linear * float(self._spec_piece.size)
        self._column_weights[-1] += float(self._spec_piece.size)
        self._spec_piece = np.zeros(0, dtype=np.float64)

    def _spectrogram(self) -> dict:
        high = min(20_000.0, self.sample_rate / 2) if self.sample_rate else 20_000.0
        columns = []
        for index, moment in enumerate(self._column_times):
            weight = self._column_weights[index]
            if weight <= 0:
                continue
            mean = self._column_sums[index] / weight
            magnitudes = [round(max(-200.0, min(40.0, 10.0 * math.log10(value))) if value > 0 else -200.0, 2) for value in mean]
            columns.append({"timeSeconds": moment, "magnitudesDb": magnitudes})
        return {
            "hopSeconds": round(self._spec_hop / self.sample_rate, 4) if self.sample_rate else 0.0,
            "lowHz": 20.0,
            "highHz": round(high if high > 20.0 else 20_000.0, 2),
            "bandCount": SPECTROGRAM_BANDS,
            "columns": columns,
        }

    def _levels_lufs(self) -> tuple[float | None, str]:
        if self.peak <= SILENCE_LINEAR:
            return None, "silent"
        duration = self.seen / self.sample_rate if self.sample_rate else 0.0
        if duration < 0.4:
            return None, "too-short"
        try:
            loudness = self.loudness.integrated()
        except ValueError:
            return None, "too-short"
        if not math.isfinite(loudness):
            return None, "silent"
        return round(float(loudness), 2), "measured"

    def _stereo(self, rms_db: float | None) -> dict:
        if self.stereo_count == 0 or rms_db is None:
            return {"balance": None, "correlation": None, "width": None, "midRmsDbfs": None, "sideRmsDbfs": None}
        left = math.sqrt(self.left_squares / self.stereo_count)
        right = math.sqrt(self.right_squares / self.stereo_count) if self.channels > 1 else left
        balance = None
        if left + right > SILENCE_LINEAR:
            balance = round(max(-1.0, min(1.0, (right - left) / (right + left))), 4)
        correlation = None
        if self.channels > 1:
            denom = math.sqrt(self.left_squares * self.right_squares)
            if denom > SILENCE_LINEAR:
                correlation = round(max(-1.0, min(1.0, self.cross / denom)), 4)
        mid = _to_dbfs(math.sqrt(self.mid_squares / self.stereo_count))
        side = None if self.channels == 1 else _to_dbfs(math.sqrt(self.side_squares / self.stereo_count))
        width = None
        total = self.mid_squares + self.side_squares
        if self.channels > 1 and total > SILENCE_LINEAR:
            width = round(max(0.0, min(1.0, self.side_squares / total)), 4)
        elif self.channels == 1:
            width = 0.0
        return {
            "balance": balance if self.channels > 1 else 0.0,
            "correlation": correlation,
            "width": width,
            "midRmsDbfs": _clamp_db(mid),
            "sideRmsDbfs": _clamp_db(side),
        }

    def _dynamics(self, duration: float) -> dict:
        # Windows of digital silence (a part resting) are not dynamic range; leave them out. The contract caps the
        # figure at 120 dB, so a file can never fail validation on it.
        finite = [float(point["rmsDbfs"]) for point in self.timeline if isinstance(point["rmsDbfs"], float) and point["rmsDbfs"] > SILENCE_FLOOR_DB]
        dynamic = None
        if len(finite) >= 2:
            low, high = np.percentile(finite, [10, 95])
            dynamic = round(min(MAX_DYNAMIC_RANGE_DB, max(0.0, float(high - low))), 2)
        active = 0
        for point in self.timeline:
            level = point["rmsDbfs"]
            if isinstance(level, float) and level >= ACTIVE_FLOOR_DB:
                active += 1
        total = len(self.timeline)
        active_percent = round(100.0 * active / total, 2) if total else 0.0
        density = round(self.onset_count / duration, 4) if duration > 0 else 0.0
        return {
            "dynamicRangeDb": dynamic,
            "onsetDensityPerSecond": density,
            "activePercent": active_percent,
            "silentPercent": round(100.0 - active_percent, 2),
        }


class _LoudnessBlocks:
    """ITU-R BS.1770 blocks, matching pyloudnorm's K-weighting and 400 ms gate."""

    def __init__(self, sample_rate: int, channels: int, total_frames: int) -> None:
        self.rate = sample_rate
        self.channels = min(channels, 5)
        self.total_frames = total_frames
        meter = pyln.Meter(sample_rate)
        filters = list(meter._filters.values())
        self.coeffs = [(item.b, item.a) for item in filters]
        self.zi = [
            [np.zeros(max(len(b), len(a)) - 1, dtype=np.float64) for _ in range(self.channels)] for b, a in self.coeffs
        ]
        self.filtered_from = 0
        self.filtered = np.zeros((0, self.channels), dtype=np.float64)
        duration = total_frames / sample_rate if sample_rate else 0.0
        block = 0.4
        step = 0.25
        if duration < block:
            self.bounds: list[tuple[int, int]] = []
        else:
            count = int(round(((duration - block) / (block * step))) + 1)
            self.bounds = [
                (int(block * (index * step) * sample_rate), int(block * (index * step + 1) * sample_rate)) for index in range(count)
            ]
        self.next_block = 0
        self.energy = np.zeros((self.channels, max(1, len(self.bounds))), dtype=np.float64)

    def add(self, block: np.ndarray) -> None:
        if not self.bounds:
            return
        filtered = np.empty((block.shape[0], self.channels), dtype=np.float64)
        for channel in range(self.channels):
            data = block[:, channel].astype(np.float64)
            for index, (b, a) in enumerate(self.coeffs):
                data, self.zi[index][channel] = lfilter(b, a, data, zi=self.zi[index][channel])
            filtered[:, channel] = data
        self.filtered = np.concatenate([self.filtered, filtered])
        end = self.filtered_from + int(self.filtered.shape[0])
        gate = 0.4 * self.rate
        while self.next_block < len(self.bounds) and self.bounds[self.next_block][1] <= end:
            start, stop = self.bounds[self.next_block]
            local_start = max(0, start - self.filtered_from)
            local_stop = max(0, stop - self.filtered_from)
            window = self.filtered[local_start:local_stop]
            for channel in range(self.channels):
                self.energy[channel, self.next_block] = float(np.sum(np.square(window[:, channel]))) / gate if window.size else 0.0
            self.next_block += 1
        if self.next_block < len(self.bounds):
            keep_from = self.bounds[self.next_block][0]
        else:
            keep_from = end
        drop = max(0, keep_from - self.filtered_from)
        if drop:
            self.filtered = self.filtered[drop:]
            self.filtered_from += drop

    def integrated(self) -> float:
        if not self.bounds:
            raise ValueError("too short")
        gains = [1.0, 1.0, 1.0, 1.41, 1.41]
        count = len(self.bounds)
        loud = []
        for block in range(count):
            total = sum(gains[channel] * self.energy[channel, block] for channel in range(self.channels))
            loud.append(-0.691 + 10.0 * math.log10(total) if total > 0 else -math.inf)
        absolute = [block for block, level in enumerate(loud) if level >= -70.0]
        if not absolute:
            return -math.inf
        gated = [float(np.mean(self.energy[channel, absolute])) for channel in range(self.channels)]
        relative = -0.691 + 10.0 * math.log10(sum(gains[channel] * gated[channel] for channel in range(self.channels))) - 10.0
        kept = [block for block, level in enumerate(loud) if level > relative and level > -70.0]
        if not kept:
            return -math.inf
        final = [float(np.mean(self.energy[channel, kept])) for channel in range(self.channels)]
        return -0.691 + 10.0 * math.log10(sum(gains[channel] * final[channel] for channel in range(self.channels)))


def _spectral(freqs: np.ndarray, power: np.ndarray) -> dict:
    empty = {"centroidHz": None, "bandwidthHz": None, "rolloffHz": None, "flatness": None}
    if freqs.size < 2 or power.size < 2:
        return empty
    mask = (freqs >= 20.0) & (power > 0.0) & np.isfinite(power)
    if not np.any(mask):
        return empty
    used_f = freqs[mask].astype(np.float64)
    used_p = power[mask].astype(np.float64)
    total = float(np.sum(used_p))
    if total <= 0.0:
        return empty
    centroid = float(np.sum(used_f * used_p) / total)
    bandwidth = math.sqrt(float(np.sum(np.square(used_f - centroid) * used_p) / total))
    cumulative = np.cumsum(used_p) / total
    rolloff_index = int(np.searchsorted(cumulative, 0.85, side="left"))
    rolloff_index = min(rolloff_index, used_f.size - 1)
    geometric = math.exp(float(np.mean(np.log(np.maximum(used_p, 1e-20)))))
    flatness = max(0.0, min(1.0, geometric / (total / used_p.size)))
    return {
        "centroidHz": round(centroid, 2),
        "bandwidthHz": round(bandwidth, 2),
        "rolloffHz": round(float(used_f[rolloff_index]), 2),
        "flatness": round(flatness, 4),
    }


def _to_dbfs(linear: float) -> float | None:
    if linear <= SILENCE_LINEAR or not math.isfinite(linear):
        return None
    decibels = 20.0 * math.log10(linear)
    if not math.isfinite(decibels):
        return None
    return round(decibels, 2)


def _clamp_db(value: float | None) -> float | None:
    if value is None:
        return None
    return round(max(-200.0, min(80.0, value)), 2)
