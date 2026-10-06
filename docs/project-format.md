# Project format

Audiosous writes a folder, not a single blob. The human-readable file is `project.amix`. It is JSON, schema version 4.

```text
Night Drive/
├── project.amix
├── media/
├── cache/
└── recovery/
    └── project.amix
```

`media/` holds copies of imported stems. `cache/waveforms/<trackId>.peaks` holds derived waveform peaks, `cache/playback/` holds disposable 48 kHz proxies, and `cache/analysis/` holds measurement JSON, including `<trackId>__eqbands.json`, the band levels EQ planning measures from the playback proxy, `<trackId>__stereo.json`, the stereo statistics spatial planning measures from it, and `<trackId>__envelope.json`, the 10 ms level envelopes dynamics planning measures from it. None of those caches are part of the schema, and all of them are safe to delete. They are not committed. `recovery/project.amix` keeps the previous successful save. A new project starts with the same bytes in both files. The next save leaves that version in `recovery/` and writes the new document to `project.amix`. Opening `recovery/project.amix` reads that previous copy even when the primary file is still there. The next save writes the primary file and keeps the replaced primary as the new recovery copy.

Source files chosen at import are never modified.

## Versioning

Every document starts with `schemaVersion`. The loader:

1. Rejects non-JSON and missing versions.
2. Rejects a version newer than the application, and asks for an update.
3. Runs each registered migration from the file's version up to the current version.
4. Validates the result against the current schema.

Three migrations exist:

- **v1 → v2** gives every track a `processing` graph (`{ "schemaVersion": 1, "nodes": [] }`) and makes processing nodes typed EQ nodes. Version 1 never wrote a processing node, so any v1 node is dropped rather than guessed.
- **v2 → v3** gives every track `width: 1` (as recorded) and every Track × Section row `overrides.width: null`. Pan and the section pan override keep their meaning, so a v2 file sounds the same after the migration.
- **v3 → v4** turns every processing graph (track and Track × Section) into graph v2: its EQ `nodes` stay as they are and it gains an empty `dynamics` list. A v3 file sounds the same after the migration.

An older file opens and the next save writes v4.

Fields this application does not understand are dropped by validation. That is deliberate: each version has one schema, and later shapes get a new version plus a migration.

## Document

