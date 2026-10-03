import {
  channelLabel,
  formatBitDepth,
  formatBytes,
  formatClock,
  formatSampleRate,
  TRACK_ROLE_LABELS,
} from "@audiosous/project-model";
import { Panel, RoleSelect, TextField } from "../components/ui";
import { editProjectName, editTrack } from "../lib/project-actions";
import { getPlatform, isTauri } from "../platform";
import { useAppStore } from "../state/app-store";

export function ProjectScreen() {
  const document = useAppStore((state) => state.document);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const warnings = useAppStore((state) => state.warnings);
  const goWelcome = useAppStore((state) => state.goWelcome);
  const dirty = useAppStore((state) => state.dirty);
  if (!document) return null;

  function leave() {
    if (dirty && !window.confirm("Leave this project without saving?")) return;
    goWelcome();
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <TextField label="Project" value={document.project.name} onChange={editProjectName} />
        </div>
        <button type="button" className="mt-7 text-sm text-muted underline-offset-2 hover:underline" onClick={leave}>
          Close
        </button>
      </div>

      <p className="font-mono text-sm text-muted">
        {document.tracks.length} {document.tracks.length === 1 ? "stem" : "stems"}
        {" · "}
        {formatSampleRate(document.project.sampleRate)}
        {" · "}
        {formatClock(document.project.durationSeconds)}
      </p>
      <p className="text-sm text-faint">
        {isTauri()
          ? projectFilePath
          : "Preview project. Save downloads project.amix. The desktop app also copies the stems into a folder."}
      </p>

      {warnings.length > 0 ? (
        <ul className="space-y-1 text-sm text-danger">
          {warnings.map((warning) => (
            <li key={`${warning.code}-${warning.trackId ?? warning.filename}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}

      <Panel>
        <div className="grid grid-cols-[minmax(0,1.3fr)_11rem_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2 text-xs tracking-wide text-muted uppercase">
          <span>Stem</span>
          <span>Role</span>
          <span>File</span>
        </div>
        <ul>
          {document.tracks.map((track) => (
            <li key={track.id} className="grid grid-cols-[minmax(0,1.3fr)_11rem_minmax(0,1fr)] gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <div>
                <input
                  value={track.name}
                  aria-label={`Name for ${track.file.filename}`}
                  onChange={(event) => editTrack(track.id, { name: event.target.value })}
                  className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 hover:border-line focus:border-line"
                />
                <p className="px-2 text-xs text-faint">{TRACK_ROLE_LABELS[track.role]}</p>
                {track.role === "other" ? (
                  <input
                    value={track.customLabel ?? ""}
                    placeholder="Custom label"
                    aria-label={`Custom label for ${track.file.filename}`}
                    onChange={(event) => editTrack(track.id, { customLabel: event.target.value || null })}
                    className="mt-2 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm"
                  />
                ) : null}
              </div>
              <RoleSelect
                value={track.role}
                aria-label={`Role for ${track.file.filename}`}
                onChange={(role) => editTrack(track.id, { role })}
              />
              <div className="text-sm text-muted">
                <p className="truncate">{track.file.filename}</p>
                <p className="mt-1 text-xs text-faint">
                  {formatSampleRate(track.metadata.sampleRate)} · {channelLabel(track.metadata.channelCount)} ·{" "}
                  {formatBitDepth(track.metadata.bitDepth)} · {formatClock(track.metadata.durationSeconds)} ·{" "}
                  {formatBytes(track.metadata.fileSizeBytes)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="text-sm leading-relaxed text-faint">
        Playback and the timeline are not in this version yet. Roles, file info, and the project file are saved.
        {getPlatform().kind === "browser" ? " Media files are not copied in the browser preview." : " Source files were not modified."}
      </p>
    </div>
  );
}
