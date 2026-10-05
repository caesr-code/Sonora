import { describeSeconds, detectWake, findBestTrack, parseCommand, similarity, stripGreeting, titleCase, wakeNames } from './voice-commands.js';

const SpeechRecognitionClass = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const AWAKE_TIMEOUT_MS = 8000;
const STABLE_COMMAND_MS = 1200;
const DUCK_LEVEL = 0.22;

export const voiceSupported = Boolean(SpeechRecognitionClass);

/**
 * "Hey Sonora" style voice control.
 *
 * States: off → listening (waiting for the trigger phrase) → awake (waiting for a command)
 *         → back to listening. `recording` is used while the user records a new trigger name.
 */
export class VoiceControl extends EventTarget {
  constructor({ engine, library, settings, getOrderedIds }) {
    super();
    this.engine = engine;
    this.library = library;
    this.settings = settings;
    this.getOrderedIds = getOrderedIds;
    this.state = 'off';
    this.recognition = null;
    this.wantListening = false;
    this.restartTimer = null;
    this.awakeTimer = null;
    this.stableTimer = null;
    this.wakeIndex = -1;
    this.lastStart = 0;
    this.quickFailures = 0;
    this.audioContext = null;
    this.recordingTask = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantListening && !this.recognition) this.spawn();
    });
  }

  get supported() {
    return voiceSupported;
  }

  get triggerLabel() {
    return `Hey ${titleCase(this.settings.get('wakeName'))}`;
  }

  names() {
    return wakeNames(this.settings.get('wakeName'), this.settings.get('wakeVariants'));
  }

  setState(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state, ...detail } }));
  }

  say(text, kind = 'info') {
    this.dispatchEvent(new CustomEvent('feedback', { detail: { text, kind } }));
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (!voiceSupported) {
      this.setState('unsupported');
      this.dispatchEvent(new CustomEvent('problem', { detail: { title: 'Voice control unavailable', message: 'This browser does not support speech recognition. Use Safari, Chrome or Edge.' } }));
      return false;
    }
    if (!globalThis.isSecureContext) {
      this.dispatchEvent(new CustomEvent('problem', { detail: { title: 'Secure connection required', message: 'Microphone access only works on https:// pages (GitHub Pages is fine) or localhost.' } }));
      return false;
    }
    this.wantListening = true;
    this.quickFailures = 0;
    this.ensureAudio();
    this.spawn();
    return true;
  }

  stop() {
    this.wantListening = false;
    clearTimeout(this.restartTimer);
    this.clearAwake();
    this.engine.setDuck(1);
    this.teardown();
    this.setState('off');
  }

  teardown() {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onresult = recognition.onend = recognition.onerror = recognition.onstart = null;
    try { recognition.abort(); } catch { /* already stopped */ }
  }

  spawn() {
    if (!this.wantListening || this.recognition) return;
    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.lang = navigator.language || 'en-US';
    this.wakeIndex = -1;
    recognition.onstart = () => {
      this.lastStart = Date.now();
      if (this.state === 'off' || this.state === 'error' || this.state === 'starting') this.setState('listening');
    };
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      if (!this.wantListening) return;
      // Browsers end continuous sessions regularly; quietly start a new one.
      const ranFor = Date.now() - this.lastStart;
      this.quickFailures = ranFor < 1500 ? this.quickFailures + 1 : 0;
      const delay = Math.min(4000, 250 + this.quickFailures * 600);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.spawn(), delay);
    };
    this.recognition = recognition;
    this.setState(this.state === 'awake' ? 'awake' : 'starting');
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      this.restartTimer = setTimeout(() => this.spawn(), 800);
    }
  }

  handleError(event) {
    const code = event?.error;
    if (code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.wantListening = false;
      this.teardown();
      this.setState('denied');
      this.dispatchEvent(new CustomEvent('problem', { detail: { title: 'Microphone blocked', message: 'Allow microphone and speech recognition for this site in your browser settings, then turn voice commands on again.' } }));
      return;
    }
    if (code === 'audio-capture') {
      this.wantListening = false;
      this.teardown();
      this.setState('error');
      this.dispatchEvent(new CustomEvent('problem', { detail: { title: 'No microphone found', message: 'Connect or enable a microphone and try again.' } }));
      return;
    }
    if (code === 'network') {
      this.setState('error', { message: 'Speech service unreachable' });
      this.dispatchEvent(new CustomEvent('problem', { detail: { title: 'Speech service unreachable', message: 'Your browser sends speech to its recognition service, so an internet connection is needed. Sonora will keep retrying.' } }));
    }
  }

  // ---------------------------------------------------------------- recognition

  handleResult(event) {
    if (this.recordingTask) return;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternatives = Array.from(result, (item) => item.transcript).filter(Boolean);
      if (!alternatives.length) continue;
      this.processTranscript(alternatives, result.isFinal, i);
    }
  }

  processTranscript(alternatives, isFinal, index) {
    if (this.state === 'awake') {
      this.processAwake(alternatives, isFinal, index);
      return;
    }
    for (const transcript of alternatives) {
      const wake = detectWake(transcript, this.names());
      if (!wake.matched) continue;
      this.wakeIndex = index;
      this.wake();
      this.dispatchEvent(new CustomEvent('heard', { detail: { text: wake.rest || '', final: isFinal } }));
      if (wake.rest) this.considerCommand([wake.rest], isFinal);
      else if (isFinal) this.wakeIndex = index; // wait for the next utterance
      return;
    }
  }

  processAwake(alternatives, isFinal, index) {
    if (index === this.wakeIndex) {
      // Same utterance that contained the trigger phrase: only look at what follows it.
      const rests = alternatives.map((text) => detectWake(text, this.names())).filter((item) => item.matched && item.rest).map((item) => item.rest);
      if (rests.length) this.considerCommand(rests, isFinal);
      return;
    }
    this.considerCommand(alternatives, isFinal);
  }

  considerCommand(alternatives, isFinal) {
    this.dispatchEvent(new CustomEvent('heard', { detail: { text: alternatives[0], final: isFinal } }));
    clearTimeout(this.stableTimer);
    const run = () => {
      for (const text of alternatives) {
        const command = parseCommand(text);
        if (command) return this.execute(command, text);
      }
      if (isFinal) {
        this.say(`Sorry, I didn't get “${alternatives[0]}”`, 'error');
        this.finishCommand(false);
      }
      return undefined;
    };
    if (isFinal) {
      run();
    } else if (alternatives.some((text) => parseCommand(text))) {
      // Interim text that already forms a command: run it once it stops changing.
      this.stableTimer = setTimeout(run, STABLE_COMMAND_MS);
      this.armAwakeTimer();
    } else {
      this.armAwakeTimer();
    }
  }

  // ---------------------------------------------------------------- wake / feedback

  wake() {
    if (this.state === 'awake') return;
    this.setState('awake');
    this.engine.setDuck(DUCK_LEVEL);
    this.chime('up');
    this.armAwakeTimer();
  }

  armAwakeTimer() {
    clearTimeout(this.awakeTimer);
    this.awakeTimer = setTimeout(() => {
      if (this.state !== 'awake') return;
      this.finishCommand(false, { silent: true });
    }, AWAKE_TIMEOUT_MS);
  }

  clearAwake() {
    clearTimeout(this.awakeTimer);
    clearTimeout(this.stableTimer);
  }

  finishCommand(success, { silent = false } = {}) {
    this.clearAwake();
    this.engine.setDuck(1);
    if (!silent) this.chime(success ? 'ok' : 'down');
    if (this.wantListening) {
      this.setState('listening');
      // Restart the session so the finished utterance can't re-trigger anything.
      const recognition = this.recognition;
      if (recognition) { try { recognition.abort(); } catch { /* ignore */ } }
    }
  }

  ensureAudio() {
    if (this.audioContext || !this.settings.get('voiceSounds')) return;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContextClass) this.audioContext = new AudioContextClass();
  }

  chime(kind) {
    if (!this.settings.get('voiceSounds')) return;
    this.ensureAudio();
    const context = this.audioContext;
    if (!context) return;
    context.resume?.().catch(() => {});
    const notes = kind === 'up' ? [660, 880] : kind === 'ok' ? [880] : [440, 330];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * 0.09;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    });
  }

  // ---------------------------------------------------------------- commands

  async execute(command, heard = '') {
    this.clearAwake();
    this.dispatchEvent(new CustomEvent('command', { detail: { command, heard } }));
    let message = '';
    let ok = true;
    try {
      const { engine } = this;
      switch (command.type) {
        case 'next':
          message = 'Skipping to the next song';
          await engine.next(true);
          break;
        case 'previous':
          message = 'Going back';
          await engine.previous();
          break;
        case 'pause':
          message = 'Paused';
          engine.userPaused = true;
          engine.pause();
          break;
        case 'resume':
          message = 'Playing';
          if (engine.currentId) await engine.play();
          else await this.playFromLibrary(this.getOrderedIds()[0]);
          break;
        case 'playSong': {
          const match = findBestTrack(command.query, this.library.tracks);
          if (!match) {
            ok = false;
            message = `No song close to “${command.query}”`;
          } else {
            message = `Playing ${match.track.title}`;
            await this.playFromLibrary(match.track.id);
          }
          break;
        }
        case 'seek': {
          if (!engine.currentId) { ok = false; message = 'Nothing is playing'; break; }
          engine.seekBy(command.seconds);
          const phrase = describeSeconds(command.seconds);
          message = command.seconds >= 0 ? `Forward ${phrase}` : `Back ${phrase}`;
          break;
        }
        case 'shuffle':
          if (command.play) {
            await engine.shuffleAll(this.getOrderedIds());
            message = 'Shuffling your music';
          } else {
            engine.toggleShuffle(command.enabled);
            message = command.enabled ? 'Shuffle on' : 'Shuffle off';
          }
          break;
        case 'volume':
          engine.setVolume(engine.volume + command.delta);
          message = command.delta > 0 ? 'Volume up' : 'Volume down';
          break;
        case 'mute':
          engine.toggleMute(command.muted);
          message = command.muted ? 'Muted' : 'Unmuted';
          break;
        default:
          ok = false;
          message = 'Not supported';
      }
    } catch (error) {
      ok = false;
      message = error?.message || 'That did not work';
    }
    this.say(message, ok ? 'success' : 'error');
    this.finishCommand(ok);
  }

  async playFromLibrary(id) {
    if (!id) return;
    await this.engine.setQueue(this.getOrderedIds(), id, { autoplay: true });
  }

  // ---------------------------------------------------------------- trigger recording

  /**
   * Records the user saying their trigger name. Resolves with { name, variants }.
   * mode "add" merges the new spoken variants into the existing ones.
   */
  recordTriggerName({ mode = 'replace' } = {}) {
    if (!voiceSupported) return Promise.reject(new Error('This browser does not support speech recognition.'));
    if (this.recordingTask) return this.recordingTask;
    const wasListening = this.wantListening;
    this.wantListening = false;
    clearTimeout(this.restartTimer);
    this.clearAwake();
    this.engine.setDuck(DUCK_LEVEL);
    this.teardown();
    this.setState('recording');

    this.recordingTask = new Promise((resolve, reject) => {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 6;
      recognition.lang = navigator.language || 'en-US';
      let settled = false;
      let heard = [];
      const timeout = setTimeout(() => finish(new Error('I did not hear anything. Try again and speak clearly.')), 9000);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recognition.onresult = recognition.onend = recognition.onerror = null;
        try { recognition.abort(); } catch { /* ignore */ }
        this.recordingTask = null;
        this.engine.setDuck(1);
        if (error) reject(error);
        else {
          let cleaned = [...new Set(heard.map((text) => stripGreeting(text)).filter((text) => text && text.length <= 30))];
          // Keep only alternatives that sound like the best guess (or the existing name), so a stray
          // mis-hearing of a common word can't become a trigger.
          const anchor = mode === 'add' ? this.settings.get('wakeName') : cleaned[0];
          cleaned = cleaned.filter((text, index) => (mode !== 'add' && index === 0) || similarity(text, anchor) >= 0.55);
          if (!cleaned.length) reject(new Error('I could not make out a name. Try again.'));
          else {
            const previous = mode === 'add' ? [this.settings.get('wakeName'), ...this.settings.get('wakeVariants')] : [];
            const variants = [...new Set([...cleaned, ...previous])].slice(0, 10);
            const name = mode === 'add' ? this.settings.get('wakeName') : cleaned[0];
            resolve({ name, variants });
          }
        }
        if (wasListening) this.start();
        else this.setState('off');
      };

      recognition.onresult = (event) => {
        const result = event.results[event.results.length - 1];
        this.dispatchEvent(new CustomEvent('heard', { detail: { text: result[0]?.transcript || '', final: result.isFinal } }));
        if (result.isFinal) {
          heard = Array.from(result, (item) => item.transcript);
          finish();
        }
      };
      recognition.onerror = (event) => {
        if (event.error === 'no-speech') return finish(new Error('I did not hear anything. Try again and speak clearly.'));
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') return finish(new Error('Microphone access is blocked for this site.'));
        return finish(new Error('Speech recognition failed. Check your microphone and connection.'));
      };
      recognition.onend = () => finish();
      try {
        recognition.start();
        this.chime('up');
      } catch (error) {
        finish(error);
      }
    });
    return this.recordingTask;
  }
}
