/**
 * SoundEngine — Synthétiseur Audio 100% Web Audio API pour Salle de CrossFit
 * Aucun fichier audio externe requis : zéro latence sur Smart TV.
 *
 * Spécifications sonores :
 * - Décompte 3, 2, 1 : Bips courts et graves (440 Hz)
 * - Départ "GO!"     : Bip long et aigu (880 Hz)
 * - Changement EMOM / Round Work-Rest : Double tonalité distincte
 * - Fin du temps / Time Cap : Salve de 3 bips longs haute puissance (Buzzer final)
 */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.85; // 0.0 -> 1.0
  }

  /**
   * Initialise ou réveille le contexte Web Audio (nécessite une interaction utilisateur initiale)
   */
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, Number(val)));
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
  }

  /**
   * Joue un oscillateur synthétique avec enveloppe ADSR propre (sans clic parasite)
   * et harmonique légère pour percer le bruit ambiant d'une salle de sport.
   */
  playTone({
    freq = 440,
    duration = 0.18,
    type = 'triangle',
    harmonicType = 'sawtooth',
    harmonicGain = 0.22,
    delay = 0
  }) {
    if (this.muted || this.volume <= 0) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime + delay;
    const masterGain = this.ctx.createGain();
    const peakGain = Math.max(0.001, this.volume * 0.9);

    // Enveloppe anti-pop : attaque 8ms, maintien franc, relâchement 25ms
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
    masterGain.gain.setValueAtTime(peakGain, Math.max(now + 0.01, now + duration - 0.025));
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    masterGain.connect(this.ctx.destination);

    // Oscillateur fondamental
    const oscMain = this.ctx.createOscillator();
    oscMain.type = type;
    oscMain.frequency.setValueAtTime(freq, now);
    oscMain.connect(masterGain);

    // Oscillateur harmonique subtil pour donner le timbre "Chrono LED de compétition"
    const harmGainNode = this.ctx.createGain();
    harmGainNode.gain.setValueAtTime(harmonicGain, now);
    harmGainNode.connect(masterGain);

    const oscHarm = this.ctx.createOscillator();
    oscHarm.type = harmonicType;
    oscHarm.frequency.setValueAtTime(freq, now);
    oscHarm.connect(harmGainNode);

    oscMain.start(now);
    oscHarm.start(now);
    oscMain.stop(now + duration + 0.01);
    oscHarm.stop(now + duration + 0.01);
  }

  /**
   * Bip court et grave (440 Hz) pour les 3 dernières secondes (3, 2, 1)
   */
  beepCountdown() {
    this.playTone({
      freq: 440,
      duration: 0.18,
      type: 'triangle',
      harmonicType: 'square',
      harmonicGain: 0.2
    });
  }

  /**
   * Bip long et aigu (880 Hz) pour le départ ("GO!")
   */
  beepGo() {
    this.playTone({
      freq: 880,
      duration: 0.68,
      type: 'triangle',
      harmonicType: 'sawtooth',
      harmonicGain: 0.3
    });
  }

  /**
   * Signal sonore de changement d'intervalle EMOM ou passage au WORK
   */
  beepIntervalWork() {
    this.playTone({
      freq: 587.33, // D5
      duration: 0.14,
      type: 'triangle',
      harmonicType: 'sawtooth',
      harmonicGain: 0.25,
      delay: 0
    });
    this.playTone({
      freq: 880, // A5
      duration: 0.48,
      type: 'triangle',
      harmonicType: 'sawtooth',
      harmonicGain: 0.3,
      delay: 0.16
    });
  }

  /**
   * Signal sonore de passage en REST (Pause)
   */
  beepIntervalRest() {
    this.playTone({
      freq: 659.25, // E5
      duration: 0.16,
      type: 'triangle',
      harmonicType: 'square',
      harmonicGain: 0.22,
      delay: 0
    });
    this.playTone({
      freq: 440, // A4
      duration: 0.38,
      type: 'triangle',
      harmonicType: 'square',
      harmonicGain: 0.22,
      delay: 0.18
    });
  }

  /**
   * Bip sonore distinct et puissant pour marquer la fin du temps ou du Time Cap (3 bips longs)
   */
  beepFinish() {
    const pulses = [0, 0.32, 0.64];
    pulses.forEach((offset, idx) => {
      this.playTone({
        freq: idx === 2 ? 1046.5 : 987.77, // B5 -> B5 -> C6
        duration: idx === 2 ? 0.65 : 0.24,
        type: 'sawtooth',
        harmonicType: 'square',
        harmonicGain: 0.35,
        delay: offset
      });
    });
  }
}

window.SoundEngine = SoundEngine;
