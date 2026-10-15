function writeString(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 16-bit PCM WAV. Channels are interleaved. Samples outside ±1 are clipped. */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const blockAlign = channelCount * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const rate = Math.max(1, Math.round(sampleRate));

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = channels[c]?.[i] ?? 0;
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      const integer = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(offset, integer < -32768 ? -32768 : integer, true);
      offset += 2;
    }
  }
  return buffer;
}

/** `歌曲名-432Hz.wav`, with characters filesystems reject removed. */
export function downloadFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return `${cleaned || "歌曲"}-432Hz.wav`;
}
