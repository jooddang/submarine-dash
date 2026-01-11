// Audio System
const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

export const initAudio = () => {
  if (!audioCtx && AudioContextClass) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      audioUnlocked = true;
    }).catch(err => {
      console.warn('Audio resume failed:', err);
    });
  } else if (audioCtx && audioCtx.state === 'running') {
    audioUnlocked = true;
  }
};

export type SoundType =
  | 'jump'
  | 'oxygen'
  | 'swordfish'
  | 'shell_crack'
  | 'die_fall'
  | 'die_urchin'
  | 'die_quicksand';

export const playSound = (type: SoundType) => {
  if (!audioCtx || !audioUnlocked) return;

  // Ensure audio context is running before playing
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  switch (type) {
    case 'jump':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.linearRampToValueAtTime(400, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
      break;

    case 'oxygen':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
      break;

    case 'swordfish':
      // Powerup sound - simple arpeggio
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(554, now + 0.1); // C#
      osc.frequency.setValueAtTime(659, now + 0.2); // E
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
      break;

    case 'shell_crack': {
      // A short "cracking" sound for turtle shell pickup: noise burst + pitch drop.
      // Uses a buffer source for noise plus a quick low sine thump underneath.
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(90, now + 0.08);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.09);

      try {
        const noiseLen = Math.floor(audioCtx.sampleRate * 0.06);
        const buffer = audioCtx.createBuffer(1, noiseLen, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < noiseLen; i++) {
          // Exponential decay noise burst
          const t = i / noiseLen;
          const decay = Math.exp(-t * 7);
          data[i] = (Math.random() * 2 - 1) * decay;
        }
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.11, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

        // Optional: lowpass to feel like a crack rather than hiss
        const lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1600, now);
        lp.frequency.exponentialRampToValueAtTime(700, now + 0.06);

        src.connect(lp);
        lp.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);

        src.start(now);
        src.stop(now + 0.06);
      } catch {
        // ignore if buffer source fails for any reason
      }
      break;
    }

    case 'die_urchin':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.linearRampToValueAtTime(50, now + 0.3);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
      break;

    case 'die_fall':
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.linearRampToValueAtTime(50, now + 0.5);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
      break;

    case 'die_quicksand':
      osc.type = 'square';
      osc.frequency.setValueAtTime(80, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.8);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.8);
      osc.start(now);
      osc.stop(now + 0.8);
      break;
  }
};
