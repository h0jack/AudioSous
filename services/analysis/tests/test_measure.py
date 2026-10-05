"""Regression ranges for synthetic stems. Tolerances are intentional."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from audiosous_analysis.bands import FREQUENCY_BANDS
from audiosous_analysis.errors import AnalysisError
from audiosous_analysis.measure import measure_file, measure_mix

SAMPLE_RATE = 48_000
ROOT = Path(__file__).resolve().parents[1]


def _tone(frequency: float, seconds: float = 2.0, amplitude: float = 0.5, channels: int = 1) -> np.ndarray:
    frames = int(SAMPLE_RATE * seconds)
    time = np.arange(frames) / SAMPLE_RATE
    mono = amplitude * np.sin(2 * math.pi * frequency * time)
    if channels == 1:
        return mono.astype(np.float32)
    return np.column_stack([mono, mono]).astype(np.float32)


def _write(path: Path, audio: np.ndarray) -> None:
    sf.write(path, audio, SAMPLE_RATE, subtype="FLOAT")


def _share(measurement: dict, band_id: str) -> float:
    for band in measurement["bandEnergy"]:
        if band["id"] == band_id:
            return float(band["normalizedEnergy"])
    raise AssertionError(band_id)


def _assert_finite_measurement(measurement: dict) -> None:
    encoded = json.dumps(measurement, allow_nan=False)
    parsed = json.loads(encoded)
    assert parsed["schemaVersion"] == 3
    assert parsed["analysisVersion"] == "0.4.0"
    for point in parsed["loudnessTimeline"]:
        assert point["rmsDbfs"] is None or math.isfinite(point["rmsDbfs"])
    assert math.isfinite(parsed["dynamics"]["onsetDensityPerSecond"])
    assert [band["id"] for band in parsed["bandEnergy"]] == [band[0] for band in FREQUENCY_BANDS]
    shares = [band["normalizedEnergy"] for band in parsed["bandEnergy"]]
    assert all(math.isfinite(share) and 0.0 <= share <= 1.0 for share in shares)


def test_band_edges_match_the_shared_model():
    assert [(band[2], band[3]) for band in FREQUENCY_BANDS] == [
        (20.0, 60.0),
        (60.0, 120.0),
        (120.0, 250.0),
        (250.0, 500.0),
        (500.0, 2_000.0),
        (2_000.0, 5_000.0),
        (5_000.0, 10_000.0),
        (10_000.0, 20_000.0),
    ]


def test_pure_tones_concentrate_in_the_expected_bands(tmp_path: Path):
    cases = (
        (50.0, "sub"),
        (100.0, "bass"),
        (1_000.0, "upper-mid"),
        (8_000.0, "brilliance"),
        (14_000.0, "air"),
    )
    for frequency, band_id in cases:
        path = tmp_path / f"{band_id}.wav"
        _write(path, _tone(frequency))
        measurement = measure_file(path)
        _assert_finite_measurement(measurement)
        assert _share(measurement, band_id) > 0.8


def test_white_noise_puts_more_energy_in_the_wider_high_bands(tmp_path: Path):
    rng = np.random.default_rng(1)
    path = tmp_path / "white.wav"
    _write(path, rng.uniform(-0.2, 0.2, SAMPLE_RATE * 2).astype(np.float32))
    measurement = measure_file(path)
    _assert_finite_measurement(measurement)
    assert _share(measurement, "air") > _share(measurement, "sub") * 5


def test_ten_kilohertz_lands_in_the_top_bands(tmp_path: Path):
    path = tmp_path / "high.wav"
    _write(path, _tone(10_000.0))
    measurement = measure_file(path)
    top = _share(measurement, "brilliance") + _share(measurement, "air")
    assert top > 0.85


def test_silence_has_no_invalid_levels(tmp_path: Path):
    path = tmp_path / "silence.wav"
    _write(path, np.zeros(SAMPLE_RATE, dtype=np.float32))
    measurement = measure_file(path)
    _assert_finite_measurement(measurement)
    levels = measurement["levels"]
    assert levels["peakDbfs"] is None
    assert levels["rmsDbfs"] is None
    assert levels["integratedLufs"] is None
    assert levels["crestFactorDb"] is None
    assert levels["integratedLufsStatus"] == "silent"
    assert sum(band["normalizedEnergy"] for band in measurement["bandEnergy"]) == 0


def test_louder_tone_reports_higher_rms(tmp_path: Path):
    quiet = tmp_path / "quiet.wav"
    loud = tmp_path / "loud.wav"
    _write(quiet, _tone(1_000.0, amplitude=0.1))
    _write(loud, _tone(1_000.0, amplitude=0.5))
    quiet_rms = measure_file(quiet)["levels"]["rmsDbfs"]
    loud_rms = measure_file(loud)["levels"]["rmsDbfs"]
    assert quiet_rms is not None and loud_rms is not None
    assert loud_rms > quiet_rms + 10


def test_sine_levels_and_lufs_are_near_the_known_signal(tmp_path: Path):
    path = tmp_path / "reference.wav"
    # Peak -20 dBFS. A sine's RMS is 3.01 dB lower. K-weighting is about 0 dB at 1 kHz,
    # so integrated loudness sits near the RMS, not the peak.
    amplitude = 10 ** (-20 / 20)
    _write(path, _tone(1_000.0, amplitude=amplitude))
    levels = measure_file(path)["levels"]
    assert levels["peakDbfs"] == pytest_approx(-20, abs=0.2)
    assert levels["rmsDbfs"] == pytest_approx(-23.01, abs=0.3)
    assert levels["crestFactorDb"] == pytest_approx(3.01, abs=0.2)
    assert levels["integratedLufsStatus"] == "measured"
    assert levels["integratedLufs"] == pytest_approx(-23.01, abs=1.0)
    louder = tmp_path / "louder.wav"
    _write(louder, _tone(1_000.0, amplitude=amplitude * 2))
    louder_lufs = measure_file(louder)["levels"]["integratedLufs"]
    assert louder_lufs is not None and levels["integratedLufs"] is not None
    assert louder_lufs > levels["integratedLufs"] + 5


def test_impulse_train_has_a_larger_crest_factor_than_a_sine(tmp_path: Path):
    sine = tmp_path / "sine.wav"
    clicks = tmp_path / "clicks.wav"
    _write(sine, _tone(1_000.0, amplitude=0.5))
    frames = SAMPLE_RATE * 2
    impulse = np.zeros(frames, dtype=np.float32)
    impulse[:: SAMPLE_RATE // 10] = 0.9
    _write(clicks, impulse)
    sine_crest = measure_file(sine)["levels"]["crestFactorDb"]
    click_crest = measure_file(clicks)["levels"]["crestFactorDb"]
    assert sine_crest is not None and click_crest is not None
    assert click_crest > sine_crest + 10


def test_stereo_file_reports_both_channels_and_keeps_the_bytes(tmp_path: Path):
    path = tmp_path / "stereo.wav"
    _write(path, _tone(100.0, channels=2))
    before = path.read_bytes()
    measurement = measure_file(path)
    assert path.read_bytes() == before
    assert measurement["source"]["channelCount"] == 2
    assert _share(measurement, "bass") > 0.8


def test_repeated_measurement_matches(tmp_path: Path):
    path = tmp_path / "steady.wav"
    _write(path, _tone(100.0))
    assert measure_file(path) == measure_file(path)


def test_unreadable_bytes_become_an_analysis_error(tmp_path: Path):
    path = tmp_path / "notes.wav"
    path.write_bytes(b"this is not audio")
    try:
        measure_file(path)
    except AnalysisError as error:
        assert error.code == "unsupported-audio"
        assert error.message == "Unable to analyze notes.wav"
        assert str(path) not in error.detail
    else:
        raise AssertionError("expected an analysis error")


def test_sidecar_returns_json_for_one_wav(tmp_path: Path):
    path = tmp_path / "bass.wav"
    _write(path, _tone(100.0))
    completed = subprocess.run(
        [sys.executable, "-m", "audiosous_analysis"],
        input=json.dumps({"contractVersion": 1, "operation": "analyze_track", "audioPath": str(path)}),
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["contractVersion"] == 1
    assert payload["measurement"]["bandEnergy"][1]["normalizedEnergy"] > 0.8


def test_one_kilohertz_is_louder_in_the_spectrum_than_a_low_bin(tmp_path: Path):
    path = tmp_path / "mid.wav"
    _write(path, _tone(1_000.0))
    spectrum = measure_file(path)["spectrum"]
    assert len(spectrum) > 8
    loudest = max(spectrum, key=lambda point: point["magnitudeDb"])
    low = min(spectrum, key=lambda point: abs(point["hz"] - 100.0))
    assert 400 < loudest["hz"] < 2_500
    assert loudest["magnitudeDb"] > low["magnitudeDb"] + 10


def test_section_window_keeps_the_tone_and_draws_time(tmp_path: Path):
    path = tmp_path / "gated.wav"
    audio = np.zeros(SAMPLE_RATE * 4, dtype=np.float32)
    audio[SAMPLE_RATE : SAMPLE_RATE * 3] = _tone(1_000.0)
    _write(path, audio)
    measurement = measure_file(path, {"type": "section", "startSeconds": 1.0, "endSeconds": 3.0})
    _assert_finite_measurement(measurement)
    assert measurement["scope"]["type"] == "section"
    assert measurement["scope"]["startSeconds"] == pytest_approx(1.0, abs=0.01)
    assert _share(measurement, "upper-mid") > 0.5
    assert len(measurement["loudnessTimeline"]) > 1
    assert measurement["spectrogram"]["columns"]
    assert measurement["spectrogram"]["bandCount"] == len(measurement["spectrogram"]["columns"][0]["magnitudesDb"])


def test_range_past_the_file_is_empty(tmp_path: Path):
    path = tmp_path / "short.wav"
    _write(path, _tone(100.0, seconds=0.5))
    try:
        measure_file(path, {"type": "time-range", "startSeconds": 4.0, "endSeconds": 5.0})
    except AnalysisError as error:
        assert error.code == "empty-audio"
    else:
        raise AssertionError("expected an analysis error")


def test_mix_of_bass_and_mid_keeps_both_bands(tmp_path: Path):
    bass = tmp_path / "bass.wav"
    mid = tmp_path / "mid.wav"
    _write(bass, _tone(100.0))
    _write(mid, _tone(1_000.0))
    measurement = measure_mix([bass, mid])
    _assert_finite_measurement(measurement)
    assert measurement["scope"] == {"type": "mix"}
    assert _share(measurement, "bass") > 0.2
    assert _share(measurement, "upper-mid") > 0.2


def test_sidecar_measures_a_mix(tmp_path: Path):
    bass = tmp_path / "bass.wav"
    mid = tmp_path / "mid.wav"
    _write(bass, _tone(100.0))
    _write(mid, _tone(1_000.0))
    completed = subprocess.run(
        [sys.executable, "-m", "audiosous_analysis"],
        input=json.dumps({"contractVersion": 1, "operation": "analyze_mix", "audioPaths": [str(bass), str(mid)]}),
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["measurement"]["scope"]["type"] == "mix"


def test_one_kilohertz_centroid_stays_near_the_tone(tmp_path: Path):
    path = tmp_path / "mid.wav"
    _write(path, _tone(1_000.0))
    spectral = measure_file(path)["spectral"]
    assert spectral["centroidHz"] == pytest_approx(1_000.0, abs=150.0)
    assert spectral["rolloffHz"] >= spectral["centroidHz"]
    dynamics = measure_file(path)["dynamics"]
    assert dynamics["dynamicRangeDb"] is not None and dynamics["dynamicRangeDb"] < 3.0
    assert dynamics["onsetDensityPerSecond"] < 2.0
    assert dynamics["activePercent"] > 90.0


def test_stereo_balance_correlation_and_width(tmp_path: Path):
    frames = SAMPLE_RATE * 2
    time = np.arange(frames) / SAMPLE_RATE
    left = (0.4 * np.sin(2 * math.pi * 440.0 * time)).astype(np.float32)
    right = left.copy()
    matched = tmp_path / "matched.wav"
    _write(matched, np.column_stack([left, right]))
    stereo = measure_file(matched)["stereo"]
    assert stereo["balance"] == pytest_approx(0.0, abs=0.05)
    assert stereo["correlation"] > 0.98
    assert stereo["width"] < 0.05
    assert stereo["midRmsDbfs"] is not None
    assert stereo["sideRmsDbfs"] is None or stereo["sideRmsDbfs"] < stereo["midRmsDbfs"] - 20
    left_only = tmp_path / "left.wav"
    _write(left_only, np.column_stack([left, np.zeros(frames, dtype=np.float32)]))
    assert measure_file(left_only)["stereo"]["balance"] < -0.8
    opposite = tmp_path / "opposite.wav"
    _write(opposite, np.column_stack([left, -left]))
    assert measure_file(opposite)["stereo"]["correlation"] < -0.98
    assert measure_file(opposite)["stereo"]["width"] > 0.9


def test_impulses_are_denser_than_a_steady_tone(tmp_path: Path):
    frames = SAMPLE_RATE * 2
    impulse = np.zeros(frames, dtype=np.float32)
    impulse[:: SAMPLE_RATE // 10] = 0.9
    clicks = tmp_path / "clicks.wav"
    tone = tmp_path / "steady.wav"
    _write(clicks, impulse)
    _write(tone, _tone(1_000.0))
    click_density = measure_file(clicks)["dynamics"]["onsetDensityPerSecond"]
    tone_density = measure_file(tone)["dynamics"]["onsetDensityPerSecond"]
    assert click_density > tone_density + 4


def test_silence_is_inactive_and_has_no_spectral_center(tmp_path: Path):
    path = tmp_path / "silence.wav"
    _write(path, np.zeros(SAMPLE_RATE, dtype=np.float32))
    measurement = measure_file(path)
    assert measurement["dynamics"]["activePercent"] == 0
    assert measurement["dynamics"]["silentPercent"] == 100
    assert measurement["spectral"]["centroidHz"] is None
    assert measurement["stereo"]["balance"] is None
    assert measurement["stereo"]["correlation"] is None


def test_chunked_blocks_match_one_pass_levels():
    from audiosous_analysis.accumulate import Accumulator

    audio = _tone(1_000.0, seconds=1.0)
    whole = Accumulator(SAMPLE_RATE, 1, audio.shape[0])
    whole.add(audio.reshape(-1, 1))
    parts = Accumulator(SAMPLE_RATE, 1, audio.shape[0])
    parts.add(audio[:10_000].reshape(-1, 1))
    parts.add(audio[10_000:].reshape(-1, 1))
    assert whole.finish({"type": "track"})["levels"] == parts.finish({"type": "track"})["levels"]


def test_sidecar_explains_a_bad_request():
    completed = subprocess.run(
        [sys.executable, "-m", "audiosous_analysis"],
        input="{not json",
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "invalid-request"


def pytest_approx(expected: float, abs: float):  # noqa: A002 — mirrors pytest.approx keyword
    import pytest

    return pytest.approx(expected, abs=abs)


def test_dynamic_range_ignores_rests_and_stays_inside_the_contract(tmp_path: Path):
    # A part that plays for 3 s, then rests for 4 s at a -150 dBFS noise floor (as a rendered stem can).
    rng = np.random.default_rng(1)
    playing = _tone(440.0, seconds=3.0) * np.linspace(1.0, 0.25, int(SAMPLE_RATE * 3.0), dtype=np.float32)
    resting = (rng.standard_normal(int(SAMPLE_RATE * 4.0)) * 10 ** (-150 / 20)).astype(np.float32)
    path = tmp_path / "rests.wav"
    _write(path, np.concatenate([playing, resting]))
    dynamics = measure_file(path)["dynamics"]
    assert dynamics["dynamicRangeDb"] is not None
    assert 0.0 <= dynamics["dynamicRangeDb"] <= 120.0
    # The figure describes the playing part (a 12 dB fade), not the gap to the noise floor.
    assert dynamics["dynamicRangeDb"] < 20.0
