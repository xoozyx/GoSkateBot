// Extracted unchanged from index.html: procedural 8-bit music + sfx (Web Audio)
const SoundEngine = (function () {
    const STORAGE_KEY_MUTED = 'goskate_muted';
    const STORAGE_KEY_MUSIC_VOLUME = 'goskate_musicVolume';
    const STORAGE_KEY_SFX_VOLUME = 'goskate_sfxVolume';
    const BASE_MUSIC_GAIN = 0.18; // громкость на максимальном уровне карусели (5)
    const BASE_SFX_GAIN = 0.35;
    let ctx = null;
    let sfxGain = null;
    let musicGain = null;
    let unlocked = false;
    // Раньше глушилось отдельной кнопкой ♪/✕ на Mainscreen — её убрали (она
    // визуально накладывалась на скруглённый угол консоли, плюс полностью
    // дублировала Options: уровень 0 там уже даёт настоящую тишину). muted
    // сохранён внутри на будущее, но больше не читается из localStorage и не
    // включается нигде в интерфейсе — если оставить старое сохранённое "было
    // заглушено", человек с прошлой версии навсегда остался бы без звука без
    // единой кнопки это исправить, раз в Options такого переключателя нет.
    let muted = false;
    try {
      localStorage.removeItem(STORAGE_KEY_MUTED);
    } catch (e) { /* не критично */ }

    // ==== Громкость музыки/эффектов — "карусель" 0..5 с экрана Options
    // (Button_options_music_N.png/Button_options_sound_N.png). Отдельно от
    // общего mute (♪/✕) — тот глушит всё разом, это же задаёт относительный
    // уровень каждого канала. 3 из 5 — разумное значение по умолчанию для
    // тех, кто ни разу не открывал Options. ====
    let musicVolumeLevel = 3;
    let sfxVolumeLevel = 3;
    try {
      const mv = parseInt(localStorage.getItem(STORAGE_KEY_MUSIC_VOLUME), 10);
      if (mv >= 0 && mv <= 5) musicVolumeLevel = mv;
      const sv = parseInt(localStorage.getItem(STORAGE_KEY_SFX_VOLUME), 10);
      if (sv >= 0 && sv <= 5) sfxVolumeLevel = sv;
    } catch (e) { /* не критично — останутся значения по умолчанию */ }

    let musicWanted = false; // хотим ли играть музыку прямо сейчас (мы на Mainscreen)
    let musicGeneration = 0; // растёт при каждом stop/start — отменяет "протухшие" setTimeout из прошлого цикла
    let musicTimer = null;
    let musicTempoMul = 1; // >1 = медленнее (см. setSlowdown, эффект "Game Over")
    let musicPitchMul = 1; // <1 = ниже по тону — вместе с tempoMul имитирует "теряющую питание пластинку"

    let noiseBuffer = null; // общий шумовой буфер для snare/hihat в барабанной партии (см. ниже)

    // Применяет текущие уровни громкости к уже созданным gain-узлам —
    // вызывается и сразу после их создания в ensureContext(), и при каждом
    // изменении уровня (см. setMusicVolume/setSfxVolume), чтобы звук менялся
    // "на лету", без пересоздания контекста.
    function applyVolumeGains() {
      if (musicGain) musicGain.gain.value = BASE_MUSIC_GAIN * (musicVolumeLevel / 5);
      if (sfxGain) sfxGain.gain.value = BASE_SFX_GAIN * (sfxVolumeLevel / 5);
    }

    function ensureContext() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      sfxGain = ctx.createGain();
      sfxGain.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.connect(ctx.destination);
      applyVolumeGains(); // выставляет реальные .value для обоих узлов по сохранённым уровням

      // Один короткий буфер белого шума на весь плеер — переиспользуется для
      // каждого удара snare/hihat (создавать новый на каждый удар незачем).
      const len = Math.floor(ctx.sampleRate * 0.3);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      return ctx;
    }

    // Вызывается на самый первый клик/тап по странице (см. подписку в самом
    // низу этого модуля) — до жеста пользователя большинство браузеров не
    // дадут звуку заиграть вообще, поэтому здесь и "будим" AudioContext, и
    // запускаем музыку, если она уже должна была играть (см. musicWanted).
    function unlock() {
      const c = ensureContext();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      unlocked = true;
      if (musicWanted && !muted) startMusicLoop();
    }

    function playToneAt(time, { freq, duration, type = 'square', gain = 0.5, glideTo = null, gainNode = sfxGain }) {
      const c = ctx;
      if (!c || !gainNode) return;
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, time);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, time + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(gain, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      osc.connect(g);
      g.connect(gainNode);
      osc.start(time);
      osc.stop(time + duration + 0.03);
    }

    function playTone(opts) {
      const c = ensureContext();
      if (!c || muted) return;
      if (c.state === 'suspended') return; // ещё не разблокирован жестом — молчим, не ломаем автоплей-политику
      playToneAt(c.currentTime, opts);
    }

    // ==== Звуковые эффекты на кнопки — короткие процедурные "бипы", разные
    // по смыслу нажатия (см. SOUND_BUTTON_OVERRIDES ниже, где кнопки
    // сопоставляются с одним из этих вариантов). ====
    const EFFECTS = {
      click() {
        playTone({ freq: 740, duration: 0.045, type: 'square', gain: 0.35 });
      },
      toggle() {
        playTone({ freq: 480, duration: 0.05, type: 'square', gain: 0.32 });
      },
      confirm() {
        const c = ensureContext();
        if (!c || muted || c.state === 'suspended') return;
        const t0 = c.currentTime;
        playToneAt(t0, { freq: 523, duration: 0.06, type: 'square', gain: 0.4 });
        playToneAt(t0 + 0.06, { freq: 784, duration: 0.09, type: 'square', gain: 0.42 });
      },
      back() {
        playTone({ freq: 320, duration: 0.09, type: 'square', gain: 0.3, glideTo: 170 });
      },
      landed() {
        const c = ensureContext();
        if (!c || muted || c.state === 'suspended') return;
        const t0 = c.currentTime;
        [523, 659, 784, 1047].forEach((freq, i) => {
          playToneAt(t0 + i * 0.055, { freq, duration: 0.09, type: 'square', gain: 0.4 });
        });
      },
      failed() {
        playTone({ freq: 220, duration: 0.2, type: 'sawtooth', gain: 0.32, glideTo: 100 });
      },

      // ==== Кнопки консоли (D-pad/Start/A/B) — имитация "геймпада": у
      // крестовины короткий сухой "тик" почти без тона (разная высота на
      // каждое направление — тактильная подсказка, куда только что нажали,
      // как в олдскульных меню), у A/B по классике NES-раскладки — A ярче и
      // выше (основное/подтверждающее действие), B тусклее и ниже
      // (второстепенное/отмена), у Start — короткий восходящий мотив из двух
      // нот, отдельно от остальных ("системная" кнопка, а не просто ввод). ====
      dpadUp() {
        playTone({ freq: 880, duration: 0.03, type: 'square', gain: 0.26 });
      },
      dpadDown() {
        playTone({ freq: 660, duration: 0.03, type: 'square', gain: 0.26 });
      },
      dpadLeft() {
        playTone({ freq: 740, duration: 0.03, type: 'square', gain: 0.26 });
      },
      dpadRight() {
        playTone({ freq: 988, duration: 0.03, type: 'square', gain: 0.26 });
      },
      buttonA() {
        playTone({ freq: 1046.5, duration: 0.06, type: 'square', gain: 0.4 });
      },
      buttonB() {
        playTone({ freq: 392, duration: 0.07, type: 'square', gain: 0.34, glideTo: 330 });
      },
      buttonStart() {
        const c = ensureContext();
        if (!c || muted || c.state === 'suspended') return;
        const t0 = c.currentTime;
        playToneAt(t0, { freq: 659.25, duration: 0.05, type: 'square', gain: 0.38 });
        playToneAt(t0 + 0.05, { freq: 987.77, duration: 0.09, type: 'square', gain: 0.42 });
      },
    };

    function play(kind) {
      const fn = EFFECTS[kind] || EFFECTS.click;
      fn();
    }

    // ==== Фоновая музыка — два оригинальных процедурных трека (не
    // воспроизведение существующих песен/саундтреков, только позаимствован
    // общий жанровый вайб, который никому не принадлежит): "punk" — быстрый
    // сёрф-панк (играет во время игры), "hiphop" — неторопливый грувовый
    // хип-хоп бит (играет на главном экране). Планируется через
    // ctx.currentTime (а не Date.now/setTimeout напрямую), чтобы не "плыть"
    // по времени — setTimeout используется только чтобы проснуться и
    // запланировать СЛЕДУЮЩИЙ круг заранее, сам звук всегда стоит на точных
    // отметках Web Audio. ====

    // E-A-D-G — те же ноты, что и струны гитары/баса, звучат "правильно"
    // вместе в панк/сёрф-роке и хип-хопе.
    const NOTE = {
      E2: 82.41, F2s: 92.5, G2: 98.0, A2: 110.0,
      B2: 123.47, C3: 130.81, D3: 146.83, E3: 164.81,
      Fs3: 185.0, G3: 196.0, A3: 220.0, B3: 246.94,
      C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0,
    };

    const TRACKS = {
      // Сёрф-панк: без затяжного вступления — сразу быстрый нисходящий
      // "сёрф"-пробег одиночными нотами (первые 8 шагов), затем перегруженные
      // пауэр-корды на чугающем панк-ритме (вторые 8 шагов). Пилообразная
      // волна — "гитарная" грязь вместо чистого тона.
      punk: {
        stepDuration: 0.128,
        swing: 0,
        waveType: 'sawtooth',
        noteDurationMul: 0.75,
        pattern: [
          { freq: NOTE.E4, chord: false, drum: 'k' },
          { freq: NOTE.D4, chord: false, drum: 'h' },
          { freq: NOTE.C4, chord: false, drum: 's' },
          { freq: NOTE.B3, chord: false, drum: 'h' },
          { freq: NOTE.A3, chord: false, drum: 'k' },
          { freq: NOTE.G3, chord: false, drum: 'h' },
          { freq: NOTE.Fs3, chord: false, drum: 's' },
          { freq: NOTE.E3, chord: false, drum: 'h' },
          { freq: NOTE.E2, chord: true, drum: 'k' },
          { freq: NOTE.E2, chord: true, drum: 'h' },
          { freq: NOTE.A2, chord: true, drum: 's' },
          { freq: NOTE.A2, chord: true, drum: 'h' },
          { freq: NOTE.G2, chord: true, drum: 'k' },
          { freq: NOTE.G2, chord: true, drum: 'h' },
          { freq: NOTE.D3, chord: true, drum: 's' },
          { freq: null, chord: true, drum: 'h' },
        ],
      },
      // Хип-хоп: медленный грувовый boom-bap. Три слоя грува поверх обычного
      // паттерна: (1) более заметный swing (нечётные восьмые сильно сдвинуты
      // назад — тот самый "ленивый" хип-хоп-покачивание), (2) ghost-ноты —
      // тихие "призрачные" снэйры/хэты между основными ударами (drumVel < 1,
      // см. playDrumStep), классический приём для живого грува вместо
      // механичного метронома, (3) бас держится дольше шага (noteDurationMul
      // > 1, слегка "наезжает" на следующую долю) — сустейн вместо коротких
      // тычков, из-за этого линия баса звучит текучей, а не отрывистой.
      hiphop: {
        stepDuration: 0.195, // чуть быстрее прежнего — больше энергии, но покачивание (swing) держит грув
        swing: 0.38,
        waveType: 'sine',
        gainMul: 1.6, // главный экран — сделали заметно громче по просьбе
        noteDurationMul: 1.7,
        pattern: [
          { freq: NOTE.E2, chord: false, drum: 'k' },
          { freq: null, chord: false, drum: 'h', drumVel: 0.55 },
          { freq: null, chord: false, drum: 'h', drumVel: 0.3 },
          { freq: NOTE.E2, chord: false, drum: 'k', stab: NOTE.E4 },
          { freq: null, chord: false, drum: 's' },
          { freq: null, chord: false, drum: 'h', drumVel: 0.55 },
          { freq: NOTE.G2, chord: false, drum: 's', drumVel: 0.35 },
          { freq: null, chord: false, drum: 'h', drumVel: 0.3 },
          { freq: NOTE.C3, chord: false, drum: 'k' },
          { freq: null, chord: false, drum: 'h', drumVel: 0.55 },
          { freq: null, chord: false, drum: 'h', drumVel: 0.3 },
          { freq: NOTE.E2, chord: false, drum: 'k', drumVel: 0.85, stab: NOTE.G4 },
          { freq: null, chord: false, drum: 's' },
          { freq: null, chord: false, drum: 'h', drumVel: 0.55 },
          { freq: NOTE.B2, chord: false, drum: 's', drumVel: 0.35 },
          { freq: null, chord: false, drum: 'h', drumVel: 0.5, stab: NOTE.E4 },
        ],
      },
    };

    let currentTrackName = 'hiphop'; // главный экран открывается первым

    function playMusicNote(time, freq, { chord, waveType, duration, gain }) {
      if (!freq) return;
      const pitchedFreq = freq * musicPitchMul;
      playToneAt(time, { freq: pitchedFreq, duration, type: waveType, gain, gainNode: musicGain });
      if (chord) {
        // Корень + чистая квинта (×1.5) — классическое "power chord" звучание.
        playToneAt(time, { freq: pitchedFreq * 1.5, duration, type: waveType, gain: gain * 0.68, gainNode: musicGain });
      }
    }

    // Короткий "стаб" (типа духовой/синтовой подколки) верхним регистром на
    // акцентных синкопированных долях — добавляет хип-хопу энергии/яркости
    // поверх баса и барабанов, не трогая сам грув.
    function playStab(time, freq, gainMul) {
      if (!freq) return;
      playToneAt(time, { freq: freq * musicPitchMul, duration: 0.09, type: 'square', gain: 0.22 * gainMul, gainNode: musicGain });
    }

    function playDrumStep(time, kind, velocity) {
      const vel = velocity == null ? 1 : velocity;
      const c = ctx;
      if (kind === 'k') {
        // Kick — синус с резким глиссандо вниз, коротким щелчком громкости.
        // Питч кика тоже "плывёт" вниз вместе с остальным при замедлении —
        // так эффект "теряющей питание пластинки" звучит цельно, не только бас.
        const osc = c.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150 * musicPitchMul, time);
        osc.frequency.exponentialRampToValueAtTime(42 * musicPitchMul, time + 0.09);
        const g = c.createGain();
        g.gain.setValueAtTime(0.55 * vel, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.11);
        osc.connect(g);
        g.connect(musicGain);
        osc.start(time);
        osc.stop(time + 0.12);
      } else if (kind === 's' || kind === 'h') {
        // Snare/hihat — один и тот же шумовой буфер, разная громкость/длительность.
        // velocity < 1 даёт "ghost note" — тихий призрачный удар для грува.
        if (!noiseBuffer) return;
        const src = c.createBufferSource();
        src.buffer = noiseBuffer;
        const isSnare = kind === 's';
        const g = c.createGain();
        g.gain.setValueAtTime((isSnare ? 0.3 : 0.13) * vel, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + (isSnare ? 0.09 : 0.035));
        src.connect(g);
        g.connect(musicGain);
        src.start(time);
        src.stop(time + (isSnare ? 0.1 : 0.04));
      }
    }

    // Покачивание (swing): нечётные шаги (вторая нота в каждой паре восьмых)
    // сдвигаются позже на долю shuffle-интервала — даёт "неторопливый"
    // хип-хоп-грув вместо ровного метронома. При swing=0 шаги просто идут
    // ровно друг за другом (как раньше).
    function stepOffset(i, stepDuration, swing) {
      const pairIndex = Math.floor(i / 2);
      const pairDuration = stepDuration * 2;
      const base = pairIndex * pairDuration;
      return i % 2 === 0 ? base : base + stepDuration * (1 + swing);
    }

    function scheduleMusicCycle(generation, startTime, track) {
      const c = ctx;
      const stepDuration = track.stepDuration * musicTempoMul; // >1 = темп медленнее (Game Over)
      const durationMul = track.noteDurationMul == null ? 0.75 : track.noteDurationMul;
      const gainMul = track.gainMul == null ? 1 : track.gainMul;
      track.pattern.forEach((step, i) => {
        const t = startTime + stepOffset(i, stepDuration, track.swing || 0);
        playMusicNote(t, step.freq, {
          chord: step.chord,
          waveType: track.waveType,
          duration: stepDuration * durationMul,
          gain: (step.chord ? 0.3 : 0.34) * gainMul,
        });
        if (step.drum) playDrumStep(t, step.drum, (step.drumVel == null ? 1 : step.drumVel) * gainMul);
        if (step.stab) playStab(t, step.stab, gainMul);
      });
      const cycleLength = track.pattern.length * stepDuration;
      const nextStart = startTime + cycleLength;
      const delayMs = Math.max(0, (nextStart - c.currentTime - 0.15) * 1000);
      musicTimer = setTimeout(() => {
        if (generation !== musicGeneration) return; // музыку успели остановить/перезапустить — этот круг больше не нужен
        scheduleMusicCycle(generation, nextStart, track);
      }, delayMs);
    }

    function startMusicLoop() {
      const c = ensureContext();
      if (!c || muted || c.state === 'suspended') return;
      if (musicTimer) return; // уже играет
      musicGeneration++;
      scheduleMusicCycle(musicGeneration, c.currentTime + 0.05, TRACKS[currentTrackName]);
    }

    function stopMusicLoop() {
      musicGeneration++; // отменяет ещё не сработавший setTimeout из scheduleMusicCycle
      if (musicTimer) {
        clearTimeout(musicTimer);
        musicTimer = null;
      }
    }

    // trackName опционален — вызов без него просто (пере)запускает уже
    // выбранный трек (используется, например, при снятии мьюта).
    function startMusic(trackName) {
      const changingTrack = trackName && trackName !== currentTrackName;
      if (trackName) currentTrackName = trackName;
      musicWanted = true;
      if (changingTrack) stopMusicLoop();
      if (unlocked) startMusicLoop();
    }

    function stopMusic() {
      musicWanted = false;
      stopMusicLoop();
    }

    // ==== "Game Over" эффект — темп и высота тона плавно "проседают", как у
    // пластинки, теряющей питание. tempoMul>1 замедляет, pitchMul<1 понижает
    // тон. Меняет текущий проигрываемый цикл СРАЗУ (не ждёт, пока он
    // доиграет), пересчитывая расписание с новым темпом. setSlowdown(1, 1)
    // возвращает обычный темп/тон — вызывается при старте нового раунда. ====
    function setSlowdown(tempoMul, pitchMul) {
      musicTempoMul = tempoMul == null ? 1 : tempoMul;
      musicPitchMul = pitchMul == null ? 1 : pitchMul;
      if (musicTimer) {
        stopMusicLoop();
        startMusicLoop();
      }
    }

    function isMuted() {
      return muted;
    }

    function setMuted(value) {
      muted = value;
      try {
        localStorage.setItem(STORAGE_KEY_MUTED, muted ? '1' : '0');
      } catch (e) { /* не критично, просто не запомним между сессиями */ }
      if (muted) {
        stopMusicLoop();
      } else if (musicWanted && unlocked) {
        startMusicLoop();
      }
    }

    // ==== Карусель громкости (Options): 0..5, вызывается кнопками
    // Button_options_music_N/Button_options_sound_N. Меняет реальную
    // громкость сразу (см. applyVolumeGains), а не только сохранённое число. ====
    function wrapLevel(v) {
      return ((v % 6) + 6) % 6; // 5 -> 0 (карусель), -1 -> 5 на всякий случай
    }

    function getMusicVolume() {
      return musicVolumeLevel;
    }

    function setMusicVolume(level) {
      musicVolumeLevel = wrapLevel(level);
      try {
        localStorage.setItem(STORAGE_KEY_MUSIC_VOLUME, String(musicVolumeLevel));
      } catch (e) { /* не критично, просто не запомним между сессиями */ }
      applyVolumeGains();
      return musicVolumeLevel;
    }

    function cycleMusicVolume() {
      return setMusicVolume(musicVolumeLevel + 1);
    }

    function getSfxVolume() {
      return sfxVolumeLevel;
    }

    function setSfxVolume(level) {
      sfxVolumeLevel = wrapLevel(level);
      try {
        localStorage.setItem(STORAGE_KEY_SFX_VOLUME, String(sfxVolumeLevel));
      } catch (e) { /* не критично, просто не запомним между сессиями */ }
      applyVolumeGains();
      return sfxVolumeLevel;
    }

    function cycleSfxVolume() {
      return setSfxVolume(sfxVolumeLevel + 1);
    }

    // Первый клик/тач в любом месте страницы — разблокирует AudioContext
    // (без этого браузеры молча глушат звук до жеста пользователя).
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });

    // Хотим музыку сразу с открытия страницы (ещё на заставке, до Mainscreen) —
    // выставляем это желание СРАЗУ, не дожидаясь showScreen(mainscreen) после
    // интро. Плюс пробуем разблокировать звук прямо сейчас: почти везде это
    // не сработает (браузер отвечает молчаливым отказом без жеста пользователя —
    // это ограничение самого браузера, обойти его невозможно никаким кодом),
    // но в средах, которые уже считают открытие страницы жестом пользователя
    // (это по-разному ведёт себя в зависимости от конкретного webview),
    // музыка заиграет по-настоящему сразу. Если нет — сыграет, как и раньше,
    // на самый первый тап (см. подписку выше).
    startMusic('hiphop');
    unlock();

    return {
      play, unlock, startMusic, stopMusic, setSlowdown, isMuted, setMuted,
      getMusicVolume, setMusicVolume, cycleMusicVolume,
      getSfxVolume, setSfxVolume, cycleSfxVolume,
    };
  })();
