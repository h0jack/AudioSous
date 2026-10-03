# Milestones

The product target is an AI-assisted visual mixer. Processing is out of scope until the project, the clock, and the selection context exist.

## Milestone 1 slices

| Slice | Status |
| --- | --- |
| 1. Repository and application shell | Done |
| 2. Project schema | Done |
| 3. Stem import | Done |
| 4. Waveform cache | Not started |
| 5. Timeline | Not started |
| 6. Audio engine implementation | Interface only |
| 7. Synchronized transport | Not started |
| 8. Mixer controls | Schema reserved; UI not started |
| 9. Selection model editing | Schema reserved; UI not started |
| 10. Manual sections | Not started |
| 11. Section and track intent editing | Schema reserved; UI not started |
| 12. Looping | Interface reserved; not started |
| 13. Undo / redo | Not started |
| 14. Save / reopen | Explicit save, recovery copy, and reopen work. Autosave-on-edit is not started |
| 15. Experimental section detection | Contract reserved; not started |
| 16. Performance pass | Not started |
| 17. Broader automated tests | Model, parser, import, and bundle tests are in place |

Import is not real until a project can be opened again, so this slice includes create, explicit save, the recovery copy, and reopen. It does not autosave while a control is being dragged.

## Explicitly later

Automatic EQ, compression, saturation, reverb, delay, mastering, VST hosting, generated mixes, LLM agents, accounts, collaboration, and source separation.
