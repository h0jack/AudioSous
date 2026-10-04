"""JSON stdin/stdout entry for one analysis request. Arrays stay in this process."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from audiosous_analysis import CONTRACT_VERSION
from audiosous_analysis.errors import AnalysisError
from audiosous_analysis.measure import measure_file, measure_mix


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
        measurement = _measure(payload)
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


def _measure(payload: dict) -> dict:
    if payload.get("contractVersion") != CONTRACT_VERSION:
        raise AnalysisError("unsupported-contract", "This analysis engine does not understand that request.", "")
    operation = payload.get("operation")
    if operation == "analyze_mix":
        paths = payload.get("audioPaths")
        if not isinstance(paths, list) or not paths or not all(isinstance(path, str) and path for path in paths):
            raise AnalysisError("invalid-request", "The mix measurement did not include stems.", "")
        return measure_mix([Path(path) for path in paths])
    if operation != "analyze_track":
        raise AnalysisError("unsupported-operation", "That analysis is not available yet.", str(operation))
    audio_path = payload.get("audioPath")
    if not isinstance(audio_path, str) or not audio_path:
        raise AnalysisError("invalid-request", "The analysis request did not include a stem.", "")
    scope = payload.get("scope")
    if scope is not None and not isinstance(scope, dict):
        raise AnalysisError("invalid-request", "The analysis request could not be read.", "")
    return measure_file(Path(audio_path), scope if isinstance(scope, dict) else None)


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
