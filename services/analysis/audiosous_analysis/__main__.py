"""JSON stdin/stdout entry for one analysis request. Arrays stay in this process."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from audiosous_analysis import CONTRACT_VERSION
from audiosous_analysis.errors import AnalysisError
from audiosous_analysis.measure import measure_file


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError:
        _emit_error("invalid-request", "The analysis request could not be read.", "")
        return 1
    if not isinstance(payload, dict):
        _emit_error("invalid-request", "The analysis request could not be read.", "")
        return 1
    try:
        path = _audio_path(payload)
        measurement = measure_file(path)
    except AnalysisError as error:
        _emit_error(error.code, error.message, error.detail)
        return 0
    except Exception as error:  # noqa: BLE001 — the sidecar must answer with JSON, not a traceback
        _emit_error("analysis-failed", "Unable to analyze this stem.", type(error).__name__)
        return 0
    json.dump(
        {"contractVersion": CONTRACT_VERSION, "ok": True, "measurement": measurement},
        sys.stdout,
        allow_nan=False,
    )
    sys.stdout.write("\n")
    return 0


def _audio_path(payload: dict) -> Path:
    if payload.get("contractVersion") != CONTRACT_VERSION:
        raise AnalysisError("unsupported-contract", "This analysis engine does not understand that request.", "")
    if payload.get("operation") != "analyze_track":
        raise AnalysisError("unsupported-operation", "That analysis is not available yet.", str(payload.get("operation")))
    audio_path = payload.get("audioPath")
    if not isinstance(audio_path, str) or not audio_path:
        raise AnalysisError("invalid-request", "The analysis request did not include a stem.", "")
    return Path(audio_path)


def _emit_error(code: str, message: str, detail: str) -> None:
    json.dump(
        {
            "contractVersion": CONTRACT_VERSION,
            "ok": False,
            "error": {"code": code, "message": message, "detail": detail},
        },
        sys.stdout,
        allow_nan=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
