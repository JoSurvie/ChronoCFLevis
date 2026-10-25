/**
 * CrossfitTimer — Moteur de chronométrage haute précision basé sur performance.now()
 *
 * Modes pris en charge :
 * 1. FOR_TIME  : Count UP ou Count DOWN avec Time Cap personnalisable
 * 2. EMOM      : Every X Min/Sec On the Minute (E1MOM, E2MOM, E3MOM, etc.) avec signal à chaque intervalle
 * 3. INTERVALS : Mode AMRAP / Intervalles / Rounds (Temps Work, Temps Rest, Nombre de Rounds)
 *
 * Intègre systématiquement le décompte initial obligatoire de 10 secondes ("10, 9, 8... GO!")
 */
class CrossfitTimer {
  constructor({ soundEngine, onTick, onPhaseChange, onComplete }) {
    this.sound = soundEngine;
    this.onTick = onTick || (() => {});
    this.onPhaseChange = onPhaseChange || (() => {});
    this.onComplete = onComplete || (() => {});

    this.mode = 'FOR_TIME'; // 'FOR_TIME' | 'EMOM' | 'INTERVALS'
    this.status = 'IDLE'; // 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED'
    this.phase = 'READY'; // 'READY' | 'COUNTDOWN' | 'WORK' | 'REST' | 'DONE'

    this.config = {
      countdownSeconds: 10, // Décompte initial obligatoire de 10s
      // FOR_TIME
      direction: 'UP', // 'UP' | 'DOWN'
      timeCapSeconds: 900, // 15:00
      // EMOM
      emomIntervalSeconds: 60, // 1 min (E1MOM), 120s (E2MOM), 180s (E3MOM)...
      emomRounds: 10,
      // INTERVALS / AMRAP / ROUNDS
      workSeconds: 240, // ex: 4:00 ou 40s
      restSeconds: 60, // ex: 1:00 ou 20s (0s = AMRAP pur)
      intervalRounds: 4
    };

    // État interne de mesure du temps
    this.rafId = null;
    this.startTimestamp = 0;
    this.accumulatedMs = 0;
    this.lastBeepKey = null;
    this.lastAnnouncedPhaseKey = null;
    this.goBannerUntil = 0;
  }

  configure(newConfig = {}) {
    if (newConfig.mode) {
      this.mode = newConfig.mode;
    }
    this.config = {
      ...this.config,
      ...newConfig,
      countdownSeconds:
        typeof newConfig.countdownSeconds === 'number'
          ? Math.max(0, newConfig.countdownSeconds)
          : 10
    };
    this.reset();
  }

  setMode(mode) {
    if (['FOR_TIME', 'EMOM', 'INTERVALS'].includes(mode)) {
      this.mode = mode;
      this.reset();
    }
  }

  start() {
    if (this.status === 'RUNNING') return;
    if (this.status === 'COMPLETED') {
      this.reset();
    }

    if (this.sound) {
      this.sound.init();
    }

    this.status = 'RUNNING';
    this.startTimestamp = performance.now();
    this.tick();
  }

  pause() {
    if (this.status !== 'RUNNING') return;
    this.accumulatedMs += performance.now() - this.startTimestamp;
    this.status = 'PAUSED';
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.emitState();
  }

  toggle() {
    if (this.status === 'RUNNING') {
      this.pause();
    } else {
      this.start();
    }
  }

