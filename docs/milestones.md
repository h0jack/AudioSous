# Milestones

The product target is an AI-assisted visual mixer. Processing is out of scope until the project, the clock, and the selection context exist.

## Milestone 1 slices

| Slice | Status |
| --- | --- |
| 1. Repository and application shell | Done |
| 2. Project schema | Done |
| 3. Stem import | Done |
| 4. Waveform cache | Done. Peaks are measured per stem and stored in `cache/waveforms/` |
| 5. Timeline | Shared scale, zoom, scroll, vertical scale, playhead, section boundaries, and selected range |
| 6. Audio engine implementation | Done. One clock schedules short PCM windows |
| 7. Synchronized transport | Play, pause, stop, and seek share that clock |
| 8. Mixer controls | Mute, solo, gain, and pan are on each lane |
| 9. Selection model editing | A lane click selects the track. A drag selects a time range. A section mark selects that section |
| 10. Manual sections | A selected range becomes a named section. Name, type, bounds, and deletion are saved with the project |
| 11. Section and track intent editing | A section and the selected stem inside it store natural-language intent. Prominence is primary, focal, or supporting |
| 12. Looping | A selected range or a selected section loops on the shared clock. Moving that section moves the loop |
| 13. Undo / redo | Ctrl+Z and Ctrl+Shift+Z. A slider drag or a typed phrase is one step |
| 14. Save / reopen | Explicit save and the recovery copy remain. An edit saves after it settles, not while a control is still moving |
| 15. Experimental section detection | Suggest sections reads cached peaks and adds dashed automatic sections. Editing one makes it solid. Python is not spawned |
| 16. Performance pass | 32 stems share one short read window. Peaks stay in the cache |
| 17. Broader automated tests | History, intent, suggestions, peak energy, and the 32-stem clock are covered |

Import is not real until a project can be opened again, so this slice includes create, explicit save, the recovery copy, and reopen. It does not autosave while a control is being dragged.

## Milestone 2

Milestone 2 measures and draws analysis. It does not change the mix.

| Slice | Status |
| --- | --- |
| 1. Track measurement sidecar | Done. Peak, RMS, LUFS, crest factor, and band energy for the selected stem, cached in `cache/analysis/` |
| 2. Spectrum, loudness timeline, and spectrogram | Done. Drawn from the same measurement as the levels |
| 3. Section, time-range, and source-mix scopes | Done. A section or range measures that window. Source mix is the raw sum of the stem files, before faders, mute, and pan. It is not the audible mix |
| 4. Comparison, overlap, and the activity map | Done. Stem comparison, section comparison, and band overlap use measurements. The activity map is each stem's loudness timeline. Charts follow the shared playhead and can seek |

## Milestone 2.5

Milestone 2.5 moves the playback clock into Rust. The desktop app plays 48 kHz float proxies through `cpal`. The browser preview keeps the Web Audio engine. `AUDIOSOUS_AUDIO_ENGINE=legacy` selects that engine in the desktop app too.

| Slice | Status |
| --- | --- |
| 1. Playback proxy | Done. `cache/playback/<trackId>.proxy`, rebuilt when the source identity or resampler id changes |
| 2. Native transport | Done. One clock, four reader threads, gain, pan, mute, solo, seek, and loop |
| 3. Device output | Done. 48 kHz float when the device allows it. Otherwise a mixer thread converts before the callback |
| 4. Diagnostics | Done. The Audio engine panel reports fill, underruns, seek prime, callback time, and a budget warning |
| 5. Real-time callback | Done. The device callback does not lock, allocate, or read disk |

`npm run stress:audio` is the release check. It mixes synthetic 32- and 64-stem loads and plays five minutes of Generated 5 and Generated2 offline. Those soaks had 0 underruns. A release build also played Generated 5 through the laptop speaker for the whole 141.4 seconds, including seeks, a loop, mute, solo, gain, Balance, and the timeline and Analysis views. That run had 0 underruns. Blocking the React thread for one second did not stop the audio. CI does not open a device.

Milestone 2.5 is complete.

## Milestone 3

Milestone 3 is gain-only AutoBalance. It proposes track gain and section gain offsets, previews them on the existing clock, and applies the accepted rows as one undo step. It does not EQ, compress, limit, or master.

| Slice | Status |
| --- | --- |
| 1. Mix plan contract | Done. Versioned plan, confidence, reasons, and stale identity |
| 2. Deterministic balance planner | Done. Roles, anchors, active level, deadband, caps |
| 3. Section-aware planning | Done. Global changes are preferred unless a section disagrees |
| 4. Candidate preview | Done. Overlay audition, whole-plan A/B, and single-track A/B |
| 5. Evaluation | Done. One correction pass and a separate headroom trim |
| 6. Mix view, undo, and stale plans | Done |

## Explicitly later

Automatic EQ, compression, saturation, reverb, delay, mastering, VST hosting, reference matching, LLM mixing, preference learning, accounts, collaboration, and source separation.
