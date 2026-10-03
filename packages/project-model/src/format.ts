export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secText = secs.toString().padStart(2, "0");
  const msText = ms.toString().padStart(3, "0");
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secText}.${msText}`;
  }
  return `${minutes}:${secText}.${msText}`;
}

export function formatSampleRate(sampleRate: number): string {
  if (sampleRate % 100 === 0) {
    const khz = sampleRate / 1000;
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }
  return `${sampleRate} Hz`;
}

export function formatBitDepth(bitDepth: number | null): string {
  return bitDepth === null ? "unknown bit depth" : `${bitDepth}-bit`;
}

export function channelLabel(channelCount: number): string {
  if (channelCount === 1) return "Mono";
  if (channelCount === 2) return "Stereo";
  return `${channelCount} ch`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
