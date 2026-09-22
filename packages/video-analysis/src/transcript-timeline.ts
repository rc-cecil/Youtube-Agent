export type AudioChunk = {
  index: number;
  coreStart: number;
  coreEnd: number;
  start: number;
  end: number;
  overlapBefore: number;
};

export function planAudioChunks(
  duration: number,
  chunkSeconds: number,
  overlapSeconds = 1,
): AudioChunk[] {
  if (!Number.isFinite(duration) || duration <= 0 || chunkSeconds <= overlapSeconds * 2)
    throw new Error('Invalid audio chunk duration');
  const chunks: AudioChunk[] = [];
  for (let coreStart = 0, index = 0; coreStart < duration; coreStart += chunkSeconds, index++) {
    const coreEnd = Math.min(duration, coreStart + chunkSeconds);
    const start = Math.max(0, coreStart - overlapSeconds);
    chunks.push({
      index,
      coreStart,
      coreEnd,
      start,
      end: Math.min(duration, coreEnd + overlapSeconds),
      overlapBefore: coreStart - start,
    });
  }
  return chunks;
}

export function mapChunkWords(
  chunk: AudioChunk,
  words: Array<{ start: number; end: number; text: string }>,
) {
  return words
    .filter((word) => {
      const midpoint = chunk.start + (word.start + word.end) / 2;
      return midpoint >= chunk.coreStart && midpoint < chunk.coreEnd;
    })
    .map((word) => ({
      startTime: Math.max(chunk.coreStart, chunk.start + word.start),
      endTime: Math.min(chunk.coreEnd, chunk.start + word.end),
      text: word.text.trim(),
    }))
    .filter((word) => word.text && word.endTime > word.startTime);
}
