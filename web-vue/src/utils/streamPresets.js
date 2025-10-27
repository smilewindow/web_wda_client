export const STREAM_PRESETS = ['1080p', '720p', '480p', '360p'];
export const DEFAULT_STREAM_PRESET = '720p';

export function normalizeStreamPreset(value) {
  const preset = String(value || '').trim();
  return STREAM_PRESETS.includes(preset) ? preset : DEFAULT_STREAM_PRESET;
}
