/**
 * Orbit — ambient lesson score.
 *
 * Generates a slowly-evolving background pad with the native Web Audio API
 * (no external service, no network call, works fully offline). It is NOT
 * "AI-generated music" in the generative-model sense — Groq has no audio
 * synthesis model and this environment has no reachable music-gen API — it
 * is a small procedural synth: a handful of detuned oscillators through a
 * lowpass filter, driven by a chord progression.
 *
 * Design goals tied to how OrbitSceneEngine already works:
 *   - The chord changes every time a new cinematic *shot* fires, so the
 *     music moves in lockstep with the camera direction layer instead of
 *     looping independently — the scene's beats become the score's beats.
 *   - The mood (root note + scale + brightness) is derived deterministically
 *     from data already present on every scene (environment.background hue,
 *     and the scene title/summary), so no backend or schema changes are
 *     needed to "just work" on lessons that already exist.
 *   - It ducks under narration automatically (SpeechSynthesis start/end),
 *     the way a podcast bed ducks under voice, so it supports the words
 *     rather than competing with them.
 *   - Everything is created lazily on first start() — AudioContext is only
 *     constructed inside a user-gesture-triggered play(), respecting
 *     browser autoplay policy.
 */

// Scales as semitone offsets from the root. Picked for "usable as an
// ambient bed" — no scale here produces a dissonant interval by accident.
const SCALES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],       // bright, curious — good for "intro / easy" energy
  major: [0, 2, 4, 5, 7, 9, 11],        // warm, clear — steady default
  dorian: [0, 2, 3, 5, 7, 9, 10],       // focused, a little more serious
  minorPent: [0, 3, 5, 7, 10],          // spacious, works well very sparse/slow
};

const ROOTS_HZ = {
  C: 130.81, D: 146.83, E: 164.81, F: 174.61,
  G: 196.0, A: 220.0, B: 246.94,
};

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function hexToHue(hex) {
  if (!hex || typeof hex !== "string") return 210; // default: cool cyan-blue
  const m = hex.replace("#", "");
  const r = parseInt(m.substring(0, 2), 16) / 255;
  const g = parseInt(m.substring(2, 4), 16) / 255;
  const b = parseInt(m.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  switch (max) {
    case r: h = ((g - b) / d) % 6; break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Pick a mood deterministically from scene data — same lesson always scores the same way. */
function moodFromScene(sceneData) {
  const hue = hexToHue(sceneData?.environment?.background);
  const seed = hashString((sceneData?.title || "") + "|" + (sceneData?.summary || ""));

  const rootNames = Object.keys(ROOTS_HZ);
  const root = ROOTS_HZ[rootNames[seed % rootNames.length]];

  let scaleName;
  if (hue < 40 || hue >= 320) scaleName = "dorian";      // warm/amber backgrounds — focused
  else if (hue < 150) scaleName = "major";                 // green range — clear/steady
  else if (hue < 250) scaleName = "lydian";                 // blue/cyan (Orbit's own palette) — bright/curious
  else scaleName = "minorPent";                             // violet range — spacious

  // Tempo of chord changes is driven by shots, not a clock, but we still
  // need a "brightness" (filter cutoff) and a base volume, scaled gently
  // by hue so darker/cooler scenes sit a bit further back in the mix.
  const brightness = 900 + (hue / 360) * 900; // 900–1800 Hz lowpass cutoff

  return { root, scale: SCALES[scaleName], brightness, seed };
}

export class AmbientScore {
  constructor(sceneData, opts = {}) {
    this.sceneData = sceneData;
    this.mood = moodFromScene(sceneData);
    this.enabled = opts.enabled !== false;
    this.baseVolume = opts.volume ?? 0.16; // deliberately subtle — this is a bed, not the point
    this.ctx = null;
    this.voices = [];       // active oscillator/gain pairs for the current chord
    this.masterGain = null;
    this.filter = null;
    this.chordIndex = -1;
    this._started = false;
    this._ducked = false;
  }

  // ------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------

  _ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // Web Audio unsupported — score silently no-ops everywhere
    this.ctx = new AC();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = this.mood.brightness;
    this.filter.Q.value = 0.7;

    this.filter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  start() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (!this._started) {
      this._started = true;
      this._playChord(0);
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(0, now);
      this.masterGain.gain.linearRampToValueAtTime(this._ducked ? this.baseVolume * 0.35 : this.baseVolume, now + 1.5);
    } else {
      this.ctx.resume();
    }
  }

  pause() {
    if (!this.ctx) return;
    this.ctx.suspend();
  }

  restart() {
    this.chordIndex = -1;
    this._started = false;
    this._stopVoices(0.05);
  }

  dispose() {
    if (!this.ctx) return;
    this._stopVoices(0.05);
    setTimeout(() => { try { this.ctx.close(); } catch (e) { /* already closed */ } }, 100);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      if (this.ctx) this.pause();
    } else if (this._started) {
      this._ensureContext();
      this.ctx && this.ctx.resume();
    }
  }

  setVolume(v) {
    this.baseVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.linearRampToValueAtTime(
        this._ducked ? this.baseVolume * 0.35 : this.baseVolume, now + 0.2
      );
    }
  }

  // ------------------------------------------------------------
  // Narration ducking — called from OrbitSceneEngine._speak()
  // ------------------------------------------------------------

  duck() {
    this._ducked = true;
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.linearRampToValueAtTime(this.baseVolume * 0.35, now + 0.4);
  }

  unduck() {
    this._ducked = false;
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.linearRampToValueAtTime(this.baseVolume, now + 0.8);
  }

  // ------------------------------------------------------------
  // Chord changes — called on every new cinematic shot
  // ------------------------------------------------------------

  nextChord() {
    if (!this.enabled || !this._started) return;
    this._playChord(this.chordIndex + 1);
  }

  _playChord(index) {
    if (!this.ctx) return;
    this.chordIndex = index;
    const { root, scale, seed } = this.mood;

    // Three-note chord: root, a scale-degree third-ish interval, and a
    // fifth-ish interval, walked slowly through the scale over time so
    // consecutive beats feel related but not static.
    const degreeBase = (index + seed) % scale.length;
    const degrees = [0, 2, 4].map((step) => scale[(degreeBase + step) % scale.length]);
    const freqs = degrees.map((semi) => root * Math.pow(2, semi / 12));

    this._stopVoices(1.2); // crossfade out the previous chord

    const now = this.ctx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.value = freq * (i === 0 ? 1 : 1); // keep in register; triangle gives upper voices more color

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.5 : 0.28, now + 1.4); // root voice sits louder

      osc.connect(gain);
      gain.connect(this.filter);
      osc.start(now);

      this.voices.push({ osc, gain });
    });
  }

  _stopVoices(fadeSeconds) {
    if (!this.ctx) { this.voices = []; return; }
    const now = this.ctx.currentTime;
    const dying = this.voices;
    this.voices = [];
    dying.forEach(({ osc, gain }) => {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
      osc.stop(now + fadeSeconds + 0.05);
    });
  }
}
