"""Versioned JSON boundary for Audiosous analysis.

The React UI does not import this module. A Tauri command spawns it and exchanges JSON.
Section suggestions in the app still use cached peak energy and do not start this process.
"""

CONTRACT_VERSION = 1
ANALYSIS_SCHEMA_VERSION = 3
ANALYSIS_ENGINE_VERSION = "0.4.0"
