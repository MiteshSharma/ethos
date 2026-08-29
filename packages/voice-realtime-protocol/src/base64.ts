// Base64 <-> PCM16. Both realtime providers carry audio as base64 inside JSON
// frames, in both directions, so this is the one place the encoding happens.
//
// `atob` / `btoa` rather than `Buffer`: this module runs in the browser as well
// as in node (the browser talks to the provider directly on the realtime tier),
// and a `node:buffer` import here would be a node builtin in the SPA bundle.
// Both globals have been in node since v16 and in every browser far longer.

/** Chunked so a long frame cannot blow the argument limit of `String.fromCharCode`. */
const CHUNK = 0x8000;

export function pcmToBase64(pcm: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < pcm.length; offset += CHUNK) {
    binary += String.fromCharCode(...pcm.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToPcm(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
