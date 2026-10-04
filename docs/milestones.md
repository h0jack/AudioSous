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
| 3. Section, time-range, and mix scopes | Done. A section or range measures that window. Mix sums the stem files and ignores faders, mute, and pan |
| 4. Comparison, overlap, and the activity map | Done. Comparison and overlap use two measurements. The activity map is each stem's loudness timeline |

## Explicitly later

Automatic EQ, compression, saturation, reverb, delay, mastering, VST hosting, generated mixes, LLM agents, accounts, collaboration, and source separation.
