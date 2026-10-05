import { titleCase } from './voice-commands.js';
import { voiceSupported } from './voice-control.js';

const $ = (id) => document.getElementById(id);

/** Siri-style overlay, topbar microphone button and the Voice control settings card. */
export class VoiceUI {
  constructor({ voice, settings, ui }) {
    this.voice = voice;
    this.settings = settings;
    this.ui = ui;
    this.overlay = $('voiceOverlay');
    this.headline = $('voiceHeadline');
    this.transcript = $('voiceTranscript');
    this.toggleButton = $('voiceToggleButton');
    this.enabledSetting = $('voiceEnabledSetting');
    this.statusText = $('voiceStatusText');
    this.triggerLabel = $('voiceTriggerLabel');
    this.helpTrigger = $('voiceHelpTrigger');
    this.recordButton = $('recordTriggerButton');
    this.addSampleButton = $('addTriggerSampleButton');
    this.resetButton = $('resetTriggerButton');
    this.soundsSetting = $('voiceSoundsSetting');
    this.hideTimer = null;
    this.bind();
    this.syncSettings();
    this.renderState({ state: 'off' });
  }

  bind() {
    this.toggleButton.addEventListener('click', () => this.setEnabled(!this.settings.get('voiceEnabled')));
    this.enabledSetting.addEventListener('change', () => this.setEnabled(this.enabledSetting.checked));
    this.soundsSetting.addEventListener('change', () => this.settings.set('voiceSounds', this.soundsSetting.checked));
    this.recordButton.addEventListener('click', () => this.record('replace'));
    this.addSampleButton.addEventListener('click', () => this.record('add'));
    this.resetButton.addEventListener('click', () => {
      this.settings.patch({ wakeName: 'sonora', wakeVariants: [] });
      this.syncSettings();
      this.ui.toast('Trigger reset', 'Say “Hey Sonora” to wake Sonora.');
    });
    this.settings.addEventListener('change', () => this.syncSettings());

    this.voice.addEventListener('statechange', (event) => this.renderState(event.detail));
    this.voice.addEventListener('heard', (event) => {
      if (this.voice.state === 'awake' || this.voice.state === 'recording') this.transcript.textContent = event.detail.text ? `“${event.detail.text}”` : 'Say a command';
    });
    this.voice.addEventListener('feedback', (event) => this.showResult(event.detail.text, event.detail.kind));
    this.voice.addEventListener('problem', (event) => {
      this.ui.toast(event.detail.title, event.detail.message, 'error', 8000);
      this.settings.set('voiceEnabled', false);
    });
  }

  async setEnabled(enabled) {
    if (enabled) {
      this.settings.set('voiceEnabled', true);
      const started = await this.voice.start();
      if (!started) this.settings.set('voiceEnabled', false);
      else this.ui.toast('Voice commands on', `Say “${this.voice.triggerLabel}” then a command.`, 'success');
    } else {
      this.settings.set('voiceEnabled', false);
      this.voice.stop();
    }
    this.syncSettings();
  }

  async record(mode) {
    if (!voiceSupported) {
      this.ui.toast('Voice control unavailable', 'This browser does not support speech recognition.', 'error');
      return;
    }
    const prompt = mode === 'add' ? 'Say the name once more' : 'Say your trigger name';
    this.showOverlay(prompt, 'For example “Jarvis” or “Hey Jarvis”', '');
    try {
      const result = await this.voice.recordTriggerName({ mode });
      this.settings.patch({ wakeName: result.name, wakeVariants: result.variants });
      this.syncSettings();
      this.showResult(`Trigger set to “Hey ${titleCase(result.name)}”`, 'success');
      this.ui.toast('Trigger saved', `Sonora will wake when it hears something like “Hey ${titleCase(result.name)}”.`, 'success', 6000);
    } catch (error) {
      this.showResult(error.message || 'Could not record the name', 'error');
    }
  }

  syncSettings() {
    const name = titleCase(this.settings.get('wakeName'));
    this.triggerLabel.textContent = `Hey ${name}${this.settings.get('wakeVariants').length > 1 ? ` · ${this.settings.get('wakeVariants').length} recorded sounds` : ''}`;
    this.helpTrigger.textContent = `Hey ${name}`;
    this.enabledSetting.checked = this.settings.get('voiceEnabled');
    this.soundsSetting.checked = this.settings.get('voiceSounds');
    this.addSampleButton.disabled = !this.settings.get('wakeVariants').length && this.settings.get('wakeName') === 'sonora';
    this.recordButton.disabled = this.addSampleButton.disabled && false;
    this.resetButton.disabled = this.settings.get('wakeName') === 'sonora' && !this.settings.get('wakeVariants').length;
    this.renderState({ state: this.voice.state });
  }

  renderState({ state, message }) {
    const labels = {
      off: ['Voice commands are off', 'Turn on voice commands'],
      starting: ['Starting the microphone…', 'Voice commands starting'],
      listening: [`Listening for “${this.voice.triggerLabel}”`, 'Voice commands on'],
      awake: ['Listening…', 'Voice commands listening'],
      recording: ['Recording your trigger name…', 'Recording trigger name'],
      denied: ['Microphone blocked in browser settings', 'Voice commands blocked'],
      error: [message || 'Voice control hit a problem', 'Voice commands error'],
      unsupported: ['This browser does not support speech recognition', 'Voice commands unavailable'],
    };
    const [status, label] = labels[state] || labels.off;
    this.statusText.textContent = status;
    this.toggleButton.dataset.state = state;
    const on = ['starting', 'listening', 'awake', 'recording'].includes(state);
    this.toggleButton.setAttribute('aria-pressed', String(on));
    this.toggleButton.setAttribute('aria-label', on ? 'Turn off voice commands' : 'Turn on voice commands');
    this.toggleButton.title = label;
    this.enabledSetting.checked = on || this.settings.get('voiceEnabled');
    if (state === 'awake') this.showOverlay('Listening…', 'Say a command', '');
    else if (state === 'recording') { /* overlay already shown by record() */ }
    else if (!this.hideTimer && !this.overlay.classList.contains('success') && !this.overlay.classList.contains('error')) this.hideOverlay();
  }

  showOverlay(headline, transcript, kind) {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.headline.textContent = headline;
    this.transcript.textContent = transcript;
    this.overlay.classList.remove('success', 'error', 'leaving');
    if (kind) this.overlay.classList.add(kind);
    this.overlay.hidden = false;
  }

  showResult(text, kind) {
    const type = kind === 'error' ? 'error' : 'success';
    this.showOverlay(text, type === 'error' ? 'Try again after saying the trigger' : '', type);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hideOverlay();
    }, type === 'error' ? 2600 : 1700);
  }

  hideOverlay() {
    if (this.overlay.hidden) return;
    this.overlay.classList.add('leaving');
    const overlay = this.overlay;
    setTimeout(() => {
      if (overlay.classList.contains('leaving')) {
        overlay.hidden = true;
        overlay.classList.remove('leaving', 'success', 'error');
      }
    }, 240);
  }
}
