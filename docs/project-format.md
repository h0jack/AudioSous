# Project format

Audiosous writes a folder, not a single blob. The human-readable file is `project.amix`. It is JSON, schema version 2.

```text
Night Drive/
├── project.amix
├── media/
├── cache/
└── recovery/
    └── project.amix
```

`media/` holds copies of imported stems. `cache/waveforms/<trackId>.peaks` holds derived waveform peaks, `cache/playback/` holds disposable 48 kHz proxies, and `cache/analysis/` holds measurement JSON, including `<trackId>__eqbands.json`, the band levels EQ planning measures from the playback proxy. None of those caches are part of the schema, and all of them are safe to delete. They are not committed. `recovery/project.amix` keeps the previous successful save. A new project starts with the same bytes in both files. The next save leaves that version in `recovery/` and writes the new document to `project.amix`. Opening `recovery/project.amix` reads that previous copy even when the primary file is still there. The next save writes the primary file and keeps the replaced primary as the new recovery copy.

Source files chosen at import are never modified.

## Versioning

Every document starts with `schemaVersion`. The loader:

1. Rejects non-JSON and missing versions.
2. Rejects a version newer than the application, and asks for an update.
3. Runs each registered migration from the file's version up to the current version.
4. Validates the result against the current schema.

One migration exists: **v1 → v2** gives every track a `processing` graph (`{ "schemaVersion": 1, "nodes": [] }`) and makes processing nodes typed EQ nodes. Version 1 never wrote a processing node, so any v1 node is dropped rather than guessed. A v1 file opens and the next save writes v2.

Fields this application does not understand are dropped by validation. That is deliberate: each version has one schema, and later shapes get a new version plus a migration.

## Document

```json
{
  "schemaVersion": 2,
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

`processing` is the track's own processing graph. It applies to the whole song, before gain and pan. In schema v2 it holds static EQ nodes only, up to 6 per track.

`file.relativePath` is relative to the project folder and must begin with `media/`. Absolute paths and `..` are invalid. `file.filename` is the original basename, kept for display.

`project.sampleRate` is the most common imported rate. Ties prefer the higher rate. `project.durationSeconds` is the longest stem. Mismatched rates and durations are warnings, not load errors.

### Sections

Sections are first-class. Times are seconds. A section must have `endTime > startTime`. Sections are stored in start-time order and may touch (`previous.end === next.start`) but may not overlap. Gaps are allowed.

`source` is `manual`, `automatic`, or `automatic-edited`. `confidence` is 0–1 or null. `structuralGroupId` links repeated sections such as two drops without forcing them to share processing.

`userIntent` is natural language.

### Track × section

`sectionTrackSettings` holds intent for one stem inside one section. `prominence` may be `primary`, `focal`, `supporting`, or null. The section editor writes both when a lane and a section are selected.

`overrides.gainDb` and `overrides.pan` are optional overrides for that section. AutoBalance may set `overrides.gainDb` to a section gain, and playback uses it inside the section. A row is kept only while it carries intent, prominence, an override, or a processing node.

`processing` holds up to 4 extra EQ nodes for that stem inside that section.

### Processing graph and EQ nodes

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "eq-1a2b3c4d",
      "type": "eq",
      "enabled": true,
      "filter": { "kind": "bell", "frequencyHz": 2400, "gainDb": -1.4, "q": 1.0 },
      "origin": "eq-plan",
      "note": "Reduced Pad by 1.4 dB around 2.4 kHz because …"
    }
  ]
}
```

- `kind` is `high-pass`, `low-pass`, `bell`, `low-shelf`, or `high-shelf`. The responses are the RBJ Audio EQ Cookbook ones.
- Stored bounds: `frequencyHz` 20 to 20,000, `gainDb` −18 to +12, `q` 0.1 to 10. Pass filters store `gainDb` 0. The EQ planner stays well inside these bounds; they exist for manual edits.
- One node is one band. Nodes run in array order. A disabled node is skipped and kept.
- `origin` is `manual` or `eq-plan`. A planned node keeps the first reason in `note`, so the saved project says why the filter exists.
- Node ids are unique within one track's graph.

**Inheritance.** Track × Section nodes are **added** after the track's own nodes while playback is inside that section:

```text
source → track nodes → Track × Section nodes (inside the section) → gain → pan → mix
```

A section node never replaces, edits, or bypasses a track node. There is no section-wide graph shared by all stems and no mix-bus graph. Gain overrides keep their own rule: a section gain replaces the track gain inside the section.

The graph is project state. Source files, playback proxies, and analysis caches are never rewritten with EQ. A later export has to apply these nodes to the original source at its own sample rate.

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

Saves are atomic: the shell writes a temporary file in the project folder, fsyncs it, then renames it onto `project.amix`. Before that rename, the current primary bytes are kept. After the new primary is in place, those previous bytes are written to `recovery/project.amix`. A save opened from the recovery file still updates the primary `project.amix`.

Stem copies stream from the source in read-only mode. If bundle creation fails, the new project folder is removed.
