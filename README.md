# Sonora — GitHub Pages Edition

Sonora is a private, local-first music player that runs as a static Progressive Web App on GitHub Pages. No Xcode, Node server, Mac launcher, or always-on computer is required after it is published.

## What this version does

- Imports one ZIP archive and finds every MP3 inside it
- Reads title, artist, album, duration, and embedded cover art
- Removes `.mp3` from fallback song titles
- Stores songs locally in the browser using IndexedDB
- Generates and caches real audio waveforms
- Click/drag waveform seeking
- Play, pause, previous, next, shuffle, repeat, mute, and volume controls
- Automatically starts the next song when the current song finishes
- Queue display with drag-to-reorder
- Media Session support for system, headphone, and lock-screen controls where the browser permits it
- Responsive layouts for macOS and iPad
- Installable PWA with included Sonora icons
- Offline app shell after the first successful visit
- **Queue is always your whole library and it loops.** Songs play in your chosen sort order; with Shuffle on they play in random order, and every lap reshuffles. Library has a one-tap **Shuffle** button.
- **Song transcripts** on the Now Playing screen: shows lyrics already inside the MP3 (synced when available), or generates a timed transcript on-device with Whisper. Lines highlight while the song plays and tapping a line jumps there.
- **Voice control** ("Hey Sonora" or your own trigger name): next / skip, `play <song name>`, `fast forward` / `move <time>`, rewind, previous, pause, resume, shuffle, volume
- Light mode, dark mode, accent colours, waveform styles, animation speed, contrast, reduced motion, and text sizing

## Voice control

Turn it on with the microphone button at the top (or Settings → Voice control). Say the trigger, wait for the chime, then speak a command. You can also say it in one go: "Hey Sonora, play Blinding Lights".

| Say | What happens |
| --- | --- |
| `next`, `skip`, `skip this song`, `play next` | Plays the next song |
| `play <name>` | Plays the song whose title is most similar to what you said |
| `fast forward 30`, `move 2 minutes`, `skip ahead 1 hour` | Jumps forward. A bare number means **seconds** |
| `rewind 15 seconds`, `go back 10` | Jumps back |
| `previous`, `pause`, `resume`, `shuffle`, `volume up/down` | Extras |

To change the trigger, go to Settings → Voice control → **Record name** and say the new name (for example "Jarvis"). **Add sample** records a second pronunciation so matching is more forgiving. Matching is fuzzy and sound-based, so near-misses still wake Sonora.

Notes:
- Speech recognition uses your browser's built-in service (Apple's in Safari, Google's in Chrome), which means microphone audio is sent to Apple or Google while voice commands are on. Sonora itself never uploads anything.
- It needs `https://` (GitHub Pages is fine) or `localhost`, plus microphone permission.
- Safari/iPadOS may pause listening when the app is in the background or the screen locks.
- Music playing out loud can drown out the trigger. Sonora lowers the volume while it listens, but headphones work best.

## Transcription

Open **Now Playing** and press **Transcribe**. If the MP3 already has lyrics inside it, Sonora shows those automatically. Otherwise it runs OpenAI's Whisper model in your browser using [transformers.js](https://github.com/huggingface/transformers.js).

- The first transcription downloads the model once (about 40 MB for Fast, 80 MB for Better) from jsDelivr / Hugging Face, then it is cached. Your audio is never uploaded.
- It runs on the CPU, so expect roughly the length of the song or less on a Mac or recent iPad.
- Whisper is built for speech, so heavily produced songs can have mistakes. Choose **Better** or set the language in Settings → Transcription for improved results.
- Transcripts are saved on the device. Settings can auto-transcribe each new song.

## Publish it with GitHub Pages

See [DEPLOY TO GITHUB.md](DEPLOY%20TO%20GITHUB.md) for step-by-step instructions.

The whole site is already built. Publish the repository root; there is no build command.

## Important storage behaviour

GitHub hosts only the Sonora application files. Your MP3s are **not uploaded to GitHub** by Sonora.

The imported library is stored separately on each device and in each browser profile. Import the music ZIP once on the Mac and once on the iPad. Keep the original ZIP as a backup because browsers may clear local website data when storage is low or when site data is manually removed.

## Installing as an app

### iPad

Open the GitHub Pages address in Safari, tap **Share**, choose **Add to Home Screen**, enable **Open as Web App**, and tap **Add**.

### Mac

Open the GitHub Pages address in Safari and choose **File → Add to Dock**. You can also use it directly in Safari or another modern browser.

## Updating Sonora

Replace the repository files with the updated files and commit the changes. The service worker uses a versioned cache and will replace the previous app shell.

## Local testing without Xcode

From this folder, run:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Do not open `index.html` directly with `file://`; browser modules and service workers require an HTTP or HTTPS origin.

## Verification

Run:

```bash
npm test
```

This checks JavaScript syntax, utility, metadata, voice-command, wake-phrase and queue/shuffle tests, required HTML IDs, the manifest, icons, relative GitHub Pages paths, and automatic-next playback wiring.

## Licence

MIT. See `LICENSE.txt`.
