<div align="center">
  <img src="docs/image/logo.png" alt="OSU Cubic Editor Logo" width="200"/>

  # OSU Cubic Editor

  A mapping editor tool for the Minecraft world **OSU Cubic** — a rhythm minigame.

  [![Live App](https://img.shields.io/badge/Live%20App-Visit-blue?style=for-the-badge)](https://ayahoii.github.io/osu_cubic_editor/)
</div>

---

## About

**OSU Cubic Editor** is a tool that allows users to map custom songs for OSU Cubic, a Minecraft rhythm minigame. With this editor, you can create song mappings and export them as ready-to-import `.js` files directly into OSU Cubic.

## Features

- Map custom songs visually
- Export mappings as `.js` files ready for OSU Cubic
- Runs entirely in the browser — no installation required

## Usage

1. Open the [Live App](https://ayahoii.github.io/osu_cubic_editor/)
2. Load your song and start mapping
3. Export the generated `.js` mapping file
4. Follow the steps below to install it in your OSU Cubic world

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