/**
 * The "got it, thinking" earcon: a subtle two-note blip played the instant an
 * utterance endpoints, covering the transcribe → LLM → first-audio gap. Kept
 * quiet on purpose so it cannot trip the VAD or barge-in against itself.
 *
 * Shared by both talk-mode drivers (batch `<audio>` and streaming WebAudio) so
 * the acknowledgement sounds identical whichever transport is in use.
 */
export function playThinkingEarcon(ctx: AudioContext): void {
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const NOTE_S = 0.12; // ~120ms per note
    const PEAK = 0.15; // low peak so it won't self-trip the VAD / barge-in
    const notes = [880, 1175]; // ascending "ting ting"
    notes.forEach((freq, i) => {
      const startAt = ctx.currentTime + i * NOTE_S;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Quick attack, linear decay to silence — a clean, subtle blip.
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(PEAK, startAt + 0.01);
      gain.gain.linearRampToValueAtTime(0, startAt + NOTE_S);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + NOTE_S);
    });
  } catch {
    // Web Audio unavailable / blocked — the earcon is best-effort.
  }
}