  reset() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.status = 'IDLE';
    this.phase = 'READY';
    this.accumulatedMs = 0;
    this.startTimestamp = 0;
    this.lastBeepKey = null;
    this.lastAnnouncedPhaseKey = null;
    this.goBannerUntil = 0;
    this.emitState();
  }

  getElapsedMs() {
    if (this.status === 'RUNNING') {
      return this.accumulatedMs + (performance.now() - this.startTimestamp);
    }
    return this.accumulatedMs;
  }

  getTotalWorkoutMs() {
    if (this.mode === 'FOR_TIME') {
      return Math.max(1, this.config.timeCapSeconds) * 1000;
    }
    if (this.mode === 'EMOM') {
      return Math.max(1, this.config.emomIntervalSeconds * this.config.emomRounds) * 1000;
    }
    // INTERVALS / AMRAP / ROUNDS
    const rounds = Math.max(1, this.config.intervalRounds);
    const work = Math.max(1, this.config.workSeconds);
    const rest = Math.max(0, this.config.restSeconds);
    // Pas de pause après le tout dernier round de travail
    return (rounds * work + Math.max(0, rounds - 1) * rest) * 1000;
  }

  triggerBeepOnce(key, fn) {
    if (this.lastBeepKey === key) return;
    this.lastBeepKey = key;
    if (this.sound && typeof fn === 'function') {
      fn();
    }
  }

  tick() {
    if (this.status !== 'RUNNING') return;
    this.emitState();
    if (this.status === 'RUNNING') {
      this.rafId = requestAnimationFrame(() => this.tick());
    }
  }

  computeState() {
    const rawElapsedMs = this.getElapsedMs();
    const countdownMs = this.config.countdownSeconds * 1000;
    const totalWorkoutMs = this.getTotalWorkoutMs();

    // État IDLE avant démarrage : afficher un aperçu clair du mode configuré
    if (this.status === 'IDLE') {
      return this.buildIdleState(totalWorkoutMs);
    }

    // 1. PHASE DE DÉCOMPTE INITIAL OBLIGATOIRE (10, 9, 8... 3, 2, 1, GO!)
    if (rawElapsedMs < countdownMs) {
      const remainingCountdownMs = countdownMs - rawElapsedMs;
      const remainingSec = Math.ceil(remainingCountdownMs / 1000);

      // Bips courts 440 Hz sur 3, 2, 1
      if (this.status === 'RUNNING' && remainingSec <= 3 && remainingSec >= 1) {
        this.triggerBeepOnce(`cd-${remainingSec}`, () => this.sound.beepCountdown());
      }

      this.notifyPhaseIfNeeded('COUNTDOWN', 1, 1);

      return {
        status: this.status,
        mode: this.mode,
        phase: 'COUNTDOWN',
        phaseLabel: 'PRÉPARATION — DÉPART DANS',
        displayMain: String(remainingSec).padStart(2, '0'),
        displaySub: 'TENEZ-VOUS PRÊT !',
        showGoBanner: false,
        currentRound: 1,
        totalRounds: this.getConfiguredTotalRounds(),
        progressPercent: ((countdownMs - remainingCountdownMs) / countdownMs) * 100,
        totalElapsedSeconds: 0,
        totalRemainingSeconds: Math.ceil(totalWorkoutMs / 1000)
      };
    }

    // Temps écoulé depuis le "GO!"
    const workoutElapsedMs = rawElapsedMs - countdownMs;

    // Au franchissement exact de 00:00 après le décompte : Bip long 880 Hz + bannière "GO!"
    if (this.status === 'RUNNING' && workoutElapsedMs < 1100) {
      this.triggerBeepOnce('workout-go', () => {
        this.goBannerUntil = performance.now() + 1350;
        this.sound.beepGo();
      });
    }

    const showGoBanner = performance.now() < this.goBannerUntil;

    // 2. VÉRIFICATION DE LA FIN DU WORKOUT / TIME CAP
    if (workoutElapsedMs >= totalWorkoutMs) {
      if (this.status === 'RUNNING') {
        this.accumulatedMs = countdownMs + totalWorkoutMs;
        this.status = 'COMPLETED';
        this.phase = 'DONE';
        if (this.rafId) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        this.triggerBeepOnce('workout-finish', () => this.sound.beepFinish());
        this.notifyPhaseIfNeeded('DONE', this.getConfiguredTotalRounds(), this.getConfiguredTotalRounds());
        this.onComplete();
      }

      const finalDisplay =
        this.mode === 'FOR_TIME' && this.config.direction === 'UP'
          ? CrossfitTimer.formatMMSS(Math.round(totalWorkoutMs / 1000))
          : '00:00';

      return {
        status: 'COMPLETED',
        mode: this.mode,
        phase: 'DONE',
        phaseLabel: 'TIME CAP / TERMINÉ !',
        displayMain: finalDisplay,
        displaySub: 'WORKOUT TERMINÉ — BRAVO !',
        showGoBanner: false,
        currentRound: this.getConfiguredTotalRounds(),
        totalRounds: this.getConfiguredTotalRounds(),
        progressPercent: 100,
        totalElapsedSeconds: Math.round(totalWorkoutMs / 1000),
        totalRemainingSeconds: 0
      };
    }

    // 3. CALCUL SELON LE MODE ACTIF
    if (this.mode === 'FOR_TIME') {
      return this.computeForTimeState(workoutElapsedMs, totalWorkoutMs, showGoBanner);
    }
    if (this.mode === 'EMOM') {
      return this.computeEmomState(workoutElapsedMs, totalWorkoutMs, showGoBanner);
    }
    return this.computeIntervalsState(workoutElapsedMs, totalWorkoutMs, showGoBanner);
  }

  computeForTimeState(workoutElapsedMs, totalWorkoutMs, showGoBanner) {
    const remainingMs = Math.max(0, totalWorkoutMs - workoutElapsedMs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const elapsedSec = Math.floor(workoutElapsedMs / 1000);

    // Bips d'avertissement sur les 3 dernières secondes avant le Time Cap
    if (this.status === 'RUNNING' && remainingSec <= 3 && remainingSec >= 1) {
      this.triggerBeepOnce(`ft-end-${remainingSec}`, () => this.sound.beepCountdown());
    }

    this.notifyPhaseIfNeeded('WORK', 1, 1);

    const primarySeconds = this.config.direction === 'UP' ? elapsedSec : remainingSec;
    const secondarySeconds = this.config.direction === 'UP' ? remainingSec : elapsedSec;
    const secondaryLabel =
      this.config.direction === 'UP'
        ? `RESTE ${CrossfitTimer.formatMMSS(secondarySeconds)} (CAP ${CrossfitTimer.formatMMSS(this.config.timeCapSeconds)})`
        : `ÉCOULÉ ${CrossfitTimer.formatMMSS(secondarySeconds)} (CAP ${CrossfitTimer.formatMMSS(this.config.timeCapSeconds)})`;

    return {
      status: this.status,
      mode: 'FOR_TIME',
      phase: 'WORK',
      phaseLabel:
        this.config.direction === 'UP' ? 'FOR TIME — COUNT UP' : 'FOR TIME — COUNT DOWN',
      displayMain: showGoBanner ? 'GO!' : CrossfitTimer.formatMMSS(primarySeconds),
      displaySub: secondaryLabel,
      showGoBanner,
      currentRound: 1,
      totalRounds: 1,
      progressPercent: (workoutElapsedMs / totalWorkoutMs) * 100,
      totalElapsedSeconds: elapsedSec,
      totalRemainingSeconds: remainingSec
    };
  }

  computeEmomState(workoutElapsedMs, totalWorkoutMs, showGoBanner) {
    const intervalMs = Math.max(1000, this.config.emomIntervalSeconds * 1000);
    const totalRounds = Math.max(1, this.config.emomRounds);
    const currentRound = Math.min(totalRounds, Math.floor(workoutElapsedMs / intervalMs) + 1);
    const elapsedInIntervalMs = workoutElapsedMs % intervalMs;
    const remainingInIntervalMs = intervalMs - elapsedInIntervalMs;
    const remainingInIntervalSec = Math.ceil(remainingInIntervalMs / 1000);

    // Bips 3, 2, 1 à la fin de chaque minute/intervalle EMOM
    if (this.status === 'RUNNING' && remainingInIntervalSec <= 3 && remainingInIntervalSec >= 1) {
      this.triggerBeepOnce(
        `emom-r${currentRound}-cd-${remainingInIntervalSec}`,
        () => this.sound.beepCountdown()
      );
    }

    // Au changement d'intervalle (Rounds 2..N) : Signal sonore et visuel automatique
    if (this.status === 'RUNNING' && currentRound > 1 && elapsedInIntervalMs < 900) {
      this.triggerBeepOnce(`emom-start-r${currentRound}`, () => {
        this.goBannerUntil = performance.now() + 950;
        this.sound.beepIntervalWork();
      });
    }

    this.notifyPhaseIfNeeded(`EMOM_R${currentRound}`, currentRound, totalRounds);

    const totalRemainingSec = Math.ceil((totalWorkoutMs - workoutElapsedMs) / 1000);
    const everyLabel =
      this.config.emomIntervalSeconds % 60 === 0
        ? `E${this.config.emomIntervalSeconds / 60 === 1 ? '' : this.config.emomIntervalSeconds / 60}MOM`
        : `EVERY ${this.config.emomIntervalSeconds}S`;

    return {
      status: this.status,
      mode: 'EMOM',
      phase: 'WORK',
      phaseLabel: `${everyLabel} — INTERVALLE ${currentRound} / ${totalRounds}`,
      displayMain:
        performance.now() < this.goBannerUntil
          ? 'GO!'
          : CrossfitTimer.formatMMSS(remainingInIntervalSec),
      displaySub: `TEMPS TOTAL RESTANT : ${CrossfitTimer.formatMMSS(totalRemainingSec)}`,
      showGoBanner: performance.now() < this.goBannerUntil,
      currentRound,
      totalRounds,
      progressPercent: ((intervalMs - remainingInIntervalMs) / intervalMs) * 100,
      totalElapsedSeconds: Math.floor(workoutElapsedMs / 1000),
      totalRemainingSeconds: totalRemainingSec
    };
  }

  computeIntervalsState(workoutElapsedMs, totalWorkoutMs, showGoBanner) {
    const workMs = Math.max(1000, this.config.workSeconds * 1000);
    const restMs = Math.max(0, this.config.restSeconds * 1000);
    const cycleMs = workMs + restMs;
    const totalRounds = Math.max(1, this.config.intervalRounds);

    const currentRound = Math.min(totalRounds, Math.floor(workoutElapsedMs / cycleMs) + 1);
    const elapsedInCycleMs = workoutElapsedMs - (currentRound - 1) * cycleMs;

    const isWorkPhase = restMs === 0 || elapsedInCycleMs < workMs;
    const currentPhase = isWorkPhase ? 'WORK' : 'REST';

    const phaseDurationMs = isWorkPhase ? workMs : restMs;
    const elapsedInPhaseMs = isWorkPhase ? elapsedInCycleMs : elapsedInCycleMs - workMs;
    const remainingInPhaseMs = Math.max(0, phaseDurationMs - elapsedInPhaseMs);
    const remainingInPhaseSec = Math.ceil(remainingInPhaseMs / 1000);

    // Bips 3, 2, 1 avant chaque changement Work <-> Rest
    if (this.status === 'RUNNING' && remainingInPhaseSec <= 3 && remainingInPhaseSec >= 1) {
      this.triggerBeepOnce(
        `int-r${currentRound}-${currentPhase}-cd-${remainingInPhaseSec}`,
        () => this.sound.beepCountdown()
      );
    }

    // Signal sonore lors des transitions vers REST ou vers un nouveau round WORK
    if (this.status === 'RUNNING' && elapsedInPhaseMs < 900) {
      if (currentPhase === 'REST') {
        this.triggerBeepOnce(`int-r${currentRound}-rest`, () => this.sound.beepIntervalRest());
      } else if (currentRound > 1) {
        this.triggerBeepOnce(`int-r${currentRound}-work`, () => {
          this.goBannerUntil = performance.now() + 950;
          this.sound.beepIntervalWork();
        });
      }
    }

    this.notifyPhaseIfNeeded(`${currentPhase}_R${currentRound}`, currentRound, totalRounds);

    const totalRemainingSec = Math.ceil((totalWorkoutMs - workoutElapsedMs) / 1000);
    const isAmrapSimple = totalRounds === 1 && restMs === 0;
    const phaseLabel = isAmrapSimple
      ? `AMRAP ${CrossfitTimer.formatMMSS(this.config.workSeconds)}`
      : currentPhase === 'WORK'
      ? `WORK — ROUND ${currentRound} / ${totalRounds}`
      : `REST (PAUSE) — ROUND ${currentRound} / ${totalRounds}`;

    return {
      status: this.status,
      mode: 'INTERVALS',
      phase: currentPhase,
      phaseLabel,
      displayMain:
        performance.now() < this.goBannerUntil
          ? 'GO!'
          : CrossfitTimer.formatMMSS(remainingInPhaseSec),
      displaySub: isAmrapSimple
        ? `ÉCOULÉ : ${CrossfitTimer.formatMMSS(Math.floor(workoutElapsedMs / 1000))}`
        : `TOTAL RESTANT : ${CrossfitTimer.formatMMSS(totalRemainingSec)}`,
      showGoBanner: performance.now() < this.goBannerUntil,
      currentRound,
      totalRounds,
      progressPercent: ((phaseDurationMs - remainingInPhaseMs) / phaseDurationMs) * 100,
      totalElapsedSeconds: Math.floor(workoutElapsedMs / 1000),
      totalRemainingSeconds: totalRemainingSec
    };
  }

  buildIdleState(totalWorkoutMs) {
    const totalRounds = this.getConfiguredTotalRounds();
    let displayMain = '00:00';
    let phaseLabel = 'PRÊT (DÉCOMPTE 10S ACTIVÉ)';
    let displaySub = '';

    if (this.mode === 'FOR_TIME') {
      displayMain =
        this.config.direction === 'UP'
          ? '00:00'
          : CrossfitTimer.formatMMSS(this.config.timeCapSeconds);
      phaseLabel =
        this.config.direction === 'UP' ? 'FOR TIME (COUNT UP)' : 'FOR TIME (COUNT DOWN)';
      displaySub = `TIME CAP : ${CrossfitTimer.formatMMSS(this.config.timeCapSeconds)} • DÉCOMPTE ${this.config.countdownSeconds}S`;
    } else if (this.mode === 'EMOM') {
      displayMain = CrossfitTimer.formatMMSS(this.config.emomIntervalSeconds);
      const everyMin =
        this.config.emomIntervalSeconds % 60 === 0
          ? `E${this.config.emomIntervalSeconds / 60 === 1 ? '' : this.config.emomIntervalSeconds / 60}MOM`
          : `EVERY ${this.config.emomIntervalSeconds}S`;
      phaseLabel = `${everyMin} — ${totalRounds} ROUNDS`;
      displaySub = `DURÉE TOTALE : ${CrossfitTimer.formatMMSS(Math.round(totalWorkoutMs / 1000))} • DÉCOMPTE ${this.config.countdownSeconds}S`;
    } else {
      displayMain = CrossfitTimer.formatMMSS(this.config.workSeconds);
      if (totalRounds === 1 && this.config.restSeconds === 0) {
        phaseLabel = `AMRAP — ${CrossfitTimer.formatMMSS(this.config.workSeconds)}`;
        displaySub = `CONTINU • DÉCOMPTE ${this.config.countdownSeconds}S`;
      } else {
        phaseLabel = `INTERVALLES — ${totalRounds} ROUNDS`;
        displaySub = `WORK ${CrossfitTimer.formatMMSS(this.config.workSeconds)} / REST ${CrossfitTimer.formatMMSS(this.config.restSeconds)} • DÉCOMPTE ${this.config.countdownSeconds}S`;
      }
    }

    return {
      status: 'IDLE',
      mode: this.mode,
      phase: 'READY',
      phaseLabel,
      displayMain,
      displaySub,
      showGoBanner: false,
      currentRound: 1,
      totalRounds,
      progressPercent: 0,
      totalElapsedSeconds: 0,
      totalRemainingSeconds: Math.round(totalWorkoutMs / 1000)
    };
  }

  getConfiguredTotalRounds() {
    if (this.mode === 'FOR_TIME') return 1;
    if (this.mode === 'EMOM') return Math.max(1, this.config.emomRounds);
    return Math.max(1, this.config.intervalRounds);
  }

  notifyPhaseIfNeeded(phaseKey, currentRound, totalRounds) {
    if (this.lastAnnouncedPhaseKey !== phaseKey) {
      this.lastAnnouncedPhaseKey = phaseKey;
      this.onPhaseChange({ phaseKey, currentRound, totalRounds, mode: this.mode });
    }
  }

  emitState() {
    const state = this.computeState();
    this.phase = state.phase;
    this.onTick(state);
  }

  static formatMMSS(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
}

window.CrossfitTimer = CrossfitTimer;
