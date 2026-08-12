// Base64 <-> PCM16 helpers. Both realtime providers carry audio as base64
// inside JSON frames, in both directions, so this is the one place the encoding
// happens.

export function pcmToBase64(pcm: Uint8Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

export function base64ToPcm(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}
