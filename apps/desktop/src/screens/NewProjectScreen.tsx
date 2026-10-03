import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildImportReport,
  channelLabel,
  formatBitDepth,
  formatClock,
  formatSampleRate,
  PathSafetyError,
  sanitizeBundleName,
} from "@audiosous/project-model";
import { Button, Panel, RoleSelect, TextField, Truncated } from "../components/ui";
import { logEvent } from "../lib/log";
import { inspectListedFiles } from "../lib/inspect-stems";
import { createProjectFromStems } from "../lib/project-actions";
import { demoStems, stemsAsImported, type PendingStem } from "../lib/stems";
import { browserFilesFromDrop, getPlatform, isTauri } from "../platform";
import { useAppStore } from "../state/app-store";

export function NewProjectScreen() {
  const goWelcome = useAppStore((state) => state.goWelcome);
  const [name, setName] = useState("Night Drive");
  const [stems, setStems] = useState<PendingStem[]>([]);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const platform = getPlatform();
  const desktop = isTauri();
  const report = useMemo(() => buildImportReport(stemsAsImported(stems)), [stems]);
  const addPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => {});

  addPathsRef.current = addPaths;

  useEffect(() => {
    if (!desktop) return;
    let unlisten = () => {};
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setHover(true);
        if (event.payload.type === "leave") setHover(false);
        if (event.payload.type === "drop") {
          setHover(false);
          const paths = "paths" in event.payload ? event.payload.paths : [];
          void addPathsRef.current(paths);
        }
      });
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [desktop]);

  async function addPaths(paths: string[]) {
    if (paths.length === 0 || busy) return;
    setError(null);
    setBusy("Looking for stems");
    try {
      const listed = await platform.listAudioFiles(paths);
      const inspected = await inspectListedFiles(listed, platform.readUserRange.bind(platform), setBusy);
      await recordInspections(inspected);
      setStems((current) => [...current, ...inspected]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those files could not be read.");
    } finally {
      setBusy(null);
    }
  }

  async function addListed(files: { path: string; filename: string; fileSizeBytes: number }[]) {
    if (files.length === 0) return;
    setError(null);
    setBusy("Reading stems");
    try {
      const inspected = await inspectListedFiles(files, platform.readUserRange.bind(platform), setBusy);
      await recordInspections(inspected);
      setStems((current) => [...current, ...inspected]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those files could not be read.");
    } finally {
      setBusy(null);
    }
  }

  async function recordInspections(inspected: PendingStem[]) {
    for (const stem of inspected) {
      if (stem.inspection.ok) {
        await logEvent(platform, "info", "track.import", "Read a stem header.", {
          filename: stem.filename,
          role: stem.role,
          sampleRate: stem.inspection.sampleRate,
        });
      } else {
        await logEvent(platform, "warn", "track.decode.failure", stem.inspection.message, { filename: stem.filename });
      }
    }
  }

  async function addBrowserDrop(fileList: FileList) {
    const listed = browserFilesFromDrop(fileList);
    await addListed(listed);
  }

  function updateStem(key: string, patch: Partial<PendingStem>) {
    setStems((current) => current.map((stem) => (stem.key === key ? { ...stem, ...patch } : stem)));
  }

  async function create() {
    setError(null);
    setBusy("Creating project");
    try {
      await createProjectFromStems({ platform, name, stems, onProgress: setBusy });
    } catch (caught) {
      setError(caught instanceof PathSafetyError || caught instanceof Error ? caught.message : "The project could not be created.");
    } finally {
      setBusy(null);
    }
  }

  let folderName = "";
  try {
    folderName = sanitizeBundleName(name);
  } catch {
    folderName = "";
  }

  const bitDepthLabel = report.warnings.some((warning) => warning.code === "mixed-bit-depth")
    ? "mixed bit depth"
    : report.bitDepth
      ? formatBitDepth(report.bitDepth)
      : null;
  const summary = report.readableCount
    ? [
        `${report.readableCount} ${report.readableCount === 1 ? "stem" : "stems"}`,
        report.sampleRate ? formatSampleRate(report.sampleRate) : null,
        bitDepthLabel,
        formatClock(report.durationSeconds),
      ]
        .filter(Boolean)
        .join(" · ")
    : "No readable stems yet";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl">New project</h1>
          <p className="mt-2 text-sm text-muted">Drop stems exported from the same session. Originals are only read, then copied into the project folder.</p>
        </div>
        <Button title="Return to the start screen" onClick={goWelcome} disabled={Boolean(busy)}>
          Back
        </Button>
      </div>

      <TextField label="Project name" value={name} onChange={setName} />
      {folderName && folderName !== name.trim() ? <p className="text-sm text-muted">Folder name: {folderName}</p> : null}

      <div
        className={`rounded-lg border border-dashed px-6 py-10 text-center ${hover ? "border-accent bg-panel" : "border-line bg-panel"}`}
        onDragOver={(event) => {
          if (desktop) return;
          event.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(event) => {
          if (desktop) return;
          event.preventDefault();
          setHover(false);
          void addBrowserDrop(event.dataTransfer.files);
        }}
      >
        <p className="text-lg">Drop stems here</p>
        <p className="mt-1 text-sm text-muted">WAV and AIFF. Other formats are listed so you can see why they were skipped.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button
            title="Choose WAV or AIFF files"
            onClick={() => {
              void platform.pickAudioFiles().then((files) => {
                if (files) void addListed(files);
              });
            }}
            disabled={Boolean(busy)}
          >
            Add files
          </Button>
          {desktop ? (
            <Button
              title="Add every stem in a folder"
              onClick={() => {
                void platform.pickAudioFolder().then((files) => {
                  if (files) void addListed(files);
                });
              }}
              disabled={Boolean(busy)}
            >
              Add folder
            </Button>
          ) : (
            <Button title="Load the Night Drive demo stems" onClick={() => setStems(demoStems())} disabled={Boolean(busy)}>
              Use demo stems
            </Button>
          )}
        </div>
      </div>

      {busy ? <p className="text-sm text-accent">{busy}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {stems.length > 0 ? (
        <Panel>
          <div className="border-b border-line px-4 py-3 text-sm text-muted">{summary}</div>
          <ul>
            {stems.map((stem) => (
              <li key={stem.key} className="grid grid-cols-[minmax(0,1.4fr)_minmax(9rem,0.8fr)_auto] gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  {stem.inspection.ok ? (
                    <input
                      value={stem.name}
                      aria-label={`Name for ${stem.filename}`}
                      onChange={(event) => updateStem(stem.key, { name: event.target.value })}
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 hover:border-line focus:border-line"
                    />
                  ) : (
                    <p className="px-2 py-1 text-danger">{stem.filename}</p>
                  )}
                  <Truncated
                    text={`${stem.filename}${
                      stem.inspection.ok
                        ? ` · ${formatSampleRate(stem.inspection.sampleRate)} · ${channelLabel(stem.inspection.channelCount)} · ${formatBitDepth(stem.inspection.bitDepth)} · ${formatClock(stem.inspection.durationSeconds)}`
                        : ` · ${stem.inspection.message}`
                    }`}
                    className="px-2 text-xs text-faint"
                  />
                  {stem.inspection.ok && stem.role === "other" ? (
                    <input
                      value={stem.customLabel}
                      placeholder="Custom label"
                      aria-label={`Custom label for ${stem.filename}`}
                      onChange={(event) => updateStem(stem.key, { customLabel: event.target.value })}
                      className="mt-2 w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm"
                    />
                  ) : null}
                </div>
                <RoleSelect
                  value={stem.role}
                  aria-label={`Role for ${stem.filename}`}
                  disabled={!stem.inspection.ok}
                  onChange={(role) => updateStem(stem.key, { role })}
                />
                <Button title={`Remove ${stem.filename}`} className="self-start" onClick={() => setStems((current) => current.filter((item) => item.key !== stem.key))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {report.warnings.length > 0 ? (
        <ul className="space-y-1 text-sm text-danger">
          {report.warnings.map((warning, index) => (
            <li key={`${warning.code}-${warning.filename ?? index}`}>{warning.message}</li>
          ))}
        </ul>
      ) : stems.length > 0 ? (
        <p className="text-sm text-ok">Sample rates and lengths look consistent.</p>
      ) : null}

      <div className="flex justify-end">
        <Button title="Create the project from these stems" tone="accent" disabled={Boolean(busy) || report.readableCount === 0 || !folderName} onClick={() => void create()}>
          Create project
        </Button>
      </div>
    </div>
  );
}
