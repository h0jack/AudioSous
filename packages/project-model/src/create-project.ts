import { assertSafeRelativePath } from "./paths";
import { defaultUiState, type MixVariant, type ProjectDocument, type Track, type TrackRole } from "./schema";

export interface NewTrackInput {
  id: string;
  name: string;
  role: TrackRole;
  customLabel?: string | null;
  relativePath: string;
  filename: string;
  metadata: Track["metadata"];
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  tracks: NewTrackInput[];
  now?: Date;
  originalVariantId?: string;
  workingVariantId?: string;
}

function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoApi?.randomUUID) {
    throw new Error("crypto.randomUUID is unavailable.");
  }
  return cryptoApi.randomUUID();
}

export function projectTiming(tracks: Array<{ metadata: Pick<Track["metadata"], "sampleRate" | "durationSeconds"> }>): {
  sampleRate: number;
  durationSeconds: number;
} {
  if (tracks.length === 0) {
    throw new Error("A project needs at least one readable stem.");
  }
  const counts = new Map<number, number>();
  let durationSeconds = 0;
  for (const track of tracks) {
    counts.set(track.metadata.sampleRate, (counts.get(track.metadata.sampleRate) ?? 0) + 1);
    durationSeconds = Math.max(durationSeconds, track.metadata.durationSeconds);
  }
  let sampleRate = tracks[0]?.metadata.sampleRate ?? 48_000;
  let bestCount = -1;
  for (const [rate, count] of counts) {
    if (count > bestCount || (count === bestCount && rate > sampleRate)) {
      sampleRate = rate;
      bestCount = count;
    }
  }
  return { sampleRate, durationSeconds };
}

export function createProject(input: CreateProjectInput): ProjectDocument {
  const now = (input.now ?? new Date()).toISOString();
  const projectId = input.id ?? randomId();
  const timing = projectTiming(input.tracks);
  const originalId = input.originalVariantId ?? "variant-original";
  const workingId = input.workingVariantId ?? "variant-working";
  const variants: MixVariant[] = [
    {
      id: originalId,
      name: "Original",
      description: "The imported stems, without Audiosous processing.",
      createdAt: now,
      kind: "original",
    },
    {
      id: workingId,
      name: "Working Mix",
      description: "The mix you are auditioning.",
      createdAt: now,
      kind: "working",
    },
  ];

  const tracks: Track[] = input.tracks.map((track) => {
    assertSafeRelativePath(track.relativePath);
    return {
      id: track.id,
      name: track.name.trim(),
      role: track.role,
      customLabel: track.customLabel?.trim() || null,
      file: {
        relativePath: track.relativePath,
        filename: track.filename,
      },
      metadata: track.metadata,
      gainDb: 0,
      pan: 0,
      muted: false,
      solo: false,
    };
  });

  return {
    schemaVersion: 1,
    project: {
      id: projectId,
      name: input.name.trim(),
      createdAt: now,
      updatedAt: now,
      sampleRate: timing.sampleRate,
      durationSeconds: timing.durationSeconds,
    },
    tracks,
    sections: [],
    sectionTrackSettings: [],
    mixVariants: variants,
    activeMixVariantId: workingId,
    comparison: {
      scope: "entire-mix",
      aVariantId: originalId,
      bVariantId: workingId,
      trackId: null,
    },
    uiState: defaultUiState(),
  };
}

export function withUpdatedAt(document: ProjectDocument, now = new Date()): ProjectDocument {
  return {
    ...document,
    project: {
      ...document.project,
      updatedAt: now.toISOString(),
    },
  };
}

export function updateTrack(
  document: ProjectDocument,
  trackId: string,
  patch: Partial<Pick<Track, "name" | "role" | "customLabel">>,
): ProjectDocument {
  return {
    ...document,
    tracks: document.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)),
  };
}
