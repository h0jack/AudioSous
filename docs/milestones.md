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

Milestone 3 is gain-only AutoBalance. It proposes track gain and section gain offsets, previews them on the existing clock, and applies the accepted rows as one undo step. It does not EQ, compress, limit, pan, or master. See [AutoBalance](architecture.md#autobalance) for the rules.

| Slice | Status |
| --- | --- |
| 1. Mix plan contract | Done. Versioned plan, confidence, reasons, and stale identity |
| 2. Deterministic balance planner | Done. Roles, anchors, loudness-weighted active level, deadband, caps |
| 3. Section-aware planning | Done. Global changes are preferred unless a section disagrees |
| 4. Candidate preview | Done. Overlay audition, whole-plan A/B, and single-track A/B |
| 5. Evaluation | Done. One correction pass and a separate headroom trim |
| 6. Mix view, undo, and stale plans | Done |
| 7. Intent | Done. Track × Section and section notes are read for level and prominence only, with a fixed precedence. An ambiguous stem reference is not applied |
| 8. Acceptance | Automated and offline checks done. Listening and a GUI walk-through are still open |

### Acceptance run

The planner ran on the cached analysis of two projects with `scripts/plan-project.ts`. Current and AutoBalance were bounced with `scripts/render-audition.py`.

**Sub Operator (Generated 5), 11 real stems, 141 s.** Sections were set from the stem timelines: Intro, Break, Drop, Drop 2, Outro. Roles: PunchBox Kick, Bass Bus Bass, Bleeps Bus Lead, MasterEQ Pad, Skimming Air Atmosphere, Phase Plant 2 Brass with custom label "Trumpets", Stutter Expression and Subway Synth, CZ V FX. SideKick6 and 2nd BD are silent. There are no real trumpets. Phase Plant 2 stands in because it only plays in Drop 2, well under the lead.

The stems at their exported levels are the producer's balance, so that is the already-good case.

| Case | Rows | Largest | Section rows | Confidence | Trim |
| --- | --- | --- | --- | --- | --- |
| Already good, Normal | 2 | −0.9 dB | 0 | 0.92 | 0 |
| Already good, Conservative | 2 | −1.0 dB | 0 | 0.88 | 0 |
| Already good, Strong | 3 | −2.2 dB | 1 | 0.92 | 0 |
| Already good, Normal, MasterEQ as Lead and Bleeps as Synth | 1 | −0.9 dB | 0 | 0.92 | 0 |
| Case A, no intent | 4 | ±4.0 dB | 1 | 0.92 | 0 |
| Case A, Drop 2 note "Big and punchy. Trumpets should dominate." | 5 | ±4.0 dB | 2 | 0.91 | 0 |
| Case A, Trumpets Focal in Drop 2 | 5 | ±4.0 dB | 2 | 0.92 | 0 |

Case A added deliberate errors to the good mix: Lead −4 dB, Atmosphere +5 dB, Pad +3 dB, Bass +2 dB. The plan put the lead back to 0.0, the bass from +2.0 to −0.9, and the pad from +3.0 to +1.6. The atmosphere error was only caught in the Intro (+5.0 to +3.3). Elsewhere it stays under the Background ceiling, so it was left alone. The Drop 2 note and explicit Focal prominence gave the same +4.0 dB Drop 2 row on the stand-in, capped and marked for review because the gap to the bass is 20.6 dB. The note row reads confidence 0.85 and the prominence row 0.90. "Big and punchy." on its own changed nothing.

The bounces are not loudness-matched. Case A current peaks at +1.8 dBFS with 287 samples over full scale, and the candidate at +0.5 dBFS with 7. The already-good candidate peaks at −0.5 dBFS against +0.05 dBFS current. No trim was needed in either.

**Night Drive, 6 synthetic stems, 80 s.** The generator makes a 50 ms, 55 Hz kick blip every half second under a constant 55 Hz bass and a full-scale lead, so it is badly unbalanced on purpose. The plan cut the lead and the bass 4 dB each toward the kick and marked both for review, because the uncapped moves were 20 dB and 14 dB. It cut the pad 0.4 dB. With "Bring the lead forward. Make the pad quieter." on Drop 2, Drop 2 keeps the lead 2.3 dB over the rest of the lead, and the plan adds a −0.6 dB trim. The pad was already far enough under the reference, so the "quieter" note had nothing left to do. The raw stems sum to +8.6 dBFS before AutoBalance, and that does not change.

The first run of the already-good case proposed 5 to 6 rows of up to 4 dB. Five planner faults caused that, and all five are fixed and covered by tests:
- unweighted RMS across different spectra;
- a fading-in lead used as a section reference;
- a primary's quiet passages judged as errors;
- primaries compared with each other instead of the anchor;
- a follow-up pass that checked against a different reference than the first pass.

**Timing.** For 11 stems and 5 sections, reading the analysis cache took 35 to 75 ms and planning took 10 to 47 ms. The desktop log records `analysisMs` and `durationMs` separately.

**UX flow.** `apps/desktop/src/lib/autobalance-flow.test.ts` drives the store with the real apply, cancel, and audition functions:
- edit, reject, and accept rows;
- Current vs AutoBalance;
- single-row original vs recommended;
- Apply accepted (only accepted rows land);
- one undo step back to the full pre-plan mix;
- a fader move making the plan stale and refusing to apply;
- row focus not making the plan stale;
- cancel leaving the saved project untouched.

The native preview path was checked by reading it. Section windows are published to a lock-free schedule and set the target of the existing 10 ms gain slew. Proxies are not rebuilt and the device is not restarted.

**Review fixes after the first hands-on run.** Generated 5 as saved reported no changes. Its three sections cover only the first 24 s, and the planner used to skip time outside sections, so the drops were never checked. Unmarked time is now planned, and the panel states the scope. The timeline also gained:
- icon Play/Pause, Stop, and Loop buttons;
- Clear selection, also on Esc;
- Section at playhead, which splits the section under the playhead, or else adds one from the end of the previous section (or the song start) to the playhead.

The Generated 5 stems are still mostly marked Bass. The import role guess reads "Sub" in "Sub Operator" as bass.

**Still open before Milestone 3 is complete:**
- a listening pass on the Current and AutoBalance bounces;
- a manual walk-through of the review panel in the desktop app: row click selection and seek, the A/B buttons, Apply accepted, Ctrl+Z, and stale and cancel.

## Explicitly later

Automatic EQ, compression, saturation, reverb, delay, mastering, VST hosting, reference matching, LLM mixing, preference learning, accounts, collaboration, and source separation.
