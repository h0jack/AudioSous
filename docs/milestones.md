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

## Milestone 4

Milestone 4 is static EQ planning: frequency interaction between stems, then conservative, explainable EQ moves that improve separation and hierarchy. It previews on the existing clock and applies as one undo step. It does not compress, use dynamic EQ or sidechain, pan, widen, add effects, limit, master, or host plugins. See [Frequency interaction and EQ](architecture.md#frequency-interaction-and-eq).

| Slice | Status |
| --- | --- |
| 1. EQ contract | Done. Schema v2 with a v1 migration: typed EQ nodes on every track and Track × Section, additive inheritance, node limits, stale identity, versioned `frequency-balance` plan |
| 2. Native DSP | Done. RBJ responses in SVF form, 6 track + 4 section slots per stem, 30 ms ramps, lock-free publish, no allocation in the callback (tested) |
| 3. Interaction analysis | Done. Time-aware pairwise competition per scope, role-weighted regions, stereo discount, priority, confidence. Proxy band frames (Rust, 5.9 Hz bins) because the sidecar spectrogram is too coarse below a few hundred Hz |
| 4. EQ planner | Done. Who yields, center, gain, Q, global vs section, kick/bass, lead/supporting, measured high-pass, rare low-pass, tone words, saved-boost reduction, level-problem notes, regularization, confidence |
| 5. Candidate preview | Done. Overlay through one monitor path with AutoBalance, Current vs EQ Candidate, single-filter Bypassed / With filter, curve editor, accept, reject |
| 6. Evaluation | Done. Spectral transfer per move (pairwise and in context), a second correction pass, a whole-plan check, and a proxy check with the native filters |
| 7. Hardening | Partly. Undo, stale plans, performance, real-music runs, and docs are done. CI has not run on these changes, and the listening pass and GUI walk-through are open |

### Tests

- `packages/eq-planner` (46). Spec fixtures A–F: Lead Focal vs Pad, Kick Primary vs Bass Supporting, Kick vs Bass both Primary (with and without transient evidence), never simultaneous, already separated, sparse Focal in Drop 2 from prominence and from a section note. Also global preferred over section, measured high-pass (and none without low end), fader state and saved EQ heard, a saved node replaced rather than stacked, layering, stereo discount, tone words confirmed and refused, an already-good mix, determinism, strength limits, filter caps, staleness, a 32-stem timing check, proxy bands over a smeared spectrogram, the plan contract (edit, reset, misplaced filter, clamps, audition, apply, Apply all vs Apply accepted, safety trim, HPF evaluation, proxy-check merge), and the response math.
- `packages/project-model` (29). v1 → v2 migration, the inheritance order, rows kept for filters only, node limits and ids, clamping, and processing identity.
- `apps/desktop` (32, 9 new). The EQ review flow drives the store with the real functions: the acceptance plan shape, whole-plan and single-filter A/B through the monitor, EQ audition stopping a gain audition, edit + reject + accept + Apply accepted + one undo step, stale refusal after a fader or prominence change, cancel, saved section gain reaching the engine, and saved EQ reaching the engine.
- `crates/audio-engine` (Rust, 15 new). Bell, HPF, LPF, low shelf, and high shelf against the cookbook formula, multiple filters, bypass bit-exactness, every legal parameter combination finite and bounded, ramped parameter update, section fade in and out, retargeting between sections, a seek into a section, table round trip, track and section EQ through the real offline engine, the allocation counter, the proxy check, and band frames (Parseval and no low-end smear).
- `npm run stress:audio` adds `stress_eq_callback_cost`.

### Acceptance run

Planned from the cached analysis plus proxy band frames with `plan-eq-project.ts`. Bounced from the proxies with `render-eq-audition.py`. Generated 5 used the same sections and roles as the Milestone 3 run: Intro 0–17.7 s, Break –33.6 s, Drop –86.6 s, Drop 2 –123.7 s, Outro –141.4 s. Roles: PunchBox Kick, Bass Bus Bass, Bleeps Bus Lead, MasterEQ Pad, Skimming Air Atmosphere, Phase Plant 2 Brass "Trumpets", Stutter Expression and Subway Synth, CZ V FX. All faders at 0 dB.

**Already-good mix (the producer's stems).**

| Case | Filters | Largest | Section | Notes |
| --- | --- | --- | --- | --- |
| Conservative | 1 | Subway −1.3 dB at 2.2 kHz | 0 | Kick/Bass both Primary: overlap 36–63 Hz, no change. Bleeps 10 dB under MasterEQ in its range: level, not EQ |
| Normal | 2 | MasterEQ −2.3 dB at 1.6 kHz, Subway −1.7 dB at 2.2 kHz | 0 | Kick/Bass no change |
| Strong | 3 | adds Stutter Expression −3.3 dB at 1.6 kHz (second pass) | 0 | |
| Normal, Drop 2 note "Trumpets should be more prominent." | 2 | same as Normal | 0 | The stand-in sits 20 dB under the mix in Drop 2: level, not EQ |
| Normal, Bass Bus Supporting in every section | 3 | Bass Bus −2.9 dB at 46 Hz, Q 2, at PunchBox's strongest low band | 0 | |

None of the 11 stems got more than one filter. The first calibration run on this mix proposed 9 cuts with 5 section filters, 5 of them on Skimming Air. Five faults caused that, and all five are fixed and covered:
- Supporting parts were protected.
- Moves were judged against one competitor instead of everything playing.
- Gaps no conservative cut can close were attempted.
- Section filters were allowed without a stated reason.
- The severity scale saturated.

A sixth fault was in the data: the sidecar spectrogram has 187 Hz bins at 192 kHz, so the low end was unresolved and kick/bass read "150–200 Hz". The proxy band frames fixed that.

**Deliberately problematic mix.** The good mix with bad EQ and gain saved on it:
- MasterEQ +3 dB, a +6 dB bell at 2.5 kHz, and a +5 dB low shelf at 120 Hz.
- Stutter Expression with a +6 dB bell at 1.8 kHz.
- Skimming Air +5 dB with a +8 dB low shelf at 150 Hz.
- Bass Bus +2 dB with a +5 dB bell at 60 Hz.
- Phase Plant 2 Focal in Drop 2.

- Top conflicts: MasterEQ over Bleeps Bus at 1.1–3.6 kHz (+11 dB), Stutter Expression over Bleeps Bus at 1.1–2.7 kHz (+7 dB), PunchBox and Bass Bus at 36–63 Hz (both Primary), and Phase Plant 2 under MasterEQ in Drop 2 (24 dB, level).
- Proposed: reduce MasterEQ's saved +6 dB bell to −1.0 dB, and on the second pass reduce Stutter Expression's +6 dB bell to +1.1 dB. Both Global, confidence 0.93 and 0.92.
- Not proposed: the two low shelves. The producer had already high-passed MasterEQ and Skimming Air, so the shelves boost almost nothing and sit about 20 dB under the bass. Kick/Bass had no stated priority. Phase Plant 2 is a level problem.
- Review in the harness: accept both, then edit MasterEQ to −0.9 dB. A Bass Bus reject was scripted but there was no Bass Bus row to reject.
- Bounce peaks: current +1.2 dBFS (clipping), candidate −1.5 dBFS, reviewed −1.2 dBFS.

**Prediction vs audio.** The independent Python filters on the proxies measured each filter's change inside its conflict range over the overlap windows:

| Filter | Predicted | Measured |
| --- | --- | --- |
| Stutter Expression bell 1.8 kHz, 1.1–2.7 kHz | −3.25 dB | −3.62 dB |
| MasterEQ bell 2.5 kHz, 1.1–3.6 kHz | −3.41 dB | −2.84 dB |
| MasterEQ −2.3 dB at 1.6 kHz | −1.11 dB | −1.33 dB |
| Bass Bus −2.9 dB at 46 Hz, 36–63 Hz | −2.10 dB | −1.70 dB |
| Subway −1.7 dB at 2.2 kHz | −1.24 dB | −1.27 dB |

**Night Drive (synthetic, 6 stems, 80 s).** A 55 Hz kick blip sits under a constant 55 Hz bass, both Primary. The plan is one review-only Bass cut at 53 Hz, −1.1 dB, confidence 0.48, and nothing automatic.

**Timing.** For 11 stems and 5 sections: band frames 0.86 s for all stems from existing proxies (cached afterwards), cache load 15–55 ms, and planning 50–90 ms including both passes and the whole-plan check.

**Audio engine.** Release build, same machine, same tests, before and after EQ:
- Synthetic, 256-frame callbacks: 32×48 kHz 0.047 → 0.048 ms, 32×96 kHz 0.037 → 0.041, 11×192 kHz 0.015 → 0.021, 64×48 kHz 0.062 → 0.086 (budget 5.33 ms).
- Soaks: Generated 5 0.146 → 0.143 ms, Generated2 0.125 → 0.162 ms, both with seeks, a loop, mute, and solo.
- EQ loads, 512-frame callbacks: 32 stems with HPF + 2 bells + a section bell, 0.30–0.40 ms of 10.67 ms. 64 stems, 0.69–0.81 ms.
- Every run had 0 underruns.

**Fixed along the way.**
- Milestone 3 Track × Section gain written by Apply was saved but never sent to either engine outside a preview. Both engines now play it.
- AutoBalance's apply dropped Track × Section rows that held only filters.

**Still open before Milestone 4 is complete:**
- a listening pass on the Current, EQ Candidate, and reviewed bounces of both mixes;
- a GUI walk-through: the EQ tab, the curve editor (drag, wheel, keys), Bypassed / With filter, Current / EQ Candidate, Apply accepted, Ctrl+Z, a stale plan after a fader move, the Frequency interaction view, and the lane EQ badge;
- GitHub Actions on these changes.

## Milestone 5

Milestone 5 is stereo and spatial interaction planning: where stems sit in the stereo field, which ones collide there in the frequencies they compete for, and conservative, explainable pan, balance, and width moves. It previews on the existing clock and applies as one undo step. It does not compress, use dynamic EQ or sidechain, add reverb, delay, chorus, Haas, or any other way of making stereo, process width per frequency band, limit, master, or host plugins. See [Stereo and spatial planning](architecture.md#stereo-and-spatial-planning).

| Slice | Status |
| --- | --- |
| 1. Spatial contract | Done. Schema v3 with a v2 migration: `track.width` and `overrides.width` beside the existing pan fields (one source of truth each), section overrides that replace the track value, spatial stale identity, versioned `spatial-balance` plan |
| 2. Native DSP | Done. Width on mid/side (100% bit-exact, mono fold-down unchanged at every width), equal-power pan / balance, 30 ms ramps for every change and section edge, snap on seek, lock-free table with 128 section windows, per-block fast path, no allocation in the callback (tested) |
| 3. Spatial interaction analysis | Done. Proxy stereo frames (Rust: L, R, and correlation per frame and 8 bands), exact second-order statistics for any pan/width, position, spread, correlation, M/S, mono loss, field occupancy, center competition, localizable overlap weighted by M4's frequency competition, time-aware pairs and tiers from M4 |
| 4. Spatial planner | Done. Who moves (anchors, tiers, peers within 6 dB), level-not-space, bounded search with quadratic costs, global only when the conflict covers half the stem's time, section rows with a reason, mono safety, surround, intent, confidence, review rules |
| 5. Candidate preview | Done. One monitor path with AutoBalance and EQ: Current vs Spatial Candidate, single-row Bypassed / Recommended, edits heard on the next publish, stereo field editor (drag, Shift-drag, wheel, keys, sliders), accept, reject |
| 6. Evaluation | Done. Every candidate scored on the stored statistics (conflict addressed and added elsewhere, correlation, mono loss, mix lean and center load, level change), a correction pass, a whole-plan pass, a proxy check through the native spatial stage, per-channel headroom |
| 7. Hardening | Partly. Undo, stale plans, cancellation, stress, real-music runs, and docs are done. The physical listening pass, the GUI walk-through, and GitHub Actions on these changes are open |

### Tests

- `packages/spatial-planner` (58). Fixtures A–H from the milestone (centered lead and pad, already separated, kick and bass, narrowed background atmosphere, phase-risky pad, two wide synths in both a coherent and a decorrelated version, never simultaneous, "Make the breakdown wider."), mono compatibility (no widening under 0.2 correlation, an edit to 200% caught and sent to review), saved pan and width as the starting point, a saved section override edited rather than stacked and kept against a disagreeing note, saved EQ removing the need for a move, a level problem reported instead of a pan, intent (a side, centered, ambiguous, tone words, negation, a mono stem asked to widen, Track × Section above section), an already-good arrangement, a lopsided arrangement left alone, determinism, strength and range limits, staleness, a 32-stem timing check, the stereo math against closed-form results, occupancy, the plan contract (round trip, edit and reset, inclusion rule, audition, single-row A/B, saved section overrides as regions, Apply all, Apply accepted, section rows as overrides, headroom trim, proxy-check merge), and the phrase table.
- `packages/project-model` (38, 9 new). v2 → v3 migration that keeps how a file sounds, width bounds, section overrides replacing the track value, no duplicate override, clearing one keeps intent, rounding, mono detection, spatial identity.
- `apps/desktop` (45, 13 new). The Space review flow with the real functions: the acceptance plan, whole-plan and single-row A/B through the monitor, one comparison at a time across Gain, EQ, and Space, the milestone's demonstration (bypass, edit to +0.12, reject, Apply accepted, one undo step), stale refusal after a fader or EQ change, no staleness on selection, cancel, saved pan/width/section windows reaching the native engine and section pan reaching the legacy one. Render smoke tests of the Space panel, the stereo field, the correlation meter, and the spatial interaction view.
- `crates/audio-engine` (Rust, 20 new). Pan law, balance without crossfeed, width 0/100/150/200%, mono fold-down at every width, correlation against `(1 − w²)/(1 + w²)`, every legal setting finite and bounded, the 30 ms ramp, section windows and edges, a seek into a section, several windows, table limits, the per-block fast path against frame-by-frame processing, the offline helper, spatial through the real engine, balance and a seek through the real engine, no allocation with EQ and spatial on, stereo frames (centered, decorrelated, anti-phase, left-heavy, mono), and the proxy spatial check against the closed-form prediction.
- `npm run stress:audio` adds `stress_spatial_callback_cost` and now runs the tests one at a time.

### Acceptance run

Planned from the cached analysis, EQ band frames, and stereo frames with `plan-space-project.ts`; measured from the proxies with `render-space-audition.py`. Generated 5 used the same sections and roles as Milestones 3 and 4: Intro 0–17.7 s, Break –33.6 s, Drop –86.6 s, Drop 2 –123.7 s, Outro –141.4 s; PunchBox Kick, Bass Bus Bass, Bleeps Bus Lead, MasterEQ Pad, Skimming Air Atmosphere, Phase Plant 2 Brass "Trumpets", Stutter Expression and Subway Synth, CZ V FX; all faders at 0 dB. Stereo frames for the 11 stems took 1.3 s from existing proxies; loading the caches took 50–60 ms and planning 120–220 ms.

**Already-good mix (the producer's stems).** Where the stems sit: PunchBox centered as a point, Bass Bus 10% left, Bleeps Bus 23% left and moderately wide, MasterEQ and Stutter Expression centered and moderately wide (correlation 0.52–0.54), Skimming Air centered (0.51), Subway 73% left and fully decorrelated, CZ V centered and decorrelated.

| Case | Rows | Change |
| --- | --- | --- |
| Conservative | 0 | |
| Normal | 1 | Skimming Air (Background) 25% right, away from Phase Plant 2 in Drop 2; confidence 0.83 |
| Strong | 1 | the same row at 30% |

Kick and bass were never moved. Stutter Expression over Bleeps Bus and MasterEQ over Bleeps Bus were reported as level problems (7–19 dB over the lead where they compete), not spatial ones. The bounce changed almost nothing: stereo peak −2.95 → −2.97 dBFS, correlation 0.658 → 0.657, mono fold-down loss 0.82 dB both.

The first calibration run on this mix proposed 5 rows. Five faults caused that, and all are fixed and covered by tests:
- a move's benefit summed every pair the stem touched, so many small overlaps justified moves no single conflict would;
- conflicts below ~250 Hz counted, though position cannot separate them;
- Supporting peers far apart in level were treated as competing;
- decorrelated FX at −0.04 correlation read as phase-risky;
- a Background stem that was already fairly wide qualified for "surround" widening.

**Deliberately problematic mix.** The good mix with Stutter Expression widened to 160%, CZ V widened to 180% (correlation −0.56, 6.6 dB mono fold-down loss), Skimming Air narrowed to 40%, MasterEQ at 130%, Bleeps Bus Focal in every section, and an Outro note "Make the outro wider."

- Top conflicts: Stutter Expression and MasterEQ at 0.6–1.5 kHz in every section (both Supporting; more than 6 dB apart in level, so no automatic mover), MasterEQ and Stutter Expression over Bleeps Bus (level problems), Skimming Air under Bleeps Bus in the Intro (both centered, field overlap 0.91), Bleeps Bus and Subway at 1.5–8.4 kHz (EQ suits it better).
- Proposed, Normal: Stutter Expression global 160% → 100% and 25% right (mono safety: correlation 0.13 → 0.50, mono loss 2.5 → 1.3 dB); CZ V global 180% → 100% (correlation −0.56 → −0.04, mono loss 6.6 → 3.2 dB); Skimming Air in the Intro 40% → 70% and 25% left (surround; the center holds PunchBox, Bleeps Bus, and Bass Bus); and the Outro note as section rows: Stutter Expression 100% → 120% on top of its whole-song row, Skimming Air 40% → 60%, Phase Plant 2 100% → 120%. Subway was not widened for the note (correlation −0.01). Confidence 0.70–0.80, no review rows, no trim.
- Review, as in the milestone's demonstration: Stutter Expression's balance edited +0.25 → +0.12, Skimming Air rejected, the rest accepted.
- Bounces (stereo / mono fold-down): current peak −2.85 dBFS, correlation 0.567, lean 0.070, fold-down loss 1.06 dB; candidate −2.96 dBFS, 0.615, 0.048, 0.93 dB; reviewed −2.93 dBFS, 0.618, 0.061, 0.92 dB. The mono fold-down peak and RMS did not change (−4.25/−4.26 dBFS, −22.86 dBFS), as width never touches the mid.

**Prediction vs audio.** An independent NumPy implementation of the spatial stage on the proxies, over each row's windows:

| Row | Predicted correlation | Measured | Predicted mono loss | Measured |
| --- | --- | --- | --- | --- |
| Stutter Expression, global | 0.13 → 0.50 | 0.11 → 0.52 | 2.46 → 1.29 dB | 2.56 → 1.24 dB |
| Skimming Air, Intro | 0.90 → 0.73 | 0.90 → 0.73 | 0.21 → 0.69 dB | 0.21 → 0.69 dB |
| Skimming Air, Outro | 0.90 → 0.79 | 0.90 → 0.79 | 0.22 → 0.47 dB | 0.22 → 0.47 dB |
| Phase Plant 2, Outro | 0.64 → 0.52 | 0.66 → 0.54 | 0.87 → 1.20 dB | 0.84 → 1.16 dB |
| CZ V, global | −0.56 → −0.04 | −0.56 → −0.04 | 6.56 → 3.20 dB | 6.56 → 3.20 dB |

**Audio engine.** Release build, same machine, tests run one at a time, 512-frame callbacks (10.67 ms budget), stereo noise stems paced in real time. Ranges are two runs with a Godot process using about 60% of one core in the background:

| Stems | No processing | EQ (HPF + 2 bells + section bell) | EQ + pan, width, and two section pan/width windows |
| --- | --- | --- | --- |
| 32 | 0.18–0.19 ms (worst 0.38–1.44) | 0.55–0.57 ms (worst 1.4–2.2) | 0.45–0.49 ms (worst 0.80–0.90), 4.2–4.6% |
| 64 | 0.28–0.33 ms (worst 0.73–1.03) | 1.0–1.5 ms (worst 2.2–3.4) | 0.98–2.13 ms (worst 2.9–4.0), 9.1–20% |

Every run had 0 underruns. Run-to-run variance is larger than the cost of the spatial stage. Against the Milestone 4 engine built from the same commit on the same machine, the plain-mix throughput test (256 frames) measured 32×96 kHz 0.041 → 0.048–0.058 ms, 11×192 kHz 0.015 → 0.016–0.020 ms, and 64×48 kHz 0.115 → 0.132–0.139 ms after the per-block fast path (0.36 ms before it). The Generated 5 and Generated2 soaks played 141 s each with seeks, a loop, gain, mute, and solo, 0 underruns, callback about 0.3 ms.

**Still open before Milestone 5 is complete:**
- a physical listening pass on Current, Spatial Candidate, and the reviewed plan, in stereo and mono, for both mixes (`render-space-audition.py OUT_DIR --wav` writes the bounces), and ideally on headphones and speakers;
- a GUI walk-through in the desktop app: Plan space, the conflicts, a row's field and focus, Current / Spatial Candidate, Bypassed / Recommended, editing pan and width (drag, Shift-drag, wheel, sliders), Accept, Reject, Apply accepted, Ctrl+Z, regenerate, a stale plan after an EQ or fader change, Cancel, the lane SPACE badge and width slider, and Analysis → Spatial interaction;
- GitHub Actions on these changes.

## Milestone 6

Milestone 6 is dynamics planning: compression for broad level instability, transient shaping for attack/body imbalance, sidechain ducking for a kick/bass collision or a lead that a supporting part covers only while it plays, and dynamic EQ for frequency-specific, time-varying masking. It previews on the existing clock, level-matched, and applies as one undo step. It does not limit, maximize loudness, use multiband compression, add reverb, delay, chorus, or saturation, host plugins, match a reference, or call a model. See [Dynamics planning](architecture.md#dynamics-planning).

| Slice | Status |
| --- | --- |
| 1. Dynamics contract | Done. Schema v4 with a v3 migration: graph v2 keeps the EQ nodes and gains a typed `dynamics` list (compressor, ducking, transient, dynamic EQ), fixed stage order, per-graph limits, key routing rules (no self-keys, no loops, a missing key is inert), dynamics identity, versioned `dynamics-balance` plan |
| 2. Native compressor | Done. Stereo-linked 5 ms RMS detector, soft knee, attack/release on the reduction in dB, 30 dB cap, makeup, 30 ms fades for nodes and section edges, snap on seek, lock-free table, meters, no allocation in the callback (tested) |
| 3. Sidechain architecture | Done. Every track's frame is pulled before any is processed; keys are the key track's own source; transient (peak) and smooth (RMS) key detectors; order independence and a muted key tested through the real engine |
| 4. Dynamic EQ and transient DSP | Done. Keyed or self-detected dynamic bell on the static EQ's SVF with a band-passed detector; transient shaper on a 12 ms held level (steady tones untouched, attack shaped without its body) |
| 5. Dynamics analysis | Done. 10 ms envelope frames (RMS, peak, low band) from the proxies, sustained-level spread and swing, tempo-free self-similarity, hierarchy, onsets with attack over body and over the mix, kick/bass collision at the hits, event vs persistent masking from the EQ planner's pairs |
| 6. Planner | Done. Classification, least-invasive tool, settings from measurement with an adjust-once loop, global before section, saved nodes edited instead of stacked, regularization, limits, confidence, review rules, intent |
| 7. Candidate preview | Done. Current vs Dynamics Candidate, single-row Bypassed / Recommended, level matching in the audition only, editors heard immediately, reduction timeline, live engine meter, dynamic EQ curve, Accept / Reject, DYN badge |
| 8. Evaluation | Done. Envelope simulation for every candidate and edit, two passes, and a proxy check through the native dynamics with the reduction, spread, transients, and keyed bands measured |
| 9. Hardening | Partly. Undo, stale plans, combined stress, real-music runs with bounces, docs, and CI are done. The physical listening pass and the GUI walk-through need a person at the desktop app and are open |

### Tests

- `packages/dynamics-planner` (45). Fixtures A–H (unstable bass, healthy high-crest bass, kick/bass collision, a pre-ducked bass, lead/pad event masking, persistent masking, a spiky Supporting snare, a buried Focal snare), a saved compressor and a saved dynamic EQ and duck edited instead of stacked, a saved compressor that already does the job, Drop-only instability as a section row, the already-good mix at every strength, the acceptance demonstration, current gain and EQ removing the need for a duck, gain vs compression, section steps vs instability, no compression and transient shaping on one stem, intent (control, natural, punch through, punchy alone, an explicit pump), strength limits, determinism, a 32-stem timing check, unmeasured stems; the plan contract (round trip, edits re-checked from evidence, out-of-range edits to review, reset, inclusion rule, Current / Candidate / single-row audition with level matching, Apply all and Apply accepted, node replacement, stale identity, proxy-check merge); the phrase table; the envelope simulation against the native formulas.
- `packages/project-model` (47, 9 new). v3 → v4 migration that keeps the EQ, fixed stage order, per-graph limits, clamping and rounding, self-keys, missing keys, two- and three-track loops, ids unique across EQ and dynamics, dynamics-only Track × Section rows, dynamics identity, descriptions.
- `packages/analysis-contract` (9, 1 new). Envelope series encoding and decoding, cross-checked against the Rust encoder.
- `apps/desktop` (61, 14 new). The Dynamics review flow with the real functions: the acceptance plan, whole-plan and single-row A/B through the monitor (nodes and level matching), one comparison at a time across Gain, EQ, Space, and Dynamics, edits heard right away, the milestone's demonstration (reject Snare, the duck edited to −1.3 dB, Apply accepted, one undo step), stale refusal after a fader or EQ change, no staleness on selection, cancel, the proxy-check request, saved dynamics reaching the native engine and not the legacy one; render smoke tests of the panel, a duck's and a dynamic EQ's detail, and the legacy warning.
- `crates/audio-engine` (Rust, 29 new; 82 in all). See [Native dynamics](architecture.md#native-dynamics) for the list; also envelope frames, the dynamics proxy check (compressor spread and reduction, keyed band while the key plays and recovery, transient attack over body), and the bounce against the engine.
- `npm run stress:audio` adds `stress_dynamics_callback_cost`.

### Acceptance run

Planned from the cached analysis, EQ band frames, and envelope frames with `plan-dynamics-project.ts`; checked and bounced through the native DSP with `bounce_mix`. Planning took 100–130 ms for 11 stems and 6 sections; envelope frames 2.3 s for 11 stems from existing proxies; each proxy check 30–80 ms; each 141 s bounce about 1 s.

**Already-good mix (the producer's Generated 5 stems).** Same sections and roles as Milestones 3–5, all faders at 0 dB.

| Strength | Rows | Change |
| --- | --- | --- |
| Conservative | 1 | Bass Bus ducked 1.5 dB from PunchBox (5 / 140 ms), confidence 0.74 |
| Normal | 1 | the same, 2.5 dB, confidence 0.77 |
| Strong | 1 | the same, 4 dB, 100 ms release, review |

Bass Bus's low end sits +2.7 dB over the kick's on 63% of PunchBox's hits, which is a measured collision; on the proxy the Normal duck lowered the bass's low end by 1.9 dB while the kick plays and 0.6 dB between hits, and the bass was back at full level 55% of the kick-off time. Nothing was compressed: Stutter Expression, MasterEQ, Bleeps Bus, Bass Bus, and Subway all swing 6–21 dB in their sustained level, but every one of them repeats with the music (self-similarity 0.37–0.67), and the masking between Bleeps Bus and four supporting parts is persistent, so static EQ is named as the tool.

The first calibration run on this mix proposed six rows at every strength, five of them compressors. Two faults caused that, and both are fixed and covered by tests:
- rhythmic parts (stutters, gated or pumped pads, sequenced synths and bass) read as unstable because their sustained level swings by design;
- a Supporting part's internal swing counted even when it stayed under the stems it supports.
Two more were found on the problematic mix below: a dynamic EQ on an atmosphere already 10 dB under the lead, and a self-similarity test on the 50 ms level that let a strong rhythm hide uneven note levels (now read on the 400 ms sustained level).

**Deliberately problematic mix.** `make-problem-mix.py` derives six stems from the Generated 5 proxies: Bass Bus 4 dB louder in the drops with irregular note-level jumps (0 to −8 dB, never repeating), MasterEQ with a +7 dB presence bell at 2.5 kHz baked in, Bleeps Bus gated into 6-second phrases in the drops (Focal there), a synthetic off-beat clap with a 3 ms spike 18 dB over its body, and PunchBox and Skimming Air as they are.

| Row | Problem detected | Settings | Confidence |
| --- | --- | --- | --- |
| Bass, Global | level swings 10.8 dB without repeating | compressor 1.5:1 at −23 dB, 30 / 200 ms, knee 6, makeup 0 | 0.83 |
| Bass, Global | low end on top of the kick on 59% of hits | duck from Kick, up to −2 dB, 5 / 140 ms | 0.75 |
| Pad, Global | covers the Lead's 1.1–3.6 kHz while it plays, Lead silent 43% of the time | dynamic EQ 2.1 kHz, Q 0.8, up to −2.5 dB, keyed from Lead | 0.70 |
| Clap, Global | attacks 19.6 dB over body, +10.1 dB over the mix | transient attack −15% | 0.76 |

No row was added for anything that was not put in: Kick, Lead, and Atmosphere got nothing.

**Prediction vs audio** (native dynamics on the proxies, up to 30 s of each row's windows):

| Row | Predicted | Measured |
| --- | --- | --- |
| Bass compressor | GR 1.3 / 3.0 dB (p50/p95), level −2.12 dB, spread −2.1 dB | GR 0.6 / 2.8 dB, level −1.82 dB, spread −2.0 dB |
| Bass duck | 2.0 dB at the hits, level −0.69 dB | 1.9 / 2.0 dB while the kick plays, low band −1.63 dB then and −0.39 dB otherwise, level −0.67 dB |
| Pad dynamic EQ | 2.5 dB while the lead plays, 0 dB otherwise | 2.4 / 2.5 dB, band −1.33 dB while the lead plays and −0.24 dB while it rests |
| Clap transient | attack over body −1.1 dB | −1.4 dB (1 ms resolution: 23.0 → 21.6 dB) |
| Bass Bus duck (already-good mix) | 2.5 dB at the hits, level −0.80 dB | 2.5 dB, low band −1.94 dB while the kick plays and −0.58 dB otherwise, level −0.72 dB |

The clap's first proxy check measured almost no change (−0.1 dB): the transient shaper's 40 ms release carried attack gain into the body, and steady tones got a constant 0.6 dB offset. The shaper now follows a 12 ms held level with 20 ms releases (tested on tones and on that clap).

**Bounces** (141 s, native DSP from the proxies; `bounce_mix --wav` writes them):

| Mix | Variant | Peak | RMS | 400 ms level spread |
| --- | --- | --- | --- | --- |
| Problematic | Current | +0.72 dBFS | −22.44 dB | 12.9 dB |
| Problematic | Dynamics Candidate | −0.79 dBFS | −23.76 dB | 11.5 dB |
| Problematic | Candidate, level-matched | +0.83 dBFS | −22.30 dB | 11.5 dB |
| Problematic | Reviewed (Clap rejected, duck −1.3 dB), level-matched | +0.37 dBFS | −22.30 dB | 11.5 dB |
| Already good | Current | −2.95 dBFS | −22.04 dB | 9.2 dB |
| Already good | Dynamics Candidate | −2.95 dBFS | −22.37 dB | 8.9 dB |
| Already good | Candidate, level-matched | −2.48 dBFS | −22.00 dB | 9.3 dB |

The level-matched candidate sits within 0.15 dB RMS of Current in both mixes, so an A/B is not won by loudness. The problematic mix's stems clip together before and after (the derived bass is loud); the candidate's dynamics remove 1.3 dB of level, which matching puts back for the comparison only.

**Audio engine.** Release build, stereo noise stems paced in real time, 512-frame callbacks (10.67 ms budget), tests run one at a time. EQ + spatial is high-pass + 2 bells + a section bell and pan/width with a section window on every stem; dynamics adds a dynamic EQ keyed from stem 0, a compressor, a transient shaper, a duck keyed from stem 0, and a section compressor on every stem (more than any plan proposes):

| Stems | None | EQ + spatial | EQ + spatial + dynamics |
| --- | --- | --- | --- |
| 11 | 0.07 ms (worst 0.16) | 0.14 ms (worst 0.35) | 0.32 ms (worst 0.58), 3.0% |
| 32 | 0.14 ms (worst 0.32) | 0.44 ms (worst 0.63) | 0.99 ms (worst 1.29), 9.3% |
| 64 | 0.26 ms (worst 0.46) | 0.61 ms (worst 1.19) | 1.88 ms (worst 2.79), 17.7% |

Every run had 0 underruns. The rest of `npm run stress:audio` was unchanged in kind: the plain-mix throughput test (256 frames) measured 32×48 kHz 0.059 ms, 32×96 kHz 0.059 ms, 11×192 kHz 0.018 ms, and 64×48 kHz 0.145 ms of 5.33 ms; the Generated 5 and Generated2 soaks played 141 s each with seeks, a loop, and gain moves, 0 underruns, callback 0.27 and 0.19 ms.

**Still open before Milestone 6 is complete:**
- a physical listening pass on Current, the Dynamics Candidate, and the reviewed plan for both mixes (the `bounce_mix --wav` bounces, and the desktop app), listening for pumping, lost transients, over-compression, release behavior, low-end stability, and lead clarity;
- a GUI walk-through in the desktop app: Plan dynamics, a row's detail, Current / Dynamics Candidate, Bypassed / Recommended, editing a compressor, a duck, and a dynamic EQ, Accept, Reject, Apply accepted, Ctrl+Z, regenerate, a stale plan after an EQ or fader change, Cancel, the DYN badge, and the live meter.

## Milestone 7

Milestone 7 is Full Mix planning: one coordinated plan across gain, static EQ, space, compression, ducking, transient shaping, and dynamic EQ that starts from problems, weighs alternatives against their cost, re-measures whole-mix candidates, and keeps the fewest changes that measurably help. The four planners stay separately usable. It does not add a conversational agent, a model, mastering, limiting, reverb, delay, saturation, plugins, reference matching, or preference learning. See [Full Mix planning](architecture.md#full-mix-planning).

| Slice | Status |
| --- | --- |
| 1. Problem model | Done. `MixProblem`: scope, stems, protected and yielding stem, severity, confidence, priority group, evidence lines per planner, references; one problem per relationship whatever number of planners saw it; a re-readable measure (gaps in dB in a fixed region, spreads, conflicts, mono risk, contrast) |
| 2. Intervention model | Done. Every Level, EQ, Space, and Dynamics row becomes a `MixChange` with its evidence; alternatives per problem (rows, a fader move where it is a level problem, a small kick-fundamental cut, two singles at reduced depth), all judged on the problem's own evidence with the planners' evaluators |
| 3. Cost / regularization | Done. Per-processor cost, side-effect price, anchor and section penalties, a second-processor penalty, goal lean, minimum net and reduction, confidence rules, change and cost budgets per strength |
| 4. Integrated candidate builder | Done. Problems in priority order, credit for changes already chosen, no contradicting values, minimal / balanced / assertive whole-mix candidates |
| 5. Candidate evaluation | Done. The four planners run again on each candidate through measurement views (dynamics folded in for EQ, Space, and AutoBalance), problems re-read, new problems, headroom, mono, gain reduction, level shifts, section steps; leave-one-out pruning; regression revision |
| 6. Iteration | Done. 2 / 3 / 4 passes, problems first seen on a candidate rebased to the saved mix, a level-first pass when a stem is far off, deterministic stopping with the reason stated |
| 7. Full Mix UI | Done. Plans → Full Mix: problem-oriented view, evidence, alternatives considered, Current vs Full Mix Candidate (loudness-matched), only-this-fix / candidate-without-it, per-change A/B, Accept / Reject / Edit per change, Accept / Reject solution per problem, planning in a worker |
| 8. Apply / undo / stale | Done. One project update for every domain, one undo step, nothing written if any change cannot be stored, stale on anything the plan read, not on selection |
| 9. Hardening | Partly. Fixtures, regression tests, real-music runs with bounces, the independent-vs-integrated comparison, the render check, combined DSP stress, docs, and CI are done. The physical listening pass and the GUI walk-through need a person at the desktop app and are open |

### Tests

- `packages/mix-planner` (33, new). The problem model (one problem per relationship, evidence from several planners); fixtures A–H (one problem with four possible fixes gets one or two cheap moves on the supporting part; kick/bass ducked, not lowered everywhere, with the rejected fader move explained; a conflict saved EQ already fixed gets no spatial move; an excessively loud pad gets a fader cut and nothing else; static masking gets a static cut; event masking gets a dynamic EQ, not a permanent cut; an already-good mix gets at most one change at every strength; a drop that lacks its asked-for width and punch gets one or two section moves and no blanket gain lift, and a note the mix already satisfies gets nothing); intent ("make the trumpet stand out" weighed across domains, not turned into a boost; nothing when it already stands out); the multi-problem song is not a concatenation (fewer changes than the four planners, at most one change of a kind per stem, the over-wide synth narrowed); no conflict solved with gain, EQ, pan, and a duck together; one change serving two problems; determinism; the pass limit and stop reason; Conservative ≤ Strong; re-measured severity after; headroom, mono, and gain reduction inside their limits; a harmful candidate scored below the baseline with regressions; manual compressor not duplicated and kept; an applied plan as the new baseline; review rows never chosen; 32 stems in seconds. The plan contract: round trip, stale identity (fader, EQ, width, role, prominence and notes, section intent, settings; not selection), accept and reject by change and by problem, edits re-checked with the subsystem evaluators and out-of-range edits to review, reset, every audition mode, loudness matching, Apply all and Apply accepted, atomic refusal.
- `apps/desktop` (75, 14 new). The Full Mix review flow with the real functions: Current vs candidate through the monitor with gain, EQ, space, and dynamics together and a uniform loudness offset; only-this-fix and candidate-without-it; one-change A/B; one comparison at a time across all five plans; an edit heard at once; accept by problem and by change, Apply accepted, one undo step; partial apply refused with the reason; stale refusal after a fader move but not selection; cancel; the render-check request from the engine's own settings. Render smoke tests of the panel, its problems, alternatives, editors, and the legacy warning.
- `crates/audio-engine` (Rust, 3 new; 85 in all). A window render equals the same span of a full render; the mix check's peak, level, mono fold-down, correlation, and section levels follow the settings; windows are clamped, sorted, and merged. `stress_dynamics_callback_cost` gains a "full" load with section gain windows on every stem.
- `packages/dynamics-planner` (45). Unchanged in behaviour; interactions now carry `levelGapDb`.

### Acceptance run

Planned with `plan-full-mix-project.ts` from the cached analysis, EQ band frames, stereo frames, and envelope frames; bounced through the native DSP with `bounce_mix`. Normal strength unless stated.

**Deliberately problematic mix.** `make-full-mix-problem.py` builds six stems from the Generated 5 proxies: Kick (PunchBox), Bass (Bass Bus 4 dB louder in the drops with irregular note-level jumps), Lead (Bleeps Bus gated into phrases in the drops, Focal there), Pad (MasterEQ with a +7 dB presence bell), Synth (Stutter Expression), Atmosphere (Skimming Air). The scenario sets Synth to width 160% and 30% right and Pad to 20% right, so the two crowd the right-center and the synth loses 2.6 dB in mono.

The four planners on their own propose 11 changes: Level 5 (Bass −1.5 dB, a Bass Outro row, Lead +4 dB in Drop and Drop 2 for review, Pad −1.9 dB), EQ 1 (Pad −2.6 dB at 2.1 kHz), Space 1 (Synth 160% → 100%, 50% right), Dynamics 4 (Bass compressor, Bass duck from Kick, Pad dynamic EQ keyed from Lead, Synth dynamic EQ keyed from Lead).

Full Mix found 9 significant issues and selected 6 changes in 4.2 s (44 planner runs):

| Problem | Severity before → after | Selected | Considered and rejected |
| --- | --- | --- | --- |
| Kick/Bass low-end collision | 0.89 → 0.04, solved | Bass duck from Kick, up to −2.0 dB (with the Bass level fix below crediting 46% of it) | Bass bell −1.5 dB at 55 Hz: removes 32% against 54%, costs more outside the conflict |
| Bass too loud for its role | 0.50 → 0.05, solved | Bass −1.5 dB | Bass compressor: a comparable result for more processing |
| Pad too loud for its role | 0.63 → 0.47, improved | Pad −1.9 dB | — |
| Pad masks Lead around 2.1 kHz (lead rests 43% of the pad's time) | 0.77 → 0.32, improved | Pad bell −2.6 dB at 2.1 kHz, Q 1.0 | Pad dynamic EQ: a comparable result (35% against 34%) for more processing; EQ + dynamic EQ: one processor already does enough |
| Synth masks Lead around 1.8 kHz | 0.71 → 0.42, improved | Synth dynamic EQ 2.0 kHz, up to −2.5 dB, keyed from Lead | Synth −2.0 dB: would change it everywhere it plays |
| Synth too wide for mono | 0.58 → 0.24, solved | Synth width 160% → 100%, 50% right | — |
| Synth crowds Pad in the field | 0.42 → 0.29, improved | (served by the Synth width change: one change, two problems) | — |
| Bass level unstable | 1.00 → 0.80, left alone | — | Bass compressor 1.5:1: removes 31% of the swing; benefit 0.25 against cost 0.16 and 0.06 of side effects |
| Lead too quiet in the drops | 1.00 → 1.00, left alone | — | Lead +4 dB in Drop and Drop 2: AutoBalance marked them for review (the uncapped correction was past 6 dB), so Full Mix does not choose them |

Two weaker relationships (Atmosphere over Lead 0.53, Lead over Kick 0.47) were read and left alone with no move worth making. Re-measured: problem score 7.09 → 4.43, open problems 11 → 6, mix correlation 0.679 → 0.726, mono fold-down loss 0.76 → 0.64 dB, largest gain reduction on one stem 2.5 dB, processing cost 0.72 (moderate). The three first-pass candidates scored minimal 1.18 (7 changes), balanced 1.82 (6, kept), assertive 1.00 (8); the second pass found nothing worth its cost. Review as in the milestone's demonstration: the duck edited to −1.4 dB, everything else accepted. Conservative selected 3 changes (Lead +2 dB in the Drop, Pad −1.7 dB, the duck at −1.5 dB), Strong 5.

**Already-good mix (the producer's Generated 5 stems).** Same roles and sections as Milestones 3–6, faders at 0 dB, saved processing cleared. The four planners propose 9 (Level 5, EQ 2, Space 1, Dynamics 1); Full Mix found 7 issues and selected 5 in 3.6 s: Bass Bus −1.1 dB and a duck from PunchBox (−2.5 dB), Bleeps Bus +4 dB in Drop 2, MasterEQ bell −2.3 dB at 1.6 kHz, and Subway bell −1.7 dB at 2.2 kHz. MasterEQ −4 dB in the Intro was left out once the rest of the plan covered it; Stutter Expression's masking of Bleeps Bus and Skimming Air's three crowding pairs were read and left alone. Conservative selected 3 (MasterEQ −0.7 dB, Bleeps Bus +2 dB in Drop 2, Bass Bus −1.0 dB), Strong 6. These are measured relationships the four planners also act on, not invented moves; whether five changes is "few" for this mix is a listening call that is still open.

**Independent vs integrated.**

| Mix | Level | EQ | Space | Dynamics | Four planners | Full Mix selected | The four planners' rows Full Mix left out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Problematic | 5 | 1 | 1 | 4 | 11 | 6 | 5: Bass compressor, Pad dynamic EQ, Lead +4 dB in Drop and Drop 2, the Bass Outro section row |
| Already good | 5 | 2 | 1 | 1 | 9 | 5 | 4: MasterEQ −0.6 dB and −4 dB in the Intro, Bass Bus −2.1 dB in the Outro, Skimming Air 25% right |

**Bounces** (141 s, native DSP from the proxies; `bounce_mix --wav` writes them to `target/acceptance/m7-problem` and `target/acceptance/m7-good`):

| Mix | Variant | Peak | RMS | 400 ms spread | Mono loss | Correlation |
| --- | --- | --- | --- | --- | --- | --- |
| Problematic | Current | −1.54 dBFS | −21.70 dB | 11.5 dB | 0.92 dB | 0.620 |
| Problematic | Four planners combined (Apply all, one after another) | −4.05 dBFS | −24.34 dB | 10.6 dB | 0.78 dB | 0.676 |
| Problematic | Full Mix Candidate | −4.05 dBFS | −23.62 dB | 11.3 dB | 0.76 dB | 0.682 |
| Problematic | Full Mix Candidate, loudness-matched (+2.04 dB) | −2.01 dBFS | −21.58 dB | 11.3 dB | 0.76 dB | 0.682 |
| Problematic | Reviewed (duck −1.4 dB), loudness-matched | −2.09 dBFS | −21.58 dB | 11.3 dB | 0.75 dB | 0.683 |
| Already good | Current | −2.95 dBFS | −22.04 dB | 9.2 dB | 0.82 dB | 0.658 |
| Already good | Four planners combined | −4.31 dBFS | −23.35 dB | 10.0 dB | 0.84 dB | 0.650 |
| Already good | Full Mix Candidate | −3.72 dBFS | −23.07 dB | 8.6 dB | 0.85 dB | 0.647 |
| Already good | Full Mix Candidate, loudness-matched (+0.96 dB) | −2.76 dBFS | −22.11 dB | 8.6 dB | 0.85 dB | 0.647 |

The loudness-matched candidate renders within 0.12 dB (problematic) and 0.07 dB (good) of Current's RMS, so the A/B is not won by loudness. Nothing clips; mono fold-down improves on the problematic mix and moves 0.03 dB on the good one. Full Mix reaches the four planners' mono and correlation improvement on the problematic mix with about half the changes, and keeps 0.7 dB more level before matching because it does not stack every planner's cut.

**Planning time** (Node on this machine, the same code the desktop runs in a worker):

| Project | Conservative | Normal | Strong |
| --- | --- | --- | --- |
| Generated 5, 11 stems | 0.6 s (12 planner runs) | 3.7 s (64) | 5.1 s (87) |
| Problematic mix, 6 stems | 1.2 s (12) | 4.2 s (44) | 5.4 s (48) |
| Synthetic, 32 stems | | 6.2 s (8) | |
| Synthetic, 64 stems | | 27.2 s (8) | |

At 64 stems one EQ planner run alone takes 6.7 s (Space 3.8 s, Dynamics 3.6 s): Full Mix's time is the four planners' time, run a few times. The four planners on their own take 0.25–0.6 s on the 11- and 6-stem projects.

The first 32-stem run took 27.8 s with 32 planner runs; caching each planner's reading by its own state identity of the view it sees brought it to 7.8 s with 8 runs and the same plan.

**Audio engine.** Release build, stereo noise stems paced in real time, 512-frame callbacks (10.67 ms budget), tests run one at a time. "Full" is every processor a Full Mix candidate can write at once: high-pass, two bells, and a section bell; pan and width with a section window; a dynamic EQ keyed from stem 0, a compressor, a transient shaper, a duck keyed from stem 0, and a section compressor; and two Track × Section gain windows, on every stem (more than any plan proposes):

| Stems | None | EQ + spatial | EQ + spatial + dynamics | Full |
| --- | --- | --- | --- | --- |
| 11 | 0.05–0.08 ms (worst 0.09–0.19) | 0.14–0.16 ms (worst 0.21–0.36) | 0.36–0.37 ms (worst 0.85–1.09) | 0.33 ms (worst 0.56–0.83), 3.1% |
| 32 | 0.14–0.15 ms (worst 0.25–0.32) | 0.37–0.44 ms (worst 0.57–1.11) | 0.99–1.37 ms (worst 1.29–3.56) | 1.03–1.20 ms (worst 1.62–1.67), 9.7–11.2% |
| 64 | 0.26–0.31 ms (worst 0.58–0.73) | 0.59–1.92 ms (worst 1.02–3.12) | 1.73–4.79 ms (worst 2.27–6.56) | 2.35–3.20 ms (worst 3.15–7.75), 22–30% |

Ranges are two runs: once alone, once inside the full `npm run stress:audio`. The 64-stem runs vary more between runs than between loads; the second run's worst callback (7.75 ms) is still under the budget. Every run had 0 underruns. The rest of `npm run stress:audio` was unchanged in kind: EQ cost 0.06–0.68 ms for 11–64 stems; the plain-mix throughput test (256 frames) 32×48 kHz 0.060 ms, 32×96 kHz 0.061 ms, 11×192 kHz 0.018 ms, 64×48 kHz 0.129 ms of 5.33 ms; spatial up to 1.30 ms at 64 stems; the Generated 5 and Generated2 soaks played 141 s each with seeks, a loop, and gain moves, 0 underruns, callback 0.20 and 0.19 ms. Planning runs in a worker and never on the audio thread.

**Still open before Milestone 7 is complete:**
- a physical listening pass on Current, the four planners combined, the Full Mix Candidate, and the reviewed plan for both mixes (the `bounce_mix --wav` bounces, and the desktop app), judging whether the candidate is clearer, more coherent, and less processed, and whether five changes on the already-good mix are right;
- a GUI walk-through in the desktop app: run Full Mix, inspect problems, expand one, view evidence, preview one solution and the whole mix, reject a change, edit a change, accept a problem's solution, Apply accepted, Ctrl+Z, regenerate, change an EQ so the plan goes stale, Cancel.

## Milestone 8

Milestone 8 is the conversational assistant: the person describes what they hear or want, and the assistant reads the project, measures with the planners, builds a candidate with them, explains it from their evidence, and lets the person preview, refine, and apply it. It invents no mix values (the planners compute every change), writes nothing without the person's go-ahead, sends no audio, and is optional: every planner works without it. See [Conversational assistant](architecture.md#conversational-assistant) and [assistant.md](assistant.md).

| Slice | Status |
| --- | --- |
| 1. Agent contract | Done. Permissions (READ, PLAN, PREVIEW, WRITE, FINAL), constraints, UI focus, decisions, cards, transcript, candidate history, session state, request limits (`packages/mix-agent/src/contract.ts`) |
| 2. Context builder | Done. Compact JSON per request (stems, sections, selection, the request's resolved references and constraints, standing constraints, the live candidate with the person's edits, candidates, last apply), 9,000-character budget, recent window plus summary; no audio, paths, or keys |
| 3. Tool registry | Done. 19 tools on an allowlist, zod-validated, each with a permission and a "when to use" description; the tools reach the app only through `AgentEnvironment` |
| 4. Provider abstraction | Done. Neutral `AgentModel`; one Anthropic provider through the official SDK, routed through the Tauri shell, which holds the key and allows only the Messages endpoint |
| 5. Core loop | Done. Deterministic reading, then model ⇄ tools, ≤ 8 model calls and ≤ 12 tools per request, final reply validated and grounding-checked, superseded requests discarded |
| 6. Candidate integration | Done. Candidates are Full Mix plans in the existing review: same A/B, editors, apply, and undo; cards for Preview, Current, Inspect, Apply; replies focus stems, sections, problems, changes |
| 7. Refinement | Done. Scale from current values (named amounts or a stated factor), remove, restore, accept, reset, another option, compare, go back, simplify |
| 8. Safety, permission, privacy | Done. Writes need the person's words or a button; explicit values only from the person; stale and constraint-violating candidates refused; cancellation; privacy disclosure; metadata-only logs |
| 9. Acceptance | Partly. Conversation fixtures, two real-project conversations through the real planners with renders, the independent grounding audit, the direct-planner comparison, CI, and docs are done. Conversations with a live model, the hallucination review of live transcripts, the physical listening pass, and the GUI walk-through are open (see below) |

Full Mix gained what the assistant needs (planner 7.1.0): constraints (protected stems, ruled-out domains and processors, allowed sections with song-wide moves rescoped into them, focus), request intents read like section notes, `scaleChange`, and `simplifyFullMix`. A plan without constraints is unchanged: the Milestone 7 acceptance reports reproduce byte for byte.

### Tests

- `packages/mix-agent` (63, new). References (names, labels, head nouns, roles and import patterns, plurals as groups, ambiguity, selection and focus, sections by name, ordinal, number, type, and "here"); language (protected stems, ruled-out domains and processors, scope and placement, strength and standing strength, narrow routes, releases, approval for apply and undo, explicit values, stated factors). Conversations with a scripted model on the real planners: an explicit edit as one undo step; an unstated value refused; no tool takes a raw EQ value; diagnosis without changes; "leave it" with the healthy relationship as evidence; broad request to Full Mix, never the project; each domain route only in its domain; the person's narrowing holds over the model's route; protected stem never changed, even when the model forgets, and standing for the session; excluded EQ; section-only scope; a request intent planned and not saved; ambiguity asks; the selection resolves "this … here"; no apply without approval and "let's hear it" previews; "do it" only after a presented candidate; a false "applied" claim corrected; the panel's Apply; weak → less aggressive → keep the EQ, lose the width → apply persists only the reviewed candidate; "a little less" from the person's edit; stated factors only; another option, compare, go back; simplify; undo after apply and discard before; no undo over a manual edit; stale refusal; a candidate built while the mix changed refused; tool failure reported as failure; missing analysis stated; an invented number sent back and replaced; tool-result numbers pass; invalid arguments; the model-call limit; supersede leaves everything as it was; no paths or audio in what is sent and the transcript window; metadata-only logs; provenance; large results shortened as valid JSON.
- `packages/mix-planner` (46, 13 new). Empty constraints change nothing; protected stems; excluded domain; excluded processor; focus; out-of-focus problems scored as regressions, not new problems; section-only rescoping writes nothing outside the section; constraints in the identity; determinism; request intents equal saved notes, unsaved, not stale; numbers stripped from intents; `scaleChange` from the current value and inside the bounds; `simplifyFullMix`.
- `apps/desktop` (85, 10 new). With the real store, review, apply, and undo: a candidate in the Full Mix review without touching the project; "let's hear it" switches the A/B; the person's plan-UI edit is read and applied exactly, one undo step, and conversational undo is the store's undo; stale refusal from the conversation and from the card; UI focus without an undo entry; an explicit pan as one undo step; offline without a provider; cancel; nothing in the project file; the panel renders its cards and the offline notice.
- `apps/desktop/src-tauri` (Rust, 4 new). Only POST to the Messages endpoint; credential headers from the webview dropped; settings round trip with the key never returned and stored owner-only; nothing sent without a configured provider.

### Acceptance run

No provider credential was available in the development environment (no `ANTHROPIC_API_KEY`, no stored key), so no conversation has run against a live model yet. The tool layer, the planners, the constraint and permission guards, and the render checks were exercised on real music with scripted model decisions: `converse-project.ts` drives the real planners, apply, and undo on the Milestone 7 projects from their cached analysis, and `bounce_mix` renders every candidate and applied state through the native DSP. Scripted replies are composed only from that turn's tool results and pass the same grounding check; an independent audit of each final reply against everything the agent saw found no unsupported value or claimed write in either conversation.

**Deliberately problematic mix** (19 turns, `conversations/problem-mix.json`):

| Request | Route and tools | Result |
| --- | --- | --- |
| What's wrong with the mix? | detect | Lead too quiet for its role (1.00), Bass level unstable (1.00), Kick/Bass collision (0.89); no candidate |
| The kick is getting buried. | detect, plan_mix full, focus Kick | Candidate A: Bass duck from Kick up to −1.3 dB + Bass −1.0 dB; collision 0.89 → 0.35 re-measured |
| Why ducking instead of lowering the bass? | explain_problem | From the planner's alternatives: the combination removes 65%; the duck alone 54%, Bass −1.5 dB alone 46% "and would change the stem everywhere it plays", a 55 Hz bell 32% |
| A little less on the duck. | refine scale slightly-less (ducking) | Duck −1.3 → −1.1 dB |
| Let's hear it. / Apply it. / Undo that. | preview / apply / undo | A/B on the candidate; applied as one undo step; undone through the history (render equals Current) |
| Make the lead clearer, but don't touch the lead itself. | plan_mix full, focus Lead; Lead protected from the words | Candidate B: Pad −1.9 dB, Synth −2.0 dB; nothing on the Lead |
| (Pad edited to −1.2 dB in the plan UI) Keep the pad change but lose the synth change. | refine remove Synth, accept Pad | The person's −1.2 dB kept and accepted, Synth rejected |
| Another option, more conservative. / What's the difference? / Go back to the previous one. | plan_mix conservative / compare / select | Candidate C (Pad −1.7, Synth −1.0); difference listed by processing; back to B with the person's edit |
| Clean the whole mix up. | plan_mix full | Candidate D, identical to Full Mix run directly (6 changes; renders equal to Milestone 7's candidate) |
| This sounds better, but maybe too processed. | simplify | Candidate E: the duck and the Synth dynamic EQ out, 6 → 4 changes, ≥ 80% of the measured improvement kept |
| Only change Drop 2: the synth is too wide there. | plan_mix space; Drop 2 only from the words | Candidate F: Synth width 160% → 100% in Drop 2 only |
| Pan the pad 20% left. | set_track_control | Exactly that, one undo step |
| Make the chorus punchier. | plan_mix | Refused: there is no chorus (sections listed), nothing changed |
| Fix the low end, no compression. | plan_mix full, compressor ruled out from the words | Candidate G: Bass −1.5 dB and a duck from Kick; no compressor |
| (Bass fader moved) Apply it. | apply | Refused: Candidate G is out of date |

**Already-good mix** (8 turns, `conversations/good-mix.json`):

| Request | Result |
| --- | --- |
| Should the bass be louder? | No: the planners measure Bass Bus too loud for its role (0.70) and a PunchBox/Bass Bus collision (1.00); the other kicks' relationships are fine |
| Make the kick punchier. | Three kick-role stems: the agent asks SideKick6, PunchBox, or 2nd BD |
| PunchBox. | Candidate A: Bass Bus −1.1 dB (goal punchy) |
| (Trumpets and Drop 2 selected) Make this stand out more here. | Candidate B, Drop 2 only: MasterEQ, Stutter Expression, PunchBox, Skimming Air −2 dB each there; the Trumpets themselves unchanged (the level planner makes room). Whether lowering the kick there is right is a listening call |
| Make the drop wider without changing the lead. | Candidate C: Stutter Expression and MasterEQ 100% → 120% in the Drop only; mono loss 0.82 → 0.86 dB |
| No stereo changes. Just make the drop less crowded. | Candidate D: Bass Bus duck from PunchBox, MasterEQ −2.3 dB at 1.6 kHz, Subway −1.7 dB at 2.2 kHz; no space change; Lead still protected from the previous request |
| What processing is on the bass bus? / Why does the breakdown feel crowded? | Read from the project; the breakdown's measured problem is the PunchBox/Bass Bus collision, two relationships there are fine |

**Renders** (`bounce_mix`, 141 s, native DSP from the proxies): the applied state rendered identically to the previewed candidate without loudness matching (RMS −22.23 dB, correlation 0.602), and the state after conversational undo identically to Current. The "clean it up" candidate rendered exactly as Milestone 7's Full Mix Candidate (peak −4.05 dBFS, RMS −23.62 dB, correlation 0.682); the simplified candidate kept its mono and correlation gains (0.75 dB, 0.684) with two fewer processors. Loudness-matched candidates rendered within 0.15 dB RMS of Current on the problematic mix; on the good mix within 0.15 dB except the Drop 2-only candidate, 0.30 dB under (its loudness estimate is song-wide, so a change confined to one section is matched only partly).

**Request latency without the model** (tools only, Node): mix reading 0.2–0.6 s, focused plans 0.3–2.5 s, a whole-mix plan 2–4.5 s, simplification 7.5 s, refinement, preview, and apply under 10 ms.

**Still open before Milestone 8 is complete:**
- real conversations with a live model: run both conversation files with `AGENT_MODEL=anthropic` (and 10–15 free-form requests in the app), record routing, diagnosis, candidates, refinements, latency, and review every transcript for unsupported claims, invented values, and claimed writes;
- a physical listening pass on the candidates above (the `bounce_mix --wav` renders and the desktop A/B), checking that each candidate matches its explanation, that refinements change what they claim, and that Apply matches the preview by ear;
- a GUI walk-through: open Assistant, connect a provider, ask a diagnostic question, ask for a candidate, preview it, inspect the highlighted problem, refine by conversation and in the plan UI, continue, apply, undo, change the mix and see the candidate go stale, cancel a request in flight;
- the Milestone 7 listening pass and walk-through, which are still open too.

## Explicitly later

Multiband compression, de-essing, lookahead, gain-reduction automation editing, frequency-dependent width, stereo synthesis (delay, Haas, chorus, decorrelation), saturation, reverb, delay, limiting, mastering, final render, VST hosting, reference matching, an ML mixing model, a general-purpose or autonomous agent, web access for the assistant, preference learning, accounts, collaboration, and source separation.
