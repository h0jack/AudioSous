# Project format

Audiosous writes a folder, not a single blob. The human-readable file is `project.amix`. It is JSON, schema version 1.

```text
Night Drive/
├── project.amix
├── media/
├── cache/
└── recovery/
    └── project.amix
```

`media/` holds copies of imported stems. `cache/waveforms/<trackId>.peaks` holds derived waveform peaks (not part of the schema, and safe to delete). `recovery/project.amix` is the last successful save, written beside the primary file so a crash during a later save still leaves a readable copy.

Source files chosen at import are never modified.

## Versioning

Every document starts with `schemaVersion`. The loader:

1. Rejects non-JSON and missing versions.
2. Rejects a version newer than the application, and asks for an update.
3. Runs each registered migration from the file's version up to the current version.
4. Validates the result against the current schema.

No migration steps exist yet. The runner is still part of the load path, and tests cover a multi-step chain.

Fields this application does not understand are dropped by validation. That is deliberate: a v1 file has one schema, and later shapes get a new version plus a migration.

## Document

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "project-id",
    "name": "Night Drive",
    "createdAt": "2026-10-03T12:00:00.000Z",
    "updatedAt": "2026-10-03T12:00:00.000Z",
    "sampleRate": 48000,
    "durationSeconds": 241.72
  },
  "tracks": [],
  "sections": [],
  "sectionTrackSettings": [],
  "mixVariants": [],
  "activeMixVariantId": "working",
  "comparison": {
    "scope": "entire-mix",
    "aVariantId": "original",
    "bVariantId": "working",
    "trackId": null
  },
  "uiState": {}
}
```

`sectionTrackSettings` is an array of `{ trackId, sectionId, ... }` records rather than a nested map. The pair is unique. An array survives field additions without encoding ids into dictionary keys.

### Tracks

A track has a display `name`, a `role`, an optional `customLabel`, file metadata, and monitoring state.

Roles: Kick, Snare / Clap, Hi-Hat, Percussion, Drums, Bass, Lead, Synth, Pad, Keys, Guitar, Vocal, Backing Vocal, Brass, Strings, FX, Atmosphere, Other.

`customLabel` is for a role that the list does not name. Filename guessing fills `role` only.

Monitoring state is the user's current audition mix, not an AI processor:

- `gainDb`: −96 to +12. The bottom of the future fader is effectively silent. JSON cannot store −∞, and mute is a separate boolean.
- `pan`: −1 (full left) to +1 (full right). The UI shows −100 to +100.
- `muted` and `solo`: stored independently. Solo precedence is implemented with the mixer, not in this slice.

`file.relativePath` is relative to the project folder and must begin with `media/`. Absolute paths and `..` are invalid. `file.filename` is the original basename, kept for display.

`project.sampleRate` is the most common imported rate. Ties prefer the higher rate. `project.durationSeconds` is the longest stem. Mismatched rates and durations are warnings, not load errors.

### Sections

Sections are first-class. Times are seconds. A section must have `endTime > startTime`. Sections are stored in start-time order and may touch (`previous.end === next.start`) but may not overlap. Gaps are allowed.

`source` is `manual`, `automatic`, or `automatic-edited`. `confidence` is 0–1 or null. `structuralGroupId` links repeated sections such as two drops without forcing them to share processing.

`userIntent` is natural language.

### Track × section

`sectionTrackSettings` holds intent for one stem inside one section. `prominence` may be `primary`, `focal`, `supporting`, or null. The section editor writes both when a lane and a section are selected.

`overrides.gainDb` and `overrides.pan` are optional monitoring overrides for that section. `processing` is `{ "schemaVersion": 1, "nodes": [] }` until DSP exists.

### Mix variants and comparison

New projects contain two variants: `Original` and `Working Mix`. `activeMixVariantId` is the variant the transport will play. `comparison.scope` is one of:

- `entire-mix`
- `soloed-track`
- `track-in-mix`

The third scope is the full mix with one stem swapped. `trackId` is required for the two track scopes and null for the entire mix. No alternate audio is rendered in this slice.

### UI state

`uiState` stores the selection context later commands will read:

- `selectedTrackId`
- `selectedSectionId`
- `timeRange`
- `loop`
- `playheadSeconds`
- `timelineZoom`
- `timelineScroll`

Selections are independent. A project may have a track and a section and a time range at the same time.

## Writes

Saves are atomic: the shell writes a temporary file in the project folder, fsyncs it, then renames it onto `project.amix`. The same bytes are copied to `recovery/project.amix` after the primary write succeeds.

Stem copies stream from the source in read-only mode. If bundle creation fails, the new project folder is removed.
