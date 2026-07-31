# Put Sonora on GitHub Pages

Once this is published, your Mac does **not** need to remain switched on. GitHub serves the app.

## 1. Extract the download

Unzip `Sonora-GitHub-Pages.zip` on your Mac.

## 2. Create a GitHub repository

1. Sign in to GitHub.
2. Create a new repository, for example `sonora`.
3. Do not add a starter README, licence, or `.gitignore`; those files are already included here.

## 3. Upload Sonora

1. Open the new repository.
2. Choose **Add file → Upload files**.
3. Drag **the contents inside** the extracted `Sonora-GitHub-Pages` folder onto the upload page.
4. Confirm that `index.html`, `src`, `assets`, `vendor`, `manifest.webmanifest`, and `service-worker.js` are visible at the top level.
5. Commit the upload to the `main` branch.

Do not upload your music ZIP or MP3 files to GitHub.

## 4. Turn on GitHub Pages

1. Open the repository's **Settings**.
2. Open **Pages**.
3. Under the publishing source, choose **Deploy from a branch**.
4. Select branch **main** and folder **/(root)**.
5. Save.

GitHub will display the published address when deployment is ready. It will normally look similar to:

```text
https://YOUR-USERNAME.github.io/sonora/
```

## 5. Use it on Mac

1. Open the published address.
2. Choose or drop in the ZIP containing your MP3 files.
3. In Safari, choose **File → Add to Dock** for an app-style window and the included Sonora icon.

## 6. Use it on iPad

1. Open the same published address in Safari.
2. Tap **Share → Add to Home Screen**.
3. Enable **Open as Web App** and tap **Add**.
4. Open Sonora from its new icon.
5. Import the ZIP from Files.

Music is stored separately on the iPad, so the iPad performs its own one-time import.

## Playback notes

- The next song starts automatically at the end of the current song.
- Repeat-one replays the same song.
- Repeat-all returns to the first song after the final queue item.
- Shuffle changes the queue while preserving the current song.
- Lock-screen, headphone, Control Center, and background behaviour depend on the browser and operating system. Add-to-Home-Screen mode gives iPadOS the best available web-app integration.
