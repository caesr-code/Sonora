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
- Light mode, dark mode, accent colours, waveform styles, animation speed, contrast, reduced motion, and text sizing

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

This checks JavaScript syntax, utility and metadata tests, required HTML IDs, the manifest, icons, relative GitHub Pages paths, and automatic-next playback wiring.

## Licence

MIT. See `LICENSE.txt`.
