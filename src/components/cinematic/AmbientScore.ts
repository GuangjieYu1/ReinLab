export type AudioStatus = 'off' | 'loading' | 'playing' | 'suspended' | 'unavailable';

// Original generative score. No sampled music, remote audio, microphone, or file access.
export class AmbientScore {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private renderTask: Promise<AudioBuffer> | null = null;
  private disposed = false;
  private enabled = true;
  private visible = true;
  private volume = .24;
  private revision = 0;
  constructor(private publish: (status: AudioStatus) => void) {}

  async start() {
    if (this.disposed || !this.enabled || !this.visible) return;
    const revision = ++this.revision;
    try {
      if (!this.context) {
        this.context = new AudioContext({ latencyHint: 'playback' });
        this.master = this.context.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.context.destination);
      }
      // Called from the login gesture before awaiting asynchronous composition.
      await this.context.resume();
      this.publish(this.source ? 'playing' : 'loading');
      this.renderTask ??= renderScore();
      const buffer = await this.renderTask;
      if (this.disposed || revision !== this.revision || !this.enabled || !this.visible) return;
      if (!this.source) {
        const source = this.context.createBufferSource();
        source.buffer = buffer; source.loop = true;
        source.connect(this.master!); source.start();
        this.source = source;
      }
      this.master!.gain.setTargetAtTime(this.volume, this.context.currentTime, .8);
      this.publish(this.context.state === 'running' ? 'playing' : 'suspended');
    } catch { if (!this.disposed) this.publish('unavailable'); }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) void this.start();
    else {
      this.revision++;
      if (this.context && this.master) this.master.gain.setTargetAtTime(0, this.context.currentTime, .12);
      this.publish('off');
    }
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.enabled) void this.start();
    else {
      this.revision++;
      if (this.context && this.master) this.master.gain.setTargetAtTime(0, this.context.currentTime, .15);
      this.publish(this.enabled ? 'suspended' : 'off');
    }
  }
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(.6, volume));
    if (this.enabled && this.visible && this.context && this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, .15);
  }
  dispose() {
    this.disposed = true; this.revision++;
    this.source?.stop(); this.source?.disconnect();
    void this.context?.close();
  }
}

const note = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
export const SCORE_SECONDS = 48;
export const SCORE_CHORDS = [
  [50, 57, 60, 64], [48, 55, 59, 62], [46, 53, 57, 60],
  [53, 60, 64, 67], [43, 50, 57, 58], [45, 52, 55, 59],
] as const;

async function renderScore(): Promise<AudioBuffer> {
  const sampleRate = 32000;
  const context = new OfflineAudioContext(2, SCORE_SECONDS * sampleRate, sampleRate);
  const master = context.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(.65, 2.5);
  master.gain.setValueAtTime(.65, SCORE_SECONDS - 2.8);
  master.gain.linearRampToValueAtTime(0, SCORE_SECONDS);
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -12; limiter.knee.value = 16; limiter.ratio.value = 4;
  master.connect(limiter); limiter.connect(context.destination);
  const dry = context.createGain(); dry.gain.value = .8; dry.connect(master);
  const reverb = context.createConvolver();
  const impulse = context.createBuffer(2, sampleRate * 3, sampleRate);
  let seed = 73197;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let c = 0; c < 2; c++) {
    const channel = impulse.getChannelData(c);
    for (let i = 0; i < channel.length; i++) channel[i] = (random() * 2 - 1) * (1 - i / channel.length) ** 3;
  }
  reverb.buffer = impulse;
  const wet = context.createGain(); wet.gain.value = .32; reverb.connect(wet); wet.connect(master);
  const send = (node: AudioNode) => { node.connect(dry); node.connect(reverb); };

  SCORE_CHORDS.forEach((chord, chordIndex) => {
    const at = chordIndex * 8;
    chord.forEach((midi, voice) => {
      const pan = context.createStereoPanner(); pan.pan.value = (voice - 1.5) * .2;
      const tone = context.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 1450;
      tone.connect(pan); send(pan);
      [-3.5, 3.5].forEach(detune => {
        const oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = note(midi); oscillator.detune.value = detune;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(voice === 0 ? .11 : .058, at + 2.2);
        gain.gain.setValueAtTime(voice === 0 ? .095 : .048, at + 6);
        gain.gain.linearRampToValueAtTime(0, Math.min(at + 10.5, SCORE_SECONDS));
        oscillator.connect(gain); gain.connect(tone);
        oscillator.start(at); oscillator.stop(Math.min(at + 10.6, SCORE_SECONDS));
      });
    });
    // Sparse glass notes, rather than a rhythmic loop competing with reading.
    [0, 1].forEach(hit => {
      const atNote = at + 2.4 + hit * 3.7;
      const pitch = chord[(chordIndex + hit + 1) % chord.length] + 24;
      [1, 2.01, 3.99].forEach((partial, i) => {
        const oscillator = context.createOscillator(), gain = context.createGain(), pan = context.createStereoPanner();
        oscillator.frequency.value = note(pitch) * partial;
        pan.pan.value = hit ? .4 : -.35;
        gain.gain.setValueAtTime(0, atNote);
        gain.gain.linearRampToValueAtTime([.065, .009, .0015][i], atNote + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, Math.min(atNote + 4.2, SCORE_SECONDS));
        oscillator.connect(gain); gain.connect(pan); send(pan);
        oscillator.start(atNote); oscillator.stop(Math.min(atNote + 4.3, SCORE_SECONDS));
      });
    });
  });
  return context.startRendering();
}
