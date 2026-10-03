export { bufferSource, decodeExtended80, encodeExtended80, inspectAudioFile } from "./inspect";
export type { AudioInspection, ByteSource, PcmLayout } from "./inspect";
export {
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  WAVEFORM_LEVELS,
  WaveformCancelled,
  buildWaveformPeaks,
  chooseWaveformLevel,
  clampScroll,
  clampTimelineZoom,
  decodeWaveformPeaks,
  encodeWaveformPeaks,
  peaksMatchTrack,
  pixelsPerSecondFor,
  previewWaveformPeaks,
  rulerStepSeconds,
  timeToX,
  waveformCachePath,
  xToTime,
} from "./peaks";
export type { WaveformLevel, WaveformPeaks } from "./peaks";
