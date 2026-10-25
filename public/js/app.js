/**
 * app.js — Contrôleur Principal Smart TV ChronoCrossfit
 * Intègre :
 * 1. Système d'authentification Admin (Session Cookie + Changement de mot de passe forcé à la 1ère connexion)
 * 2. Masquage exclusif du bouton "Options & API" lorsque l'administrateur n'est pas connecté
 *    (toutes les fonctionnalités Coach : chrono, presets, filtres WOD, zoom, plein écran restent accessibles)
 * 3. Chronomètre LED haute précision & Synthétiseur Web Audio API
 * 4. Proxy Backend SugarWOD sécurisé
 */
(function () {
  // --- État d'authentification ---
  const authState = {
    authenticated: false,
    mustChangePassword: false,
    username: null
  };

  function isUnlockedAdmin() {
    return Boolean(authState.authenticated && !authState.mustChangePassword);
  }

  // --- État de personnalisation de l'interface (persisté dans localStorage) ---
  const STORAGE_KEY = 'chronocrossfit_ui_prefs_v1';
  const defaultPrefs = {
    showClock: true,
    showTimer: true,
    timerFullscreen: false,
    wodLayout: 'grid', // 'grid' (2 colonnes) | 'stack' (1 colonne pleine largeur)
    zoomPercent: 100,
    volumePercent: 85,
    muted: false,
    wodFilters: {
      movements: true,
      rx: true,
      scaled: true,
      notes: true
    }
  };

  function loadPrefs() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...defaultPrefs,
          ...parsed,
          wodFilters: { ...defaultPrefs.wodFilters, ...(parsed.wodFilters || {}) }
        };
      }
    } catch (e) {
      console.warn('Impossible de lire les préférences locales:', e);
    }
    return { ...defaultPrefs };
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(uiState));
    } catch (e) {
      // Ignorer sur navigateur TV restreint
    }
  }

  const uiState = loadPrefs();
  let currentWorkouts = [];
  let selectedDateStr = ''; // YYYY-MM-DD

  // --- Initialisation Audio & Timer ---
  const soundEngine = new window.SoundEngine();
  soundEngine.setVolume(uiState.volumePercent / 100);
  soundEngine.setMuted(uiState.muted);

  const timerDisplayBox = document.getElementById('timerDisplayBox');
  const timerDigits = document.getElementById('timerDigits');
  const timerPhaseBadge = document.getElementById('timerPhaseBadge');
  const timerRoundPill = document.getElementById('timerRoundPill');
  const timerSubInfo = document.getElementById('timerSubInfo');
  const timerProgressBar = document.getElementById('timerProgressBar');
  const btnTimerStartPause = document.getElementById('btnTimerStartPause');
  const startPauseIcon = document.getElementById('startPauseIcon');
  const startPauseLabel = document.getElementById('startPauseLabel');

  const timer = new window.CrossfitTimer({
    soundEngine,
    onTick: renderTimerState,
    onPhaseChange: handlePhaseVisualFlash,
    onComplete: () => {
      handlePhaseVisualFlash({ phaseKey: 'DONE' });
    }
  });

  // --- Application de l'état d'affichage du bouton "Options & API" ---
  function applyAuthLockState() {
    const unlocked = isUnlockedAdmin();
    // La classe public-tv-locked masque uniquement les éléments .admin-only-control
    // (c'est-à-dire le bouton "⚙️ Options & API" et le bouton "🔒 Déconnexion")
    document.body.classList.toggle('public-tv-locked', !unlocked);

    const adminUserEl = document.getElementById('settingsAdminUsername');
    if (adminUserEl && authState.username) {
      adminUserEl.textContent = authState.username;
    }

    const changePwModal = document.getElementById('changePasswordModal');
    const loginModal = document.getElementById('loginModal');
    const settingsModal = document.getElementById('settingsModal');

    if (authState.authenticated && authState.mustChangePassword) {
      loginModal.classList.add('hidden');
      loginModal.classList.remove('flex');
      settingsModal.classList.add('hidden');
      settingsModal.classList.remove('flex');
      changePwModal.classList.remove('hidden');
      changePwModal.classList.add('flex');
    } else if (!authState.authenticated) {
      changePwModal.classList.add('hidden');
      changePwModal.classList.remove('flex');
      settingsModal.classList.add('hidden');
      settingsModal.classList.remove('flex');
    }
  }

  async function checkSessionStatus() {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const data = await res.json();
      authState.authenticated = Boolean(data.authenticated);
      authState.mustChangePassword = Boolean(data.mustChangePassword);
      authState.username = data.username || null;
    } catch (err) {
      authState.authenticated = false;
      authState.mustChangePassword = false;
      authState.username = null;
    }
    applyAuthLockState();
    if (window.location.hash === '#admin' && !authState.authenticated) {
      openLoginModal();
    }
  }

  function openLoginModal() {
    const loginModal = document.getElementById('loginModal');
    const errEl = document.getElementById('loginErrorMsg');
    errEl.classList.add('hidden');
    loginModal.classList.remove('hidden');
    loginModal.classList.add('flex');
    setTimeout(() => {
      const userField = document.getElementById('inputLoginUsername');
      if (userField) userField.focus();
    }, 50);
  }

  function closeLoginModal() {
    const loginModal = document.getElementById('loginModal');
    loginModal.classList.add('hidden');
    loginModal.classList.remove('flex');
  }

  function bindAuthControls() {
    // Bouton discret cadenas & raccourci clavier Alt + L
    document.getElementById('btnDiscreetAdminLogin').addEventListener('click', openLoginModal);
    document.getElementById('btnCloseLoginModal').addEventListener('click', closeLoginModal);

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (!isUnlockedAdmin()) {
          openLoginModal();
        }
      }
    });

    // Soumission du formulaire de Login
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('inputLoginUsername').value.trim();
      const password = document.getElementById('inputLoginPassword').value;
      const errEl = document.getElementById('loginErrorMsg');

      errEl.classList.add('hidden');

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          errEl.textContent = data.error || 'Identifiants invalides.';
          errEl.classList.remove('hidden');
          return;
        }

        document.getElementById('inputLoginPassword').value = '';
        authState.authenticated = true;
        authState.username = data.username || username;
        authState.mustChangePassword = Boolean(data.mustChangePassword);

        closeLoginModal();
        applyAuthLockState();
        await refreshApiStatus();

        if (authState.mustChangePassword) {
          document.getElementById('inputCurrentPassword').value = password;
          setTimeout(() => {
            document.getElementById('inputNewPassword').focus();
          }, 50);
        }
      } catch (err) {
        errEl.textContent = `Erreur réseau : ${err.message}`;
        errEl.classList.remove('hidden');
      }
    });

    // Soumission du formulaire de changement de mot de passe (obligatoire à la 1ère connexion)
    document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('inputCurrentPassword').value;
      const newPassword = document.getElementById('inputNewPassword').value;
      const confirmPassword = document.getElementById('inputConfirmPassword').value;
      const errEl = document.getElementById('changePasswordErrorMsg');

      errEl.classList.add('hidden');

      if (newPassword !== confirmPassword) {
        errEl.textContent = 'La confirmation du nouveau mot de passe ne correspond pas.';
        errEl.classList.remove('hidden');
        return;
      }

      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          errEl.textContent = data.error || 'Impossible de modifier le mot de passe.';
          errEl.classList.remove('hidden');
          return;
        }

        document.getElementById('inputCurrentPassword').value = '';
        document.getElementById('inputNewPassword').value = '';
        document.getElementById('inputConfirmPassword').value = '';

        authState.mustChangePassword = false;
        const changePwModal = document.getElementById('changePasswordModal');
        changePwModal.classList.add('hidden');
        changePwModal.classList.remove('flex');

        applyAuthLockState();
        await refreshApiStatus();
      } catch (err) {
        errEl.textContent = `Erreur réseau : ${err.message}`;
        errEl.classList.remove('hidden');
      }
    });

    document.getElementById('btnCancelPasswordChange').addEventListener('click', async () => {
      if (authState.mustChangePassword) {
        await performLogout();
      } else {
        const changePwModal = document.getElementById('changePasswordModal');
        changePwModal.classList.add('hidden');
        changePwModal.classList.remove('flex');
      }
    });

    document.getElementById('btnOpenPasswordModalFromSettings').addEventListener('click', () => {
      document.getElementById('settingsModal').classList.add('hidden');
      document.getElementById('settingsModal').classList.remove('flex');
      const changePwModal = document.getElementById('changePasswordModal');
      document.getElementById('changePasswordErrorMsg').classList.add('hidden');
      changePwModal.classList.remove('hidden');
      changePwModal.classList.add('flex');
    });

    document.getElementById('btnAdminLogout').addEventListener('click', performLogout);
  }

  async function performLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {
      // Ignorer
    }
    authState.authenticated = false;
    authState.mustChangePassword = false;
    authState.username = null;
    if (window.location.hash === '#admin') {
      history.replaceState(null, '', window.location.pathname);
    }
    applyAuthLockState();
  }

  // --- Rendu Haute Fréquence de l'afficheur LED ---
  function renderTimerState(state) {
    timerDigits.textContent = state.displayMain;
    timerPhaseBadge.textContent = state.phaseLabel;
    timerSubInfo.textContent = state.displaySub;
    timerRoundPill.textContent = `ROUND ${state.currentRound} / ${state.totalRounds}`;
    timerProgressBar.style.width = `${Math.max(0, Math.min(100, state.progressPercent))}%`;

    timerDigits.classList.remove(
      'led-glow-ready',
      'led-glow-countdown',
      'led-glow-work',
      'led-glow-rest',
      'led-glow-done'
    );

    if (state.phase === 'COUNTDOWN') {
      timerDigits.classList.add('led-glow-countdown');
      timerPhaseBadge.className =
        'px-3 py-1 rounded-md text-xs md:text-sm font-extrabold uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/40';
    } else if (state.phase === 'WORK') {
      timerDigits.classList.add('led-glow-work');
      timerPhaseBadge.className =
        'px-3 py-1 rounded-md text-xs md:text-sm font-extrabold uppercase tracking-widest bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    } else if (state.phase === 'REST') {
      timerDigits.classList.add('led-glow-rest');
      timerPhaseBadge.className =
        'px-3 py-1 rounded-md text-xs md:text-sm font-extrabold uppercase tracking-widest bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
    } else if (state.phase === 'DONE') {
      timerDigits.classList.add('led-glow-done');
      timerPhaseBadge.className =
        'px-3 py-1 rounded-md text-xs md:text-sm font-extrabold uppercase tracking-widest bg-red-600/30 text-red-200 border border-red-500/50 animate-pulse';
    } else {
      timerDigits.classList.add('led-glow-ready');
      timerPhaseBadge.className =
        'px-3 py-1 rounded-md text-xs md:text-sm font-extrabold uppercase tracking-widest bg-red-500/20 text-red-400 border border-red-500/30';
    }

    if (state.status === 'RUNNING') {
      startPauseIcon.textContent = '⏸';
      startPauseLabel.textContent = 'PAUSE';
      btnTimerStartPause.className =
        'col-span-6 py-3.5 px-4 rounded-xl font-led text-base md:text-lg font-black uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-[0_0_20px_rgba(245,158,11,0.35)] transition flex items-center justify-center gap-2';
    } else if (state.status === 'PAUSED') {
      startPauseIcon.textContent = '▶';
      startPauseLabel.textContent = 'REPRENDRE';
      btnTimerStartPause.className =
        'col-span-6 py-3.5 px-4 rounded-xl font-led text-base md:text-lg font-black uppercase tracking-wider bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] transition flex items-center justify-center gap-2';
    } else if (state.status === 'COMPLETED') {
      startPauseIcon.textContent = '↻';
      startPauseLabel.textContent = 'RELANCER (10s)';
      btnTimerStartPause.className =
        'col-span-6 py-3.5 px-4 rounded-xl font-led text-base md:text-lg font-black uppercase tracking-wider bg-red-600 hover:bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] transition flex items-center justify-center gap-2';
    } else {
      startPauseIcon.textContent = '▶';
      startPauseLabel.textContent = 'START (10s)';
      btnTimerStartPause.className =
        'col-span-6 py-3.5 px-4 rounded-xl font-led text-base md:text-lg font-black uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.35)] transition flex items-center justify-center gap-2';
    }
  }

  function handlePhaseVisualFlash({ phaseKey }) {
    if (!timerDisplayBox) return;
    timerDisplayBox.classList.remove('flash-work', 'flash-rest');
    void timerDisplayBox.offsetWidth;
    if (String(phaseKey).includes('REST')) {
      timerDisplayBox.classList.add('flash-rest');
    } else if (phaseKey !== 'COUNTDOWN') {
      timerDisplayBox.classList.add('flash-work');
    }
  }

  // --- Horloge Temps Réel ---
  function startLiveClock() {
    const clockEl = document.getElementById('liveClockDisplay');
    const updateClock = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      if (clockEl) clockEl.textContent = `${hh}:${mm}:${ss}`;
    };
    updateClock();
    setInterval(updateClock, 1000);
  }

  // --- Contrôles du Chronomètre (Toujours accessibles au Coach) ---
  function bindTimerControls() {
    const modeTabs = document.querySelectorAll('.timer-mode-tab');
    const panelForTime = document.getElementById('configPanelForTime');
    const panelEmom = document.getElementById('configPanelEmom');
    const panelIntervals = document.getElementById('configPanelIntervals');

    function switchModeUI(targetMode) {
      modeTabs.forEach((btn) => {
        const isCurrent = btn.getAttribute('data-timer-mode') === targetMode;
        btn.className = isCurrent
          ? 'timer-mode-tab py-2 px-2 rounded-lg text-xs md:text-sm font-extrabold uppercase tracking-wider transition bg-red-600 text-white shadow'
          : 'timer-mode-tab py-2 px-2 rounded-lg text-xs md:text-sm font-extrabold uppercase tracking-wider transition text-slate-400 hover:text-white';
      });

      panelForTime.classList.toggle('hidden', targetMode !== 'FOR_TIME');
      panelEmom.classList.toggle('hidden', targetMode !== 'EMOM');
      panelIntervals.classList.toggle('hidden', targetMode !== 'INTERVALS');

      timer.setMode(targetMode);
      syncTimerConfigFromInputs();
    }

    modeTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        switchModeUI(btn.getAttribute('data-timer-mode'));
      });
    });

    btnTimerStartPause.addEventListener('click', () => timer.toggle());
    document.getElementById('btnTimerReset').addEventListener('click', () => timer.reset());

    const btnMute = document.getElementById('btnMuteAudio');
    function updateMuteButton() {
      btnMute.textContent = uiState.muted ? '🔇' : '🔊';
      btnMute.classList.toggle('text-red-400', uiState.muted);
    }
    updateMuteButton();
    btnMute.addEventListener('click', () => {
      uiState.muted = !uiState.muted;
      soundEngine.setMuted(uiState.muted);
      updateMuteButton();
      savePrefs();
    });

    let forTimeDirection = 'UP';
    const btnDirUp = document.getElementById('btnDirUp');
    const btnDirDown = document.getElementById('btnDirDown');

    function setDirectionUI(dir) {
      forTimeDirection = dir;
      btnDirUp.className =
        dir === 'UP'
          ? 'py-1.5 rounded text-xs font-extrabold uppercase bg-emerald-600 text-slate-950 transition'
          : 'py-1.5 rounded text-xs font-extrabold uppercase text-slate-400 hover:text-white transition';
      btnDirDown.className =
        dir === 'DOWN'
          ? 'py-1.5 rounded text-xs font-extrabold uppercase bg-amber-500 text-slate-950 transition'
          : 'py-1.5 rounded text-xs font-extrabold uppercase text-slate-400 hover:text-white transition';
      syncTimerConfigFromInputs();
    }

    btnDirUp.addEventListener('click', () => setDirectionUI('UP'));
    btnDirDown.addEventListener('click', () => setDirectionUI('DOWN'));

    function syncTimerConfigFromInputs() {
      const ftMin = parseInt(document.getElementById('inputForTimeMin').value || '0', 10);
      const ftSec = parseInt(document.getElementById('inputForTimeSec').value || '0', 10);
      const timeCapSeconds = Math.max(5, ftMin * 60 + ftSec);

      const emomIntervalSeconds = parseInt(
        document.getElementById('selectEmomEvery').value || '60',
        10
      );
      const emomRounds = Math.max(
        1,
        parseInt(document.getElementById('inputEmomRounds').value || '10', 10)
      );

      const wMin = parseInt(document.getElementById('inputWorkMin').value || '0', 10);
      const wSec = parseInt(document.getElementById('inputWorkSec').value || '0', 10);
      const workSeconds = Math.max(5, wMin * 60 + wSec);

      const rMin = parseInt(document.getElementById('inputRestMin').value || '0', 10);
      const rSec = parseInt(document.getElementById('inputRestSec').value || '0', 10);
      const restSeconds = Math.max(0, rMin * 60 + rSec);

      const intervalRounds = Math.max(
        1,
        parseInt(document.getElementById('inputIntervalRounds').value || '1', 10)
      );

      timer.configure({
        direction: forTimeDirection,
        timeCapSeconds,
        emomIntervalSeconds,
        emomRounds,
        workSeconds,
        restSeconds,
        intervalRounds
      });
    }

    [
      'inputForTimeMin',
      'inputForTimeSec',
      'selectEmomEvery',
      'inputEmomRounds',
      'inputWorkMin',
      'inputWorkSec',
      'inputRestMin',
      'inputRestSec',
      'inputIntervalRounds'
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', syncTimerConfigFromInputs);
        el.addEventListener('input', syncTimerConfigFromInputs);
      }
    });

    document.querySelectorAll('[data-ft-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const totalSec = parseInt(btn.getAttribute('data-ft-preset'), 10);
        document.getElementById('inputForTimeMin').value = Math.floor(totalSec / 60);
        document.getElementById('inputForTimeSec').value = totalSec % 60;
        syncTimerConfigFromInputs();
      });
    });

    document.querySelectorAll('[data-emom-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [everySec, rounds] = btn.getAttribute('data-emom-preset').split(',').map(Number);
        document.getElementById('selectEmomEvery').value = String(everySec);
        document.getElementById('inputEmomRounds').value = String(rounds);
        syncTimerConfigFromInputs();
      });
    });

    document.querySelectorAll('[data-int-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [workSec, restSec, rounds] = btn
          .getAttribute('data-int-preset')
          .split(',')
          .map(Number);
        document.getElementById('inputWorkMin').value = Math.floor(workSec / 60);
        document.getElementById('inputWorkSec').value = workSec % 60;
        document.getElementById('inputRestMin').value = Math.floor(restSec / 60);
        document.getElementById('inputRestSec').value = restSec % 60;
        document.getElementById('inputIntervalRounds').value = rounds;
        syncTimerConfigFromInputs();
      });
    });

    window.applyWorkoutTimerPreset = function (preset) {
      if (!preset) return;
      if (!uiState.showTimer) {
        uiState.showTimer = true;
        applyUiPreferences();
      }
      if (preset.mode === 'FOR_TIME') {
        const cap = preset.timeCapSeconds || 900;
        document.getElementById('inputForTimeMin').value = Math.floor(cap / 60);
        document.getElementById('inputForTimeSec').value = cap % 60;
        setDirectionUI(preset.direction || 'UP');
        switchModeUI('FOR_TIME');
      } else if (preset.mode === 'EMOM') {
        const every = preset.intervalSeconds || 60;
        const selectEl = document.getElementById('selectEmomEvery');
        if ([30, 60, 90, 120, 180, 240].includes(every)) {
          selectEl.value = String(every);
        } else {
          selectEl.value = '60';
        }
        document.getElementById('inputEmomRounds').value = preset.rounds || 10;
        switchModeUI('EMOM');
      } else if (preset.mode === 'INTERVALS') {
        const work = preset.workSeconds || 240;
        const rest = preset.restSeconds || 0;
        document.getElementById('inputWorkMin').value = Math.floor(work / 60);
        document.getElementById('inputWorkSec').value = work % 60;
        document.getElementById('inputRestMin').value = Math.floor(rest / 60);
        document.getElementById('inputRestSec').value = rest % 60;
        document.getElementById('inputIntervalRounds').value = preset.rounds || 1;
        switchModeUI('INTERVALS');
      }
    };

    timer.emitState();
  }

  // --- Personnalisation TV ---
  function applyUiPreferences() {
    const clockContainer = document.getElementById('liveClockContainer');
    clockContainer.classList.toggle('hidden', !uiState.showClock);
    document.getElementById('toggleShowClock').checked = uiState.showClock;

    const timerSection = document.getElementById('timerSection');
    const wodSection = document.getElementById('wodSection');
    const btnQuickToggleTimer = document.getElementById('btnQuickToggleTimer');

    document.getElementById('toggleShowTimer').checked = uiState.showTimer;

    if (!uiState.showTimer && !uiState.timerFullscreen) {
      timerSection.classList.add('hidden');
      wodSection.classList.remove('lg:col-span-7', 'xl:col-span-7');
      wodSection.classList.add('lg:col-span-12', 'xl:col-span-12');
      btnQuickToggleTimer.className =
        'px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs font-bold uppercase tracking-wider text-slate-400 border border-slate-800 transition flex items-center gap-1.5';
    } else {
      timerSection.classList.remove('hidden');
      wodSection.classList.add('lg:col-span-7', 'xl:col-span-7');
      wodSection.classList.remove('lg:col-span-12', 'xl:col-span-12');
      btnQuickToggleTimer.className =
        'px-3 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-xs font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/40 transition flex items-center gap-1.5';
    }

    document.body.classList.toggle('timer-fullscreen-mode', Boolean(uiState.timerFullscreen));
    const fsLabel = document.getElementById('fullscreenTimerLabel');
    const btnExpandCard = document.getElementById('btnTimerExpandCard');
    if (uiState.timerFullscreen) {
      fsLabel.textContent = 'Quitter Plein Écran';
      btnExpandCard.textContent = '↙ RÉDUIRE';
    } else {
      fsLabel.textContent = 'Chrono Géant';
      btnExpandCard.textContent = '⛶ GÉANT';
    }

    const zoomScale = (uiState.zoomPercent || 100) / 100;
    document.documentElement.style.setProperty('--ui-zoom', String(zoomScale));
    document.getElementById('zoomLabelQuick').textContent = `${uiState.zoomPercent}%`;
    document.getElementById('zoomSliderValue').textContent = `${uiState.zoomPercent}%`;
    document.getElementById('sliderZoom').value = String(uiState.zoomPercent);

    const f = uiState.wodFilters;
    document.getElementById('chkShowMovements').checked = f.movements;
    document.getElementById('chkShowRx').checked = f.rx;
    document.getElementById('chkShowScaled').checked = f.scaled;
    document.getElementById('chkShowNotes').checked = f.notes;

    document.querySelectorAll('.wod-filter-pill').forEach((pill) => {
      const key = pill.getAttribute('data-wod-filter');
      const active = Boolean(f[key]);
      pill.style.opacity = active ? '1' : '0.38';
    });

    // Mise à jour de l'apparence du bouton "Vue" (Grille vs Empilé pleine largeur)
    const layoutIcon = document.getElementById('wodLayoutIcon');
    const layoutLabel = document.getElementById('wodLayoutLabel');
    const btnToggleWodLayout = document.getElementById('btnToggleWodLayout');
    if (layoutIcon && layoutLabel && btnToggleWodLayout) {
      if (uiState.wodLayout === 'stack') {
        layoutIcon.textContent = '☰';
        layoutLabel.textContent = 'Vue : Empilée';
        btnToggleWodLayout.className =
          'px-3 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-xs font-extrabold uppercase tracking-wider text-cyan-300 transition flex items-center gap-1.5';
      } else {
        layoutIcon.textContent = '⊞';
        layoutLabel.textContent = 'Vue : Grille';
        btnToggleWodLayout.className =
          'px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-bold uppercase tracking-wider text-slate-200 transition flex items-center gap-1.5';
      }
    }

    renderWorkouts();
    savePrefs();
  }

  function bindCustomizationControls() {
    const modal = document.getElementById('settingsModal');
    const openModal = () => {
      // Seul le panneau "Options & API" exige que l'Admin soit connecté
      if (!isUnlockedAdmin()) {
        openLoginModal();
        return;
      }
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      refreshApiStatus();
    };
    const closeModal = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    };

    document.getElementById('btnOpenSettings').addEventListener('click', openModal);
    document.getElementById('btnCloseSettings').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    document.getElementById('toggleShowClock').addEventListener('change', (e) => {
      uiState.showClock = e.target.checked;
      applyUiPreferences();
    });

    document.getElementById('toggleShowTimer').addEventListener('change', (e) => {
      uiState.showTimer = e.target.checked;
      if (!uiState.showTimer) uiState.timerFullscreen = false;
      applyUiPreferences();
    });

    document.getElementById('btnQuickToggleTimer').addEventListener('click', () => {
      if (uiState.timerFullscreen) {
        uiState.timerFullscreen = false;
      } else {
        uiState.showTimer = !uiState.showTimer;
      }
      applyUiPreferences();
    });

    const toggleTimerFullscreen = () => {
      uiState.timerFullscreen = !uiState.timerFullscreen;
      if (uiState.timerFullscreen) {
        uiState.showTimer = true;
        if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      }
      applyUiPreferences();
    };

    document.getElementById('btnFullscreenTimer').addEventListener('click', toggleTimerFullscreen);
    document.getElementById('btnTimerExpandCard').addEventListener('click', toggleTimerFullscreen);

    const updateZoom = (newZoom) => {
      uiState.zoomPercent = Math.max(75, Math.min(155, Math.round(newZoom / 5) * 5));
      applyUiPreferences();
    };

    document.getElementById('btnZoomInQuick').addEventListener('click', () => {
      updateZoom(uiState.zoomPercent + 10);
    });
    document.getElementById('btnZoomOutQuick').addEventListener('click', () => {
      updateZoom(uiState.zoomPercent - 10);
    });
    document.getElementById('sliderZoom').addEventListener('input', (e) => {
      updateZoom(parseInt(e.target.value, 10));
    });

    document.getElementById('sliderVolume').value = String(uiState.volumePercent);
    document.getElementById('sliderVolume').addEventListener('input', (e) => {
      uiState.volumePercent = parseInt(e.target.value, 10);
      soundEngine.setVolume(uiState.volumePercent / 100);
      savePrefs();
    });

    document.getElementById('btnTestSound').addEventListener('click', () => {
      soundEngine.setMuted(false);
      uiState.muted = false;
      document.getElementById('btnMuteAudio').textContent = '🔊';
      soundEngine.beepCountdown();
      setTimeout(() => soundEngine.beepGo(), 320);
    });

    document.querySelectorAll('.wod-filter-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const key = pill.getAttribute('data-wod-filter');
        uiState.wodFilters[key] = !uiState.wodFilters[key];
        applyUiPreferences();
      });
    });

    const filterCheckboxMap = {
      chkShowMovements: 'movements',
      chkShowRx: 'rx',
      chkShowScaled: 'scaled',
      chkShowNotes: 'notes'
    };

    Object.entries(filterCheckboxMap).forEach(([chkId, filterKey]) => {
      document.getElementById(chkId).addEventListener('change', (e) => {
        uiState.wodFilters[filterKey] = e.target.checked;
        applyUiPreferences();
      });
    });
  }

  // --- Intégration Backend Proxy SugarWOD ---
  function formatDateInput(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  async function refreshApiStatus() {
    try {
      const res = await fetch('/api/config/status', { credentials: 'same-origin' });
      const data = await res.json();
      const dot = document.getElementById('apiStatusDot');
      const text = document.getElementById('apiStatusText');
      const modalStatus = document.getElementById('modalApiKeyStatus');
      const chkForceDemo = document.getElementById('chkForceDemo');

      chkForceDemo.checked = Boolean(data.forceDemo);

      if (data.configured && !data.forceDemo) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';
        text.textContent = 'SugarWOD : Connecté';
        modalStatus.textContent = `Clé active (${data.maskedKey || 'Protégée'}) via ${data.source === 'env' ? '.env' : 'Serveur'}`;
        modalStatus.className = 'font-mono-tabular font-bold text-emerald-400';
      } else if (data.configured && data.forceDemo) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
        text.textContent = 'SugarWOD : Démo Forcée';
        modalStatus.textContent = `Clé enregistrée (${data.maskedKey || 'Protégée'}) — Mode Démo forcé`;
        modalStatus.className = 'font-mono-tabular font-bold text-amber-400';
      } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
        text.textContent = 'SugarWOD : Mode Démo';
        modalStatus.textContent = 'Aucune clé API configurée (Mode Démo actif)';
        modalStatus.className = 'font-mono-tabular font-bold text-amber-400';
      }
    } catch (err) {
      console.error('Erreur statut API:', err);
    }
  }

  async function loadTracks() {
    try {
      const res = await fetch('/api/tracks', { credentials: 'same-origin' });
      const data = await res.json();
      const select = document.getElementById('selectSugarTrack');
      const currentVal = select.value || 'all';

      select.innerHTML = '<option value="all">Toutes les pistes (Tracks)</option>';
      (data.tracks || []).forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        select.appendChild(opt);
      });

      if ([...select.options].some((o) => o.value === currentVal)) {
        select.value = currentVal;
      }
    } catch (err) {
      console.error('Erreur chargement tracks:', err);
    }
  }

  async function loadWorkouts() {
    const container = document.getElementById('wodCardsContainer');
    const warningBanner = document.getElementById('wodWarningBanner');
    const warningText = document.getElementById('wodWarningText');
    const trackId = document.getElementById('selectSugarTrack').value || 'all';
    const compactDate = (selectedDateStr || formatDateInput(new Date())).replace(/-/g, '');

    try {
      const res = await fetch(
        `/api/workouts?date=${encodeURIComponent(compactDate)}&track_id=${encodeURIComponent(trackId)}`,
        { credentials: 'same-origin' }
      );
      const data = await res.json();

      if (data.warning) {
        warningText.textContent = data.warning;
        warningBanner.classList.remove('hidden');
      } else {
        warningBanner.classList.add('hidden');
      }

      currentWorkouts = Array.isArray(data.workouts) ? data.workouts : [];
      renderWorkouts();
    } catch (err) {
      container.innerHTML = `
        <div class="col-span-full bg-red-950/40 border border-red-500/40 rounded-2xl p-6 text-center">
          <p class="font-bold text-red-300">Impossible de récupérer les WODs (${escapeHtml(err.message)})</p>
        </div>
      `;
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderWorkouts() {
    const container = document.getElementById('wodCardsContainer');
    if (!container) return;

    if (!currentWorkouts || currentWorkouts.length === 0) {
      container.innerHTML = `
        <div class="col-span-full bg-box-panel border border-box-border rounded-2xl p-8 text-center">
          <div class="text-2xl font-led font-bold text-slate-400 mb-2">AUCUN WORKOUT PROGRAMMÉ</div>
          <p class="text-sm text-slate-500">Aucun WOD trouvé pour cette date ou cette piste SugarWOD.</p>
        </div>
      `;
      return;
    }

    const f = uiState.wodFilters;

    // En mode "stack" (Vue : Empilée) ou s'il n'y a qu'un seul WOD :
    // Chaque bloc est affiché l'un au-dessus de l'autre en utilisant 100% de la largeur disponible
    // de la zone WOD (qui s'adapte automatiquement selon que le chrono est affiché ou masqué).
    const isStackView = uiState.wodLayout === 'stack' || currentWorkouts.length === 1;
    container.className = isStackView
      ? 'wod-zoomable grid grid-cols-1 gap-4 w-full'
      : 'wod-zoomable grid grid-cols-1 xl:grid-cols-2 gap-4 w-full';

    container.innerHTML = currentWorkouts
      .map((wod, idx) => {
        const movementsHtml =
          f.movements && wod.movements && wod.movements.length > 0
            ? `
          <div class="bg-slate-950/85 border border-slate-800/90 rounded-xl p-4 space-y-1.5">
            ${wod.movements
              .map((line) =>
                line === ''
                  ? '<div class="h-2"></div>'
                  : `<div class="wod-movement-line font-semibold text-slate-100 tracking-wide">${escapeHtml(line)}</div>`
              )
              .join('')}
          </div>
        `
            : '';

        const rxHtml =
          f.rx && wod.rx
            ? `
          <div class="wod-badge-block bg-red-950/35 border border-red-500/40 rounded-xl px-3.5 py-2.5 flex items-start gap-2.5">
            <span class="px-2 py-0.5 rounded bg-red-600 text-white font-led text-xs font-black uppercase tracking-wider shrink-0 mt-0.5">
              RX
            </span>
            <p class="text-red-100 font-semibold whitespace-pre-line">${escapeHtml(wod.rx)}</p>
          </div>
        `
            : '';

        const scaledHtml =
          f.scaled && wod.scaled
            ? `
          <div class="wod-badge-block bg-cyan-950/35 border border-cyan-500/40 rounded-xl px-3.5 py-2.5 flex items-start gap-2.5">
            <span class="px-2 py-0.5 rounded bg-cyan-500 text-slate-950 font-led text-xs font-black uppercase tracking-wider shrink-0 mt-0.5">
              SCALED
            </span>
            <p class="text-cyan-100 font-semibold whitespace-pre-line">${escapeHtml(wod.scaled)}</p>
          </div>
        `
            : '';

        const notesHtml =
          f.notes && wod.notes
            ? `
          <div class="wod-badge-block bg-amber-950/30 border border-amber-500/35 rounded-xl px-3.5 py-2.5 flex items-start gap-2.5">
            <span class="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-led text-[11px] font-black uppercase tracking-wider shrink-0 mt-0.5">
              COACH
            </span>
            <p class="text-amber-100/90 text-sm whitespace-pre-line">${escapeHtml(wod.notes)}</p>
          </div>
        `
            : '';

        const presetBtnHtml = wod.suggestedTimer
          ? `
          <button
            type="button"
            data-load-wod-timer="${idx}"
            title="Charger automatiquement ce format dans le chronomètre"
            class="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-extrabold uppercase tracking-wider transition flex items-center gap-1.5 shrink-0"
          >
            <span>⏱️ ${escapeHtml(wod.suggestedTimer.label || 'Charger Chrono')}</span>
          </button>
        `
          : '';

        return `
          <article class="w-full bg-box-panel border border-box-border rounded-2xl p-5 shadow-xl flex flex-col justify-between gap-3.5 hover:border-slate-600 transition">
            <div class="space-y-3.5">
              <div class="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[11px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      ${escapeHtml(wod.trackName || 'CrossFit')}
                    </span>
                    <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
                      ${escapeHtml(wod.scoreType || 'WOD')}
                    </span>
                  </div>
                  <h3 class="wod-card-title font-led font-black text-white tracking-wide">
                    ${escapeHtml(wod.title)}
                  </h3>
                </div>
                ${presetBtnHtml}
              </div>

              ${movementsHtml}
              ${rxHtml}
              ${scaledHtml}
              ${notesHtml}
            </div>
          </article>
        `;
      })
      .join('');

    container.querySelectorAll('[data-load-wod-timer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-load-wod-timer'), 10);
        const wod = currentWorkouts[idx];
        if (wod && wod.suggestedTimer && window.applyWorkoutTimerPreset) {
          window.applyWorkoutTimerPreset(wod.suggestedTimer);
        }
      });
    });
  }

  function bindSugarWodControls() {
    const dateInput = document.getElementById('inputWodDate');
    selectedDateStr = formatDateInput(new Date());
    dateInput.value = selectedDateStr;

    const shiftDate = (deltaDays) => {
      const parts = (dateInput.value || formatDateInput(new Date())).split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      d.setDate(d.getDate() + deltaDays);
      selectedDateStr = formatDateInput(d);
      dateInput.value = selectedDateStr;
      loadWorkouts();
    };

    dateInput.addEventListener('change', (e) => {
      selectedDateStr = e.target.value;
      loadWorkouts();
    });

    document.getElementById('btnPrevDay').addEventListener('click', () => shiftDate(-1));
    document.getElementById('btnNextDay').addEventListener('click', () => shiftDate(1));
    document.getElementById('selectSugarTrack').addEventListener('change', () => loadWorkouts());
    document.getElementById('btnRefreshWod').addEventListener('click', () => {
      loadTracks();
      loadWorkouts();
    });

    // Bouton "Vue" : bascule entre Vue Grille (2 colonnes) et Vue Empilée (1 colonne pleine largeur)
    const btnToggleWodLayout = document.getElementById('btnToggleWodLayout');
    if (btnToggleWodLayout) {
      btnToggleWodLayout.addEventListener('click', () => {
        uiState.wodLayout = uiState.wodLayout === 'stack' ? 'grid' : 'stack';
        applyUiPreferences();
      });
    }

    document.getElementById('btnDismissWarning').addEventListener('click', () => {
      document.getElementById('wodWarningBanner').classList.add('hidden');
    });

    // Enregistrement de la clé API SugarWOD (protégé par session Admin)
    document.getElementById('btnSaveApiConfig').addEventListener('click', async () => {
      if (!isUnlockedAdmin()) return;
      const apiKeyInput = document.getElementById('inputSugarApiKey');
      const chkForceDemo = document.getElementById('chkForceDemo');
      const feedback = document.getElementById('apiSaveFeedback');

      const payload = {
        forceDemo: chkForceDemo.checked
      };
      if (apiKeyInput.value.trim() !== '') {
        payload.apiKey = apiKeyInput.value.trim();
      }

      try {
        const res = await fetch('/api/config/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        feedback.classList.remove('hidden');
        if (!res.ok || !data.success) {
          feedback.textContent = data.error || 'Erreur lors de la sauvegarde.';
          feedback.className = 'text-xs font-semibold text-red-400';
          return;
        }

        apiKeyInput.value = '';
        feedback.textContent = 'Configuration SugarWOD enregistrée en toute sécurité sur le serveur !';
        feedback.className = 'text-xs font-semibold text-emerald-400';

        await refreshApiStatus();
        await loadTracks();
        await loadWorkouts();
      } catch (err) {
        feedback.classList.remove('hidden');
        feedback.textContent = `Erreur réseau : ${err.message}`;
        feedback.className = 'text-xs font-semibold text-red-400';
      }
    });
  }

  // --- Démarrage global ---
  document.addEventListener('DOMContentLoaded', async () => {
    startLiveClock();
    bindAuthControls();
    bindTimerControls();
    bindCustomizationControls();
    bindSugarWodControls();
    applyUiPreferences();

    await checkSessionStatus();
    await refreshApiStatus();
    await loadTracks();
    await loadWorkouts();
  });
})();
