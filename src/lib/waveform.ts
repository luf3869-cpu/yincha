/** Peak envelope for the seek bar. Strided so long songs stay cheap. */
export function waveformPeaks(samples: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets);
  if (samples.length === 0 || buckets <= 0) return peaks;
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const stride = size > 400 ? 4 : 1;
  for (let i = 0; i < buckets; i++) {
    const start = i * size;
    const end = i === buckets - 1 ? samples.length : Math.min(samples.length, start + size);
    let peak = 0;
    for (let j = start; j < end; j += stride) {
      const value = Math.abs(samples[j]);
      if (value > peak) peak = value;
    }
    peaks[i] = peak;
  }
  return peaks;
}

export function mixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const mixed = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mixed[i] += data[i];
  }
  if (channels > 1) {
    const scale = 1 / channels;
    for (let i = 0; i < length; i++) mixed[i] *= scale;
  }
  return mixed;
}

export function copyChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
    const data = buffer.getChannelData(channel);
    return Float32Array.from(data);
  });
}