```json
{
  "schemaVersion": 4,
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
- `pan`: −1 (full left) to +1 (full right). The UI shows −100 to +100. On a mono stem it is an equal-power pan; on a stereo stem it is a balance control (each channel scaled, no crossfeed).
- `width`: 0 to 2, 1 = as recorded. Scales the side signal `(L − R) / 2` of a stereo stem and leaves the mid alone, so the mono fold-down never changes with width. 0 is mono. Ignored on a mono stem; Audiosous never synthesizes stereo.
- `muted` and `solo`: stored independently. Solo precedence is implemented with the mixer, not in this slice.

`processing` is the track's own processing graph. It applies to the whole song, before width, pan, and gain. It holds up to 6 static EQ nodes and, since v4, dynamics nodes (see [Dynamics nodes](#dynamics-nodes)).

`file.relativePath` is relative to the project folder and must begin with `media/`. Absolute paths and `..` are invalid. `file.filename` is the original basename, kept for display.

`project.sampleRate` is the most common imported rate. Ties prefer the higher rate. `project.durationSeconds` is the longest stem. Mismatched rates and durations are warnings, not load errors.

### Sections

Sections are first-class. Times are seconds. A section must have `endTime > startTime`. Sections are stored in start-time order and may touch (`previous.end === next.start`) but may not overlap. Gaps are allowed.

`source` is `manual`, `automatic`, or `automatic-edited`. `confidence` is 0–1 or null. `structuralGroupId` links repeated sections such as two drops without forcing them to share processing.

`userIntent` is natural language.

### Track × section

`sectionTrackSettings` holds intent for one stem inside one section. `prominence` may be `primary`, `focal`, `supporting`, or null. The section editor writes both when a lane and a section are selected.

`overrides.gainDb`, `overrides.pan`, and `overrides.width` are optional overrides for that section. Each replaces the track's value inside the section, the way a section gain replaces the fader. AutoBalance may set `overrides.gainDb`; the spatial plan may set `overrides.pan` and `overrides.width`. Playback uses all three inside the section, and pan and width changes at the section edges ramp over 30 ms. An override equal to the track's own value is not stored. A row is kept only while it carries intent, prominence, an override, or a processing node.

`processing` holds up to 4 extra EQ nodes and extra dynamics nodes for that stem inside that section.

### Processing graph and EQ nodes

```json
{
  "schemaVersion": 2,
  "dynamics": [],
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
- Node ids are unique within one graph, across its EQ nodes and its dynamics nodes.

**Inheritance.** Track × Section nodes are **added** after the track's own nodes while playback is inside that section:

```text
source → track nodes → Track × Section nodes (inside the section) → width → pan / balance → gain → mix
```

A section node never replaces, edits, or bypasses a track node. There is no section-wide graph shared by all stems and no mix-bus graph. Gain overrides keep their own rule: a section gain replaces the track gain inside the section.

The graph is project state. Source files, playback proxies, and analysis caches are never rewritten with EQ. A later export has to apply these nodes to the original source at its own sample rate.

### Dynamics nodes

Graph v2 has a second list, `dynamics`, of typed dynamics processors:

```json
{ "id": "dyn-3f2a91c0", "type": "compressor", "enabled": true, "origin": "dynamics-plan", "note": "Compresses Bass because …",
  "thresholdDb": -21, "ratio": 2, "attackMs": 30, "releaseMs": 200, "kneeDb": 6, "makeupDb": 0 }
{ "id": "dyn-…", "type": "ducking", "enabled": true, "origin": "dynamics-plan", "note": "…",
  "keyTrackId": "kick-id", "keyDetector": "transient", "thresholdDb": -16, "rangeDb": -2.5, "attackMs": 5, "releaseMs": 110 }
{ "id": "dyn-…", "type": "transient", "enabled": true, "origin": "manual", "note": null, "attack": -0.1, "sustain": 0 }
{ "id": "dyn-…", "type": "dynamic-eq", "enabled": true, "origin": "dynamics-plan", "note": "…",
  "filter": { "kind": "bell", "frequencyHz": 2600, "q": 0.8 }, "keyTrackId": "lead-id", "keyDetector": "smooth",
  "thresholdDb": -28, "rangeDb": -1.5, "attackMs": 20, "releaseMs": 250 }
```

| Type | Fields | Stored bounds |
| --- | --- | --- |
| `compressor` | threshold, ratio, attack, release, knee, makeup | −60…0 dB, 1…20:1, 0.1…250 ms, 5…2000 ms, 0…24 dB, 0…12 dB |
| `ducking` | key track, key detector, threshold, range, attack, release | range −12…0 dB (a reduction) |
| `transient` | attack, sustain | ±0.3, ±0.2 (fractions: 0.1 is +10%) |
| `dynamic-eq` | bell frequency and Q, key track (or null: its own signal), key detector, threshold, range, attack, release | 20 Hz…20 kHz, Q 0.3…6, range −12…0 dB |

`keyDetector` is `transient` (a fast peak follower, for drums) or `smooth` (a 50 ms RMS, for voices and leads). `origin` is `manual` or `dynamics-plan`; a planned node keeps its first reason in `note`.

**Limits** per graph, which the native engine reserves exactly: a track graph holds up to 3 dynamic EQ, 1 compressor, 1 transient, and 2 ducking nodes; a Track × Section graph up to 2, 1, 1, and 1 more.

**Order is fixed by stage, not by list position**:

```text
source → static EQ (track, then section) → dynamic EQ → compressor → transient → ducking → width → pan / balance → gain → mix
```

Inside a stage, the track's own nodes run first, then the nodes of the section under the playhead. A section node is added; it never replaces or bypasses a track node. A disabled node is skipped and kept.

**Sidechain routing** is track → track. The key is the key track's own source (mono, before its EQ, dynamics, fader, mute, and solo). A node may not key its own track, and keys may not form a loop (A keys B, B keys A, directly or through others); the loader and the editor refuse both. A key naming a track that is not in the project is kept but inert: the engine skips that node.

Dynamics never rewrite source files or proxies. A later export has to run the same nodes on the original source; every parameter is in milliseconds, dB, and Hz, so nothing depends on the 48 kHz playback rate.

### Spatial state

Pan and width are not processing nodes. They are track state like the fader, with one source of truth each:

| Where | Field | Applies |
| --- | --- | --- |
| Track | `pan`, `width` | the whole song |
| Track × Section | `overrides.pan`, `overrides.width` | inside that section, replacing the track value |

The spatial plan writes these fields directly: a whole-song row sets `track.pan` and/or `track.width`, a section row sets the overrides. It never writes a node and never duplicates a value. Width and pan are rate-independent, so a later export applies them to the original source unchanged.

### What Full Mix writes

Milestone 7 adds no field and no schema version. A Full Mix plan is ephemeral, like the four plans it coordinates, and Apply writes only the representations above, in one update: `track.gainDb` and `overrides.gainDb` for gain changes and the safety trim; EQ nodes with `origin: "eq-plan"`; `pan`, `width`, and their overrides; dynamics nodes with `origin: "dynamics-plan"`. Each planned node keeps the first reason in `note`, and its id starts `fm-`. A node a change edits is replaced in place, never stacked. A file written after Full Mix opens in a Milestone 6 build.

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
