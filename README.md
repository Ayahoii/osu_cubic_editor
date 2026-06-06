<div align="center">
  <img src="docs/image/logo.png" alt="OSU Cubic Editor Logo" width="200"/>

  # OSU Cubic Editor

  A mapping editor tool for the Minecraft world **OSU Cubic** — a rhythm minigame.

  [![Live App](https://img.shields.io/badge/Live%20App-Visit-blue?style=for-the-badge)](https://ayahoii.github.io/osu_cubic_editor/)
</div>

---

## About

**OSU Cubic Editor** is a web-based tool for creating beatmaps for OSU Cubic, a Minecraft rhythm minigame. With this editor, you can visually place notes on a timeline, auto-detect BPM from your audio, and export your beatmap as a ready-to-import `.js` file — or save your full project as a `.ocproj` file to continue editing later.

## Features

- Visual timeline beatmap editor
- Load audio and map notes to the beat
- Auto BPM detection — marks every beat automatically
- Multiple difficulty support (Easy / Normal / Hard / Expert)
- Export beatmap as `.js` for OSU Cubic
- Save and load full projects as `.ocproj` (includes embedded audio and cover art)
- Runs entirely in the browser — no installation required

## Usage

1. Open the [Live App](https://ayahoii.github.io/osu_cubic_editor/)
2. Create a new project and load your song audio
3. Map your notes on the timeline (use Auto BPM to help!)
4. Export the generated `.js` beatmap file
5. Follow the steps below to install it in your OSU Cubic world

---

## Installing a Custom Map in OSU Cubic

### Step 1 — Copy the mapping file

Place the exported `.js` file inside your OSU Cubic world's behavior pack:

```
behavior_packs/Rhythm/scripts/musics/custom/<your_mapping>.js
```

### Step 2 — Register the mapping in `import.js`

Open the file located at:

```
behavior_packs/Rhythm/scripts/musics/import.js
```

Add an import for your mapping at the top of the file, then register it in the `registry` object:

```javascript
import { tutorial } from "./tutorial.js";
import { your_mapping } from "./custom/your_mapping.js"; // 👈 add your import here

// --- Registry of all available songs ---
const registry = {
    tutorial,
    your_mapping, // 👈 add your mapping name here
};
```

> **Note:** The name used in the `registry` must match the exported name from your mapping file.

### Example

If your exported file is called `my_song.js`, it should look like:

```javascript
import { my_song } from "./custom/my_song.js";

const registry = {
    tutorial,
    my_song,
};
```