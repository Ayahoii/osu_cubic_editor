// ================================================
// OSU Cubic Editor — app.js
// Areas.Player1: xA:-6 xB:6 zA:-6 zB:6 y:0
// ================================================

const TPS = 20;          // Minecraft ticks per second
const FORMAT_VERSION = '1.0'; // Exported map format version
const GRID_MIN = -6;
const GRID_MAX = 6;
const GRID_SIZE = GRID_MAX - GRID_MIN + 1; // 13

// -------- State --------
const S = {
  screen: 'projects',
  projects: {},           // id → project
  project: null,          // current project
  diff: 'normal',         // current difficulty
  // Audio
  ctx: null,              // AudioContext
  buf: null,              // AudioBuffer
  src: null,              // current AudioBufferSourceNode
  ctxStartTime: 0,        // audioContext.currentTime when playback started
  playOffset: 0,          // audio offset (seconds) when play started
  playing: false,
  // Playback
  currentTime: 0,         // seconds (when paused)
  // Timeline
  pps: 80,                // pixels per second
  viewOff: 0,             // timeline scroll offset in seconds
  draggingSeek: false,
  // Selection (multi)
  selection: [],          // [{ tick, idx }, ...]
  // Drag states
  tlDrag: null,           // timeline drag: { mode:'noteDrag'|'boxSel'|'seek', ... }
  gridDrag: null,         // grid drag: { tick, idx, origX, origZ }
  gridPreview: false,
  // Undo history
  history: [],            // [{ diff, map, selection }] snapshots
  historyPtr: -1,         // current position in history
  // Visuals
  animId: null,
  flashCells: new Map(),  // 'x,z' → expire timestamp
};

const MAX_HISTORY = 100;

// -------- Undo --------
function pushUndo() {
  if (!S.project) return;
  // Discard any redo entries ahead of current pointer
  S.history.splice(S.historyPtr + 1);
  S.history.push({
    diff: S.diff,
    map:  JSON.parse(JSON.stringify(S.project.maps[S.diff] ?? {})),
    selection: [...S.selection],
  });
  if (S.history.length > MAX_HISTORY) S.history.shift();
  S.historyPtr = S.history.length - 1;
}

function undoLast() {
  if (!S.project || S.historyPtr < 0) { toast('Nothing to undo', '#888'); return; }
  const snap = S.history[S.historyPtr];
  S.historyPtr--;
  // Restore snapshot
  if (snap.diff !== S.diff) {
    S.diff = snap.diff;
    const sel = document.getElementById('difficulty-select');
    if (sel) sel.value = S.diff;
  }
  S.project.maps[snap.diff] = JSON.parse(JSON.stringify(snap.map));
  S.selection = snap.selection.filter(({ tick, idx }) =>
    S.project.maps[snap.diff][tick]?.[idx] !== undefined
  );
  updateNotePanel();
  updateBadge();
  toast('Undone', '#aaa');
}

// -------- Helpers --------
function fmt(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms  = Math.floor((s % 1) * 1000);
  return `${m}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cellKey(x, z) { return `${x},${z}`; }
function posColor() {
  return '#4fc3f7'; // light blue for all notes
}
function now_audio() {
  if (!S.playing || !S.ctx) return S.currentTime;
  return Math.min(S.playOffset + (S.ctx.currentTime - S.ctxStartTime),
                  S.buf?.duration ?? S.project?.duration ?? 120);
}
function curTick() { return Math.floor(now_audio() * TPS); }

// -------- Toast --------
let _toastTimer;
function toast(msg, color = '#dde0ee', duration = 2200) {
  const el = document.getElementById('toast');
  el.style.color = color;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
}

// -------- LocalStorage --------
function loadProjects() {
  try { return JSON.parse(localStorage.getItem('osu_cubic_editor_v2') || '{}'); }
  catch { return {}; }
}
function saveProjects() {
  try { localStorage.setItem('osu_cubic_editor_v2', JSON.stringify(S.projects)); }
  catch(e) { toast('Save error: ' + e.message, '#f44'); }
}

// -------- Project schema --------
function mkProject(d = {}) {
  return {
    id:             d.id || String(Date.now()),
    format_version: d.format_version || FORMAT_VERSION,
    name:           d.name         || 'New Song',
    artist:       d.artist       || '',
    icon:         d.icon         || '',
    audioMusicId: d.audioMusicId || '',
    audioPreviewId: d.audioPreviewId || '',
    duration:     Number(d.duration) || 120,
    blockplace:   d.blockplace   || 'minecraft:red_wool',
    maps:         d.maps         || { normal: {} },
    createdAt:    d.createdAt    || Date.now(),
  };
}
function getMap() {
  if (!S.project) return {};
  if (!S.project.maps[S.diff]) S.project.maps[S.diff] = {};
  return S.project.maps[S.diff];
}
function countNotes(project) {
  let n = 0;
  for (const d of Object.values(project.maps||{})) for (const ns of Object.values(d)) n += ns.length;
  return n;
}

// -------- Screen --------
function showScreen(name) {
  document.getElementById('screen-projects').classList.toggle('hidden', name !== 'projects');
  document.getElementById('screen-editor').classList.toggle('hidden', name !== 'editor');
  S.screen = name;
}

// -------- Projects Screen --------
function renderProjectList() {
  const list = document.getElementById('project-list');
  const ids = Object.keys(S.projects).sort((a,b) => (S.projects[b].createdAt||0) - (S.projects[a].createdAt||0));
  if (!ids.length) {
    list.innerHTML = '<div class="list-empty">No projects yet.<br>Click "+ New Project" to get started.</div>';
    return;
  }
  list.innerHTML = '';
  for (const id of ids) {
    const p = S.projects[id];
    const el = document.createElement('div');
    el.className = 'project-card';
    const iconHtml = p.iconDataUrl
      ? `<img class="pc-cover" src="${p.iconDataUrl}" alt="">`
      : '<div class="pc-cover pc-cover-fallback">♪</div>';
    el.innerHTML = `
      ${iconHtml}
      <div style="min-width:0;flex:1">
        <div class="pc-name">${esc(p.name)}</div>
        <div class="pc-meta">${esc(p.artist)} — ${p.duration}s — ${countNotes(p)} notes</div>
      </div>
      <div class="pc-acts">
        <button class="btn btn-sm btn-accent" onclick="openProject('${id}')">Edit</button>
        <button class="btn btn-sm btn-danger"  onclick="delProject('${id}')">✕</button>
      </div>`;
    list.appendChild(el);
  }
}
function openNewProjectModal() {
  document.getElementById('modal-new-project').classList.remove('hidden');
  setTimeout(() => document.getElementById('np-name').focus(), 50);
}
function closeNewProjectModal() {
  document.getElementById('modal-new-project').classList.add('hidden');
}
function handleCreateProject() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { toast('Name is required', '#f44'); return; }
  const p = mkProject({
    name,
    artist:         document.getElementById('np-artist').value.trim(),
    icon:           document.getElementById('np-icon').value.trim(),
    audioMusicId:   document.getElementById('np-audio-id').value.trim(),
    audioPreviewId: document.getElementById('np-preview-id').value.trim(),
    duration:       document.getElementById('np-duration').value,
    blockplace:     document.getElementById('np-blockplace').value.trim(),
  });
  S.projects[p.id] = p;
  saveProjects();
  closeNewProjectModal();
  openProject(p.id);
}
function delProject(id) {
  if (!confirm(`Delete "${S.projects[id]?.name}"?`)) return;
  delete S.projects[id];
  saveProjects();
  renderProjectList();
}

// -------- Open editor --------
function openProject(id) {
  const p = S.projects[id];
  if (!p) return;
  S.project = p;
  S.diff = Object.keys(p.maps)[0] || 'normal';
  S.currentTime = 0;
  S.viewOff = 0;
  S.sel = null;
  S.playing = false;
  stopAudio(true);
  S.buf = null;

  showScreen('editor');
  document.getElementById('header-project-name').textContent = p.name + (p.artist ? ' — ' + p.artist : '');
  document.getElementById('difficulty-select').value = S.diff;
  document.getElementById('audio-status').textContent = 'No audio — click 🎵 Audio to load';
  buildGrid();
  updateBadge();
  updateNotePanel();  updateMetaPanel();
  updateMusicIconHeader();
  switchInfoTab('note');  updateSeekBar();
  updateTimeDisplay();
  resizeTimeline();
  startAnim();  // Restore saved audio if available
  if (p.audioDataUrl) restoreAudio(p);}

// -------- Info Panel Tabs --------
function switchInfoTab(tab) {
  const noteBtn    = document.getElementById('tab-note');
  const metaBtn    = document.getElementById('tab-meta');
  const noteContent = document.getElementById('tab-note-content');
  const metaContent = document.getElementById('tab-meta-content');
  if (tab === 'note') {
    noteBtn.classList.add('active');    metaBtn.classList.remove('active');
    noteContent.classList.remove('hidden'); metaContent.classList.add('hidden');
  } else {
    metaBtn.classList.add('active');    noteBtn.classList.remove('active');
    metaContent.classList.remove('hidden'); noteContent.classList.add('hidden');
    updateMetaPanel();
  }
}

// -------- Metadata --------
function updateMetaPanel() {
  if (!S.project) return;
  const p = S.project;
  document.getElementById('meta-name').value       = p.name         || '';
  document.getElementById('meta-artist').value     = p.artist       || '';
  document.getElementById('meta-icon').value       = p.icon         || '';
  document.getElementById('meta-blockplace').value = p.blockplace   || 'minecraft:red_wool';
  document.getElementById('meta-duration').value   = p.duration     || 120;
  document.getElementById('meta-audio-id').value   = p.audioMusicId || '';
  document.getElementById('meta-preview-id').value = p.audioPreviewId || '';
  // Preview icon
  const preview = document.getElementById('meta-icon-preview');
  preview.innerHTML = '';
  if (p.iconDataUrl) {
    const img = document.createElement('img');
    img.src = p.iconDataUrl;
    preview.appendChild(img);
  }
}

function applyMetaProps() {
  if (!S.project) return;
  const p = S.project;
  p.name          = document.getElementById('meta-name').value.trim();
  p.artist        = document.getElementById('meta-artist').value.trim();
  p.icon          = document.getElementById('meta-icon').value.trim();
  p.blockplace    = document.getElementById('meta-blockplace').value.trim() || 'minecraft:red_wool';
  p.duration      = Number(document.getElementById('meta-duration').value) || 120;
  p.audioMusicId  = document.getElementById('meta-audio-id').value.trim();
  p.audioPreviewId = document.getElementById('meta-preview-id').value.trim();
  // Update header title
  document.getElementById('header-project-name').textContent =
    p.name + (p.artist ? ' \u2014 ' + p.artist : '');
  saveProject();
  toast('Metadata saved!', '#4caf50');
}

function setDurationFromAudio() {
  if (!S.buf) { toast('Load an audio file first', '#f5a623'); return; }
  const d = Math.ceil(S.buf.duration);
  document.getElementById('meta-duration').value = d;
  if (S.project) S.project.duration = d;
  toast(`Duration set: ${d}s`, '#4fc3f7');
}

function loadIconImage(file) {
  const rd = new FileReader();
  rd.onload = ev => {
    if (!S.project) return;
    S.project.iconDataUrl = ev.target.result;
    updateMetaPanel();
    updateMusicIconHeader();
    toast('Image loaded!', '#4caf50');
  };
  rd.readAsDataURL(file);
}

function updateMusicIconHeader() {
  const img = document.getElementById('music-icon-img');
  if (!img) return;
  if (S.project?.iconDataUrl) {
    img.src = S.project.iconDataUrl;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }
}

// -------- Block Grid --------
function buildGrid() {
  const grid = document.getElementById('block-grid');
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${GRID_SIZE}, var(--cell-size))`;
  grid.style.gridTemplateRows    = `repeat(${GRID_SIZE}, var(--cell-size))`;

  // z increases downward visually (z=GRID_MIN at top)
  for (let z = GRID_MIN; z <= GRID_MAX; z++) {
    for (let x = GRID_MIN; x <= GRID_MAX; x++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      // Chess pattern: center (0,0) = dark. A cell is dark when (x+z) is even.
      const isDark = (x + z) % 2 === 0;
      if (isDark) cell.classList.add('is-dark');
      if (x === 0 && z === 0) cell.classList.add('is-center');
      cell.id = `c${x}_${z}`;
      cell.title = `x:${x}  z:${z}`;

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      cell.appendChild(bubble);

      // Click: add note or select existing
      cell.addEventListener('click', () => {
        if (S._gridDragMoved) { S._gridDragMoved = false; return; }
        onGridCellClick(x, z);
      });

      // Prevent browser's native drag (text/image) from interfering
      cell.addEventListener('dragstart', e => e.preventDefault());
      bubble.addEventListener('dragstart', e => e.preventDefault());

      // Mousedown: start potential note drag
      cell.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const tick = curTick();
        const map  = getMap();
        const ns   = map[tick];
        const idx  = ns ? ns.findIndex(n => n.x === x && n.z === z) : -1;
        if (idx !== -1) {
          S.gridDrag = { tick, idx, origX: x, origZ: z };
          S._gridDragMoved = false;
        }
      });

      // Mouseenter: update grid drag target
      cell.addEventListener('mouseenter', () => {
        if (!S.gridDrag) return;
        if (x !== S.gridDrag.origX || z !== S.gridDrag.origZ) {
          S.gridDrag.targetX = x;
          S.gridDrag.targetZ = z;
          S._gridDragMoved = true;
          // Highlight target cell
          document.querySelectorAll('.grid-cell.drag-target').forEach(el => el.classList.remove('drag-target'));
          cell.classList.add('drag-target');
        }
      });

      grid.appendChild(cell);
    }
  }
}

function onGridCellClick(x, z) {
  if (!S.project) return;
  const tick = curTick();
  const map = getMap();
  if (!map[tick]) map[tick] = [];
  // If note exists at this cell+tick, select it
  const idx = map[tick].findIndex(n => n.x === x && n.z === z);
  if (idx !== -1) { selectNote(tick, idx); return; }
  // Otherwise add note
  pushUndo();
  const note = { x, z, type: 'normal', sound: '', event: '', lyric: '' };
  map[tick].push(note);
  flashCell(x, z);
  updateBadge();
  selectNote(tick, map[tick].length - 1);
  toast(`Note added — tick ${tick}  (${(tick/TPS).toFixed(2)}s)`, '#4fc3f7');
}

function updateGridVisuals() {
  if (!S.project) return;
  const map = getMap();
  const ct = curTick();
  const WIN = TPS * 1.5;

  // Highlight selected cells in grid (works for single or multi selection)
  const selectedKeys = new Set(
    S.selection
      .map(s => map[s.tick]?.[s.idx])
      .filter(Boolean)
      .map(n => cellKey(n.x, n.z))
  );
  document.querySelectorAll('.grid-cell.is-selected').forEach(el => el.classList.remove('is-selected'));

  for (let z = GRID_MIN; z <= GRID_MAX; z++) {
    for (let x = GRID_MIN; x <= GRID_MAX; x++) {
      const cell = document.getElementById(`c${x}_${z}`);
      if (!cell) continue;
      cell.classList.toggle('is-selected', selectedKeys.has(cellKey(x, z)));
      const bubble = cell.querySelector('.bubble');
      let best = 0, bestColor = '';
      let atCurrent = false;

      for (const [ts, notes] of Object.entries(map)) {
        const t = parseInt(ts);
        const d = Math.abs(t - ct);
        if (d > WIN) continue;
        for (const n of notes) {
          if (n.x !== x || n.z !== z) continue;
          const op = 1 - d / WIN;
          if (op > best) { best = op; bestColor = posColor(x, z); atCurrent = d < 4; }
        }
      }

      const fk = cellKey(x, z);
      if (S.flashCells.has(fk)) {
        if (Date.now() < S.flashCells.get(fk)) { best = 1; bestColor = '#fff'; atCurrent = true; }
        else S.flashCells.delete(fk);
      }

      if (best > 0.02) {
        bubble.style.opacity   = String(best);
        bubble.style.background = bestColor;
        const sz = atCurrent ? '15px' : `${Math.round(best * 10)}px`;
        bubble.style.width     = sz;
        bubble.style.height    = sz;
        bubble.style.boxShadow = atCurrent ? `0 0 7px ${bestColor}` : '';
        bubble.style.border    = atCurrent ? '2px solid #fff' : 'none';
      } else {
        bubble.style.opacity = '0';
      }
    }
  }
  document.getElementById('grid-tick-display').textContent =
    `Tick: ${curTick()} | ${now_audio().toFixed(2)}s`;
}

function flashCell(x, z) {
  S.flashCells.set(cellKey(x, z), Date.now() + 380);
  const cell = document.getElementById(`c${x}_${z}`);
  if (!cell) return;
  const ring = document.createElement('div');
  ring.className = 'flash-ring';
  cell.appendChild(ring);
  setTimeout(() => ring.remove(), 400);
}

// -------- Note management --------
function selectNote(tick, idx, add = false) {
  const map = getMap();
  if (!map[tick] || !map[tick][idx]) return;
  if (add) {
    const i = S.selection.findIndex(s => s.tick === tick && s.idx === idx);
    if (i !== -1) S.selection.splice(i, 1);
    else S.selection.push({ tick, idx });
  } else {
    S.selection = [{ tick, idx }];
  }
  updateNotePanel();
  if (S.selection.length === 1) flashCell(map[tick][idx].x, map[tick][idx].z);
}
function clearSelection() {
  S.selection = [];
  updateNotePanel();
}
function deselectNote() { clearSelection(); }
function deleteSelectedNote() {
  if (!S.selection.length) return;
  pushUndo();
  const map = getMap();
  const sorted = [...S.selection].sort((a,b) => b.tick - a.tick || b.idx - a.idx);
  let count = 0;
  for (const { tick, idx } of sorted) {
    if (!map[tick]) continue;
    map[tick].splice(idx, 1);
    if (!map[tick].length) delete map[tick];
    count++;
  }
  clearSelection();
  updateBadge();
  toast(count > 1 ? `${count} notes deleted` : 'Note deleted', '#f44');
}

function clearDiffNotes() {
  if (!S.project) return;
  if (!confirm(`Delete ALL notes from "${S.diff}"?\nYou can undo with Ctrl+Z.`)) return;
  pushUndo();
  S.project.maps[S.diff] = {};
  clearSelection();
  updateBadge();
  toast(`All notes from ${S.diff} deleted`, '#f44');
}

function applyNoteProps() {
  if (!S.selection.length) return;
  pushUndo();
  const map = getMap();
  const notes = S.selection.map(s => map[s.tick]?.[s.idx]).filter(Boolean);
  if (!notes.length) return;
  for (const f of ['type','sound','event','lyric']) {
    const el = document.getElementById('prop-' + f);
    if (el.dataset.mixed === '1' && el.value === '') continue; // skip unchanged mixed
    el.dataset.mixed = '';
    for (const note of notes) note[f] = el.value;
  }
  toast(notes.length > 1 ? `${notes.length} notes updated` : 'Properties applied', '#4caf50');
}

function updateNotePanel() {
  const panelTitle = document.querySelector('#info-panel .panel-bar .panel-title');
  const empty = document.getElementById('note-props-empty');
  const form  = document.getElementById('note-props-form');
  if (!S.selection.length) {
    if (panelTitle) panelTitle.textContent = 'Selected Note';
    empty.classList.remove('hidden'); form.classList.add('hidden'); return;
  }
  const map = getMap();
  const pairs = S.selection.map(s => ({ s, note: map[s.tick]?.[s.idx] })).filter(p => p.note);
  if (!pairs.length) { clearSelection(); return; }
  if (panelTitle) panelTitle.textContent = pairs.length === 1 ? 'Selected Note' : `${pairs.length} Notes`;
  empty.classList.add('hidden');
  form.classList.remove('hidden');
  if (pairs.length === 1) {
    const { s, note } = pairs[0];
    document.getElementById('prop-tick').value  = s.tick;
    document.getElementById('prop-x').value     = note.x;
    document.getElementById('prop-z').value     = note.z;
    for (const f of ['type','sound','event','lyric']) {
      const el = document.getElementById('prop-' + f);
      el.value = note[f] || '';
      el.placeholder = f === 'type' ? 'normal' : '';
      el.dataset.mixed = '';
    }
  } else {
    document.getElementById('prop-tick').value = `${pairs.length} notes`;
    document.getElementById('prop-x').value    = '';
    document.getElementById('prop-z').value    = '';
    for (const f of ['type','sound','event','lyric']) {
      const vals = [...new Set(pairs.map(p => p.note[f] || ''))];
      const el   = document.getElementById('prop-' + f);
      if (vals.length === 1) {
        el.value = vals[0]; el.placeholder = ''; el.dataset.mixed = '';
      } else {
        el.value = ''; el.placeholder = '{mixed}'; el.dataset.mixed = '1';
      }
    }
  }
}
function updateBadge() {
  if (!S.project) return;
  const map = getMap();
  let c = 0; for (const ns of Object.values(map)) c += ns.length;
  document.getElementById('note-count-badge').textContent = c + ' notes';
  document.getElementById('timeline-diff-label').textContent = S.diff.toUpperCase();
}

// -------- Audio --------
async function restoreAudio(p) {
  try {
    if (!p.audioDataUrl) return;
    if (!S.ctx) S.ctx = new AudioContext();
    const res = await fetch(p.audioDataUrl);
    const ab  = await res.arrayBuffer();
    S.buf = await S.ctx.decodeAudioData(ab);
    document.getElementById('audio-status').textContent =
      `\ud83c\udfb5 ${p.audioFileName || 'saved audio'}  (${fmt(S.buf.duration)})`;
  } catch(e) {
    document.getElementById('audio-status').textContent = 'Error restoring audio — please reload the file';
    console.warn('restoreAudio:', e);
  }
}

async function loadAudio(file) {
  try {
    if (!S.ctx) S.ctx = new AudioContext();
    const ab = await file.arrayBuffer();
    // Save as base64 in project so it persists
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = 'data:audio/ogg;base64,' + btoa(bin);
    S.buf = await S.ctx.decodeAudioData(ab.slice(0)); // slice to keep reference
    if (S.project) {
      S.project.audioDataUrl  = b64;
      S.project.audioFileName = file.name;
    }
    document.getElementById('audio-status').textContent =
      `🎵 ${file.name}  (${fmt(S.buf.duration)})`;
    if (!S.project.duration || S.project.duration <= 5)
      S.project.duration = Math.ceil(S.buf.duration);
    toast(`Audio loaded: ${file.name}`, '#4caf50');
  } catch(e) { toast('Error loading audio: ' + e.message, '#f44'); }
}

function playAudio(offset) {
  if (!S.buf) { toast('Load an audio file first', '#f5a623'); return; }
  stopAudio(true);
  if (S.ctx.state === 'suspended') S.ctx.resume();
  const off = Math.max(0, Math.min(offset ?? S.currentTime, S.buf.duration - 0.01));
  S.src = S.ctx.createBufferSource();
  S.src.buffer = S.buf;
  S.src.connect(S.ctx.destination);
  S.src.start(0, off);
  S.ctxStartTime = S.ctx.currentTime;
  S.playOffset   = off;
  S.playing      = true;
  S.src.onended  = () => {
    if (S.playing) { S.playing = false; S.currentTime = S.buf.duration; updatePlayBtn(); }
  };
  updatePlayBtn();
}

function stopAudio(keepPos = false) {
  if (!keepPos) S.currentTime = now_audio();
  if (S.src) { try { S.src.stop(); } catch {} S.src = null; }
  S.playing = false;
  updatePlayBtn();
}

function togglePlay() {
  if (!S.buf) { toast('Load an audio file first', '#f5a623'); return; }
  if (S.playing) { S.currentTime = now_audio(); stopAudio(true); }
  else playAudio(S.currentTime);
}

function seekTo(sec) {
  const was = S.playing;
  S.currentTime = Math.max(0, Math.min(sec, S.project?.duration || 120));
  stopAudio(true);
  if (was) playAudio(S.currentTime);
  updateSeekBar();
  updateTimeDisplay();
}

function rewind() {
  const was = S.playing;
  stopAudio(true);
  S.currentTime = 0;
  if (was) playAudio(0);
  updateSeekBar(); updateTimeDisplay();
}

function updatePlayBtn() {
  const btn = document.getElementById('btn-play-pause');
  btn.textContent = S.playing ? '⏸' : '▶';
  btn.classList.toggle('paused', S.playing);
}
function updateSeekBar() {
  const dur = S.project?.duration || 120;
  const pct = Math.min(100, Math.max(0, now_audio() / dur * 100));
  document.getElementById('seekbar-fill').style.width  = pct + '%';
  document.getElementById('seekbar-thumb').style.left  = pct + '%';
}
function updateTimeDisplay() {
  const dur = S.project?.duration || 120;
  document.getElementById('time-display').textContent =
    `${fmt(now_audio())} / ${fmt(dur)}`;
}

function handleSeekClick(e) {
  const track = document.getElementById('seekbar-track');
  const r = track.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  seekTo(pct * (S.project?.duration || 120));
}

// -------- Timeline --------
function resizeTimeline() {
  const wrap   = document.getElementById('timeline-wrap');
  const canvas = document.getElementById('timeline-canvas');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

function renderTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;

  const map  = getMap();
  const ct   = now_audio();
  const dur  = S.project?.duration || 120;
  const pps  = S.pps;
  const HEAD_H = 18;

  // Auto-scroll when playing
  if (S.playing) {
    const px = ct * pps;
    if (px - S.viewOff * pps > W * 0.7) S.viewOff = (px - W * 0.3) / pps;
    if (px - S.viewOff * pps < W * 0.15) S.viewOff = (px - W * 0.5) / pps;
    S.viewOff = Math.max(0, Math.min(S.viewOff, dur - W / pps));
  }

  const offPx = S.viewOff * pps; // pixel offset

  // Background
  ctx.fillStyle = '#0b0b18';
  ctx.fillRect(0, 0, W, H);

  // Z-rows
  const numZ  = GRID_SIZE; // 13 rows
  const rowH  = (H - HEAD_H) / numZ;
  for (let zi = 0; zi < numZ; zi++) {
    const z    = GRID_MIN + zi;
    const rowY = HEAD_H + zi * rowH;
    ctx.fillStyle = zi % 2 === 0 ? '#0e0e1e' : '#101020';
    ctx.fillRect(0, rowY, W, rowH);
    // z label
    ctx.fillStyle = '#334';
    ctx.font = '9px monospace';
    ctx.fillText(`z${z < 0 ? z : '+'+z}`, 3, rowY + rowH * 0.5 + 3);
  }

  // Second tick marks & labels
  for (let t = 0; t <= dur; t++) {
    const x = t * pps - offPx;
    if (x < -2 || x > W + 2) continue;
    const major = t % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(x, HEAD_H);
    ctx.lineTo(x, H);
    ctx.strokeStyle = major ? '#22224a' : '#181830';
    ctx.lineWidth = major ? 1 : 0.5;
    ctx.stroke();
    if (major) {
      ctx.fillStyle = '#445';
      ctx.font = '9px monospace';
      ctx.fillText(fmt(t), x + 2, 12);
    }
  }

  // Notes
  const noteR = Math.max(2.5, rowH * 0.36);
  for (const [ts, notes] of Object.entries(map)) {
    const tick = parseInt(ts);
    const sec  = tick / TPS;
    let x = sec * pps - offPx;

    // If being dragged, draw at dragged position
    const isDragSrc = S.tlDrag?.mode === 'noteDrag' && S.tlDrag.origTick === tick;
    if (isDragSrc) {
      x = (S.tlDrag.currentTick / TPS) * pps - offPx;
    }
    if (x < -noteR * 2 || x > W + noteR * 2) continue;

    for (let noteIdx = 0; noteIdx < notes.length; noteIdx++) {
      const note  = notes[noteIdx];
      const zi    = note.z - GRID_MIN;
      const rowY  = HEAD_H + zi * rowH;
      const cy    = rowY + rowH * 0.5;
      const color = posColor(note.x, note.z);
      const isSel = S.selection.some(s => s.tick === tick && s.idx === noteIdx);
      const isGhost = isDragSrc;

      ctx.globalAlpha = isGhost ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(x, cy, isSel ? noteR + 2.5 : noteR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }

  // Box-select rectangle
  if (S.tlDrag?.mode === 'boxSel') {
    const { x0, y0, x1, y1 } = S.tlDrag;
    const bx = Math.min(x0,x1), by = Math.min(y0,y1);
    const bw = Math.abs(x1-x0), bh = Math.abs(y1-y0);
    ctx.fillStyle = 'rgba(79,195,247,.07)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.setLineDash([3,3]);
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
  }

  // Playhead
  const phX = ct * pps - offPx;
  ctx.beginPath();
  ctx.moveTo(phX, 0);
  ctx.lineTo(phX, H);
  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(phX - 6, 0);
  ctx.lineTo(phX + 6, 0);
  ctx.lineTo(phX, 10);
  ctx.closePath();
  ctx.fillStyle = '#ff4444';
  ctx.fill();
}

function _tlCoords(e) {
  const canvas = document.getElementById('timeline-canvas');
  const r  = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  const H  = canvas.height;
  const HEAD_H = 18;
  const numZ = GRID_SIZE;
  const rowH = (H - HEAD_H) / numZ;
  const sec  = (mx + S.viewOff * S.pps) / S.pps;
  const tick = Math.round(sec * TPS);
  const zi   = Math.floor((my - HEAD_H) / rowH);
  return { mx, my, sec, tick, zi, rowH, HEAD_H, H };
}

function _findNoteAt(tick, zi, mx) {
  const map  = getMap();
  const pps  = S.pps;
  const TOL  = 8;
  for (let dt = -3; dt <= 3; dt++) {
    const t  = tick + dt;
    const ns = map[t];
    if (!ns) continue;
    const nx = (t / TPS) * pps - S.viewOff * pps;
    if (Math.abs(nx - mx) > TOL + 4) continue;
    for (let i = 0; i < ns.length; i++) {
      if (ns[i].z - GRID_MIN === zi) return { tick: t, idx: i };
    }
  }
  return null;
}

function onTimelineMouseDown(e) {
  if (!S.project || e.button !== 0) return;
  const { mx, my, sec, tick, zi, rowH, HEAD_H } = _tlCoords(e);
  const canvas = document.getElementById('timeline-canvas');
  canvas.style.cursor = 'grabbing';

  const found = (zi >= 0 && zi < GRID_SIZE) ? _findNoteAt(tick, zi, mx) : null;

  if (found) {
    // Start note drag
    selectNote(found.tick, found.idx, e.shiftKey);
    S.tlDrag = { mode: 'noteDrag', origTick: found.tick, idx: found.idx,
                 tick: found.tick, startMx: mx, currentTick: found.tick };
  } else if (zi >= 0 && zi < GRID_SIZE) {
    // Drag in row area → box select
    S.tlDrag = { mode: 'boxSel', x0: mx, y0: my, x1: mx, y1: my };
  } else {
    // Header area → seek
    S.tlDrag = { mode: 'seek' };
    seekTo(Math.max(0, sec));
  }
  e.preventDefault();
}

function onTimelineMouseMove(e) {
  if (!S.project) return;
  const canvas = document.getElementById('timeline-canvas');
  const { mx, my, sec, tick, zi } = _tlCoords(e);

  // Update cursor hint when not dragging
  if (!S.tlDrag) {
    const found = (zi >= 0 && zi < GRID_SIZE) ? _findNoteAt(tick, zi, mx) : null;
    canvas.style.cursor = found ? 'grab' : (zi < 0 ? 'ew-resize' : 'crosshair');
    return;
  }

  if (S.tlDrag.mode === 'seek') {
    seekTo(Math.max(0, sec));
  } else if (S.tlDrag.mode === 'noteDrag') {
    const deltaTick = Math.round((mx - S.tlDrag.startMx) / S.pps * TPS);
    S.tlDrag.currentTick = Math.max(0, S.tlDrag.origTick + deltaTick);
  } else if (S.tlDrag.mode === 'boxSel') {
    S.tlDrag.x1 = mx;
    S.tlDrag.y1 = my;
  }
}

function onTimelineMouseUp(e) {
  if (!S.tlDrag) return;
  const canvas = document.getElementById('timeline-canvas');
  const { mx, my, sec, tick: upTick, zi } = _tlCoords(e);
  canvas.style.cursor = 'crosshair';

  if (S.tlDrag.mode === 'noteDrag') {
    const newTick = S.tlDrag.currentTick;
    if (newTick !== S.tlDrag.origTick) {
      pushUndo();
      const map = getMap();
      const note = map[S.tlDrag.origTick]?.[S.tlDrag.idx];
      if (note) {
        map[S.tlDrag.origTick].splice(S.tlDrag.idx, 1);
        if (!map[S.tlDrag.origTick].length) delete map[S.tlDrag.origTick];
        if (!map[newTick]) map[newTick] = [];
        map[newTick].push(note);
        const newIdx = map[newTick].length - 1;
        S.selection = [{ tick: newTick, idx: newIdx }];
        updateNotePanel();
        updateBadge();
        toast(`Note moved → tick ${newTick}  (${(newTick/TPS).toFixed(2)}s)`, '#4fc3f7');
      }
    } else if (Math.abs(mx - S.tlDrag.startMx) < 4) {
      // No movement: it was a click
      if (!e.shiftKey) seekTo(S.tlDrag.origTick / TPS);
    }

  } else if (S.tlDrag.mode === 'boxSel') {
    const { x0, y0, x1, y1 } = S.tlDrag;
    const minX = Math.min(x0,x1), maxX = Math.max(x0,x1);
    const minY = Math.min(y0,y1), maxY = Math.max(y0,y1);
    if (Math.abs(x1-x0) > 6 || Math.abs(y1-y0) > 6) {
      const canvas2 = document.getElementById('timeline-canvas');
      const H = canvas2.height;
      const HEAD_H = 18;
      const rowH = (H - HEAD_H) / GRID_SIZE;
      const map = getMap();
      const newSel = [];
      for (const [ts, notes] of Object.entries(map)) {
        const t  = parseInt(ts);
        const nx = (t / TPS) * S.pps - S.viewOff * S.pps;
        if (nx < minX || nx > maxX) continue;
        for (let i = 0; i < notes.length; i++) {
          const cy = HEAD_H + (notes[i].z - GRID_MIN) * rowH + rowH / 2;
          if (cy >= minY && cy <= maxY) newSel.push({ tick: t, idx: i });
        }
      }
      if (newSel.length) {
        if (e.shiftKey) S.selection = [...S.selection, ...newSel];
        else S.selection = newSel;
        updateNotePanel();
        toast(`${S.selection.length} note(s) selected`, '#4fc3f7');
      }
    } else {
      // Tiny drag = click: seek
      seekTo(Math.max(0, (mx + S.viewOff * S.pps) / S.pps));
    }
  }

  S.tlDrag = null;
}

function onTimelineScroll(e) {
  e.preventDefault();
  const dur = S.project?.duration || 120;
  S.viewOff = Math.max(0, Math.min(S.viewOff + e.deltaY / S.pps * 2, dur));
}

// Timeline right-click: delete note
function onTimelineContextMenu(e) {
  e.preventDefault();
  if (!S.project) return;
  const { tick, zi, mx } = _tlCoords(e);
  if (zi < 0 || zi >= GRID_SIZE) return;
  const found = _findNoteAt(tick, zi, mx);
  if (!found) return;
  S.selection = [found];
  deleteSelectedNote();
}

// -------- Animation Loop --------
function startAnim() {
  if (S.animId) cancelAnimationFrame(S.animId);
  function frame() {
    renderTimeline();
    updateGridVisuals();
    updateSeekBar();
    updateTimeDisplay();
    S.animId = requestAnimationFrame(frame);
  }
  frame();
}

// -------- Import --------
function importJS(text) {
  try {
    const obj = parseJSMap(text);
    if (!S.project) throw new Error('Open a project before importing');
    if (obj.format_version && obj.format_version !== FORMAT_VERSION)
      toast(`⚠️ File format_version (${obj.format_version}) differs from current version (${FORMAT_VERSION}). There may be incompatibilities.`, '#ff9800', 6000);

    if (obj.name)         S.project.name         = obj.name;
    if (obj.artist)       S.project.artist       = obj.artist;
    if (obj.icon)         S.project.icon         = obj.icon;
    if (obj.audioMusic)   S.project.audioMusicId = obj.audioMusic;
    if (obj.audioPreview) S.project.audioPreviewId = obj.audioPreview;
    if (obj.duration)     S.project.duration     = Number(obj.duration);
    if (obj.blockplace)   S.project.blockplace   = obj.blockplace;

    if (obj.maps && typeof obj.maps === 'object') {
      S.project.maps = {};
      for (const [diff, raw] of Object.entries(obj.maps)) {
        S.project.maps[diff] = {};
        for (const [k, v] of Object.entries(raw)) {
          S.project.maps[diff][String(k)] = v;
        }
      }
      const diffs = Object.keys(S.project.maps);
      S.diff = diffs[0] || 'normal';
      document.getElementById('difficulty-select').value = S.diff;
    }

    document.getElementById('header-project-name').textContent =
      S.project.name + (S.project.artist ? ' — ' + S.project.artist : '');
    deselectNote();
    updateBadge();
    toast(`Imported: ${obj.name}`, '#4caf50');
  } catch(e) {
    toast('Import error: ' + e.message, '#f44');
    console.error(e);
  }
}

function parseJSMap(text) {
  // eslint-disable-next-line no-useless-escape
  let src = text.trim()
    .replace(/^\/\/[^\n]*\n/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^export\s+const\s+\w+\s*=\s*/, '')
    .replace(/;?\s*$/, '');
  const obj = (new Function('"use strict"; return (' + src + ')'))();
  if (!obj || typeof obj !== 'object') throw new Error('Invalid object');
  return obj;
}

function importJSAsNewProject(text) {
  try {
    const obj = parseJSMap(text);
    if (obj.format_version && obj.format_version !== FORMAT_VERSION)
      toast(`⚠️ File format_version (${obj.format_version}) differs from current version (${FORMAT_VERSION}). There may be incompatibilities.`, '#ff9800', 6000);
    const p = mkProject({
      name:         obj.name         || 'Imported',
      format_version: obj.format_version || FORMAT_VERSION,
      artist:       obj.artist       || '',
      icon:         obj.icon         || '',
      audioMusicId: obj.audioMusic   || '',
      audioPreviewId: obj.audioPreview || '',
      duration:     Number(obj.duration) || 120,
      blockplace:   obj.blockplace   || 'minecraft:red_wool',
    });
    if (obj.maps && typeof obj.maps === 'object') {
      p.maps = {};
      for (const [diff, raw] of Object.entries(obj.maps)) {
        p.maps[diff] = {};
        for (const [k, v] of Object.entries(raw)) {
          p.maps[diff][String(k)] = v;
        }
      }
    }
    S.projects[p.id] = p;
    saveProjects();
    renderProjectList();
    toast(`Project imported: ${p.name}`, '#4caf50');
  } catch(e) {
    toast('Import error: ' + e.message, '#f44');
    console.error(e);
  }
}

// -------- Export --------
function exportJS() {
  if (!S.project) return;
  const p  = S.project;
  const id = (p.name || 'song')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9_]/g,'_').replace(/_{2,}/g,'_').replace(/^_|_$/g,'');

  const lines = [];
  lines.push(`// Generated by OSU Cubic Editor`);
  lines.push(`// format_version: ${FORMAT_VERSION}`);
  lines.push(`export const ${id} = {`);
  lines.push(`    format_version: ${JSON.stringify(FORMAT_VERSION)},`);
  lines.push(`    name: ${JSON.stringify(p.name)},`);
  lines.push(`    artist: ${JSON.stringify(p.artist||'')},`);
  lines.push(`    icon: ${JSON.stringify(p.icon||'')},`);
  lines.push(`    audioMusic: ${JSON.stringify(p.audioMusicId||'')},`);
  lines.push(`    audioPreview: ${JSON.stringify(p.audioPreviewId||'')},`);
  lines.push(`    duration: ${p.duration},`);
  lines.push(`    blockplace: ${JSON.stringify(p.blockplace||'minecraft:red_wool')},`);
  lines.push(`    maps: {`);
  for (const [diff, map] of Object.entries(p.maps||{})) {
    lines.push(`        ${diff}: {`);
    const ticks = Object.keys(map).map(Number).sort((a,b) => a-b);
    for (const tick of ticks) {
      const ns = map[tick];
      if (!ns?.length) continue;
      const nstr = ns.map(n =>
        `{ x: ${n.x}, z: ${n.z}, type: ${JSON.stringify(n.type||'normal')}, sound: ${JSON.stringify(n.sound||'')}, event: ${JSON.stringify(n.event||'')}, lyric: ${JSON.stringify(n.lyric||'')} }`
      ).join(', ');
      lines.push(`    ${tick}: [${nstr}],`);
    }
    lines.push(`        },`);
  }
  lines.push(`    }`);
  lines.push(`};`);

  const blob = new Blob([lines.join('\n')], { type: 'text/javascript' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${id}.js`; a.click();
  URL.revokeObjectURL(url);
  toast(`Exported: ${id}.js`, '#4caf50');
}

// -------- Save --------
function saveProject() {
  if (!S.project) return;
  S.projects[S.project.id] = S.project;
  saveProjects();
  toast('Project saved!', '#4caf50');
}

// -------- Events --------
function initEvents() {
  // Projects
  document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
  document.getElementById('btn-import-project').addEventListener('click', () =>
    document.getElementById('file-import-project').click()
  );
  document.getElementById('file-import-project').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => importJSAsNewProject(ev.target.result);
    rd.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('btn-create-project').addEventListener('click', handleCreateProject);
  document.getElementById('btn-cancel-new').addEventListener('click', closeNewProjectModal);
  document.getElementById('modal-np-bg').addEventListener('click', closeNewProjectModal);
  document.getElementById('modal-new-project').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCreateProject();
    if (e.key === 'Escape') closeNewProjectModal();
  });

  // Editor header
  document.getElementById('btn-back').addEventListener('click', () => {
    if (confirm('Go back to projects? Remember to save.')) {
      stopAudio();
      if (S.animId) { cancelAnimationFrame(S.animId); S.animId = null; }
      S.project = null;
      showScreen('projects');
      renderProjectList();
    }
  });
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-export').addEventListener('click', exportJS);
  document.getElementById('btn-load-audio').addEventListener('click', () =>
    document.getElementById('file-audio').click()
  );
  document.getElementById('file-audio').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await loadAudio(f);
    e.target.value = '';
  });
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('file-import').click()
  );
  document.getElementById('file-import').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => importJS(ev.target.result);
    rd.readAsText(f);
    e.target.value = '';
  });

  document.getElementById('difficulty-select').addEventListener('change', e => {
    const d = e.target.value;
    if (!S.project.maps[d]) S.project.maps[d] = {};
    S.diff = d;
    deselectNote();
    updateBadge();
  });

  // Playback
  document.getElementById('btn-play-pause').addEventListener('click', togglePlay);
  document.getElementById('btn-rewind').addEventListener('click', rewind);
  document.getElementById('zoom-slider').addEventListener('input', e => {
    S.pps = Number(e.target.value);
  });

  // Seekbar
  const sw = document.getElementById('seekbar-wrap');
  sw.addEventListener('mousedown', e => { S.draggingSeek = true; handleSeekClick(e); });
  window.addEventListener('mousemove', e => { if (S.draggingSeek) handleSeekClick(e); });
  window.addEventListener('mouseup',   ()  => { S.draggingSeek = false; });

  // Timeline
  const gridWrap = document.getElementById('block-grid-wrap');
  const gridEl = document.getElementById('block-grid');
  const tc = document.getElementById('timeline-canvas');

  // Auto-focus editor zones on hover to avoid double-click activation
  if (gridEl) gridEl.tabIndex = -1;
  if (tc) tc.tabIndex = -1;
  gridWrap?.addEventListener('mouseenter', () => {
    try { gridEl?.focus({ preventScroll: true }); } catch {}
  });
  tc.addEventListener('mouseenter', () => {
    try { tc.focus({ preventScroll: true }); } catch {}
  });

  tc.addEventListener('mousedown',   onTimelineMouseDown);
  tc.addEventListener('mousemove',   onTimelineMouseMove);
  tc.addEventListener('wheel',       onTimelineScroll, { passive: false });
  tc.addEventListener('contextmenu', onTimelineContextMenu);
  // Finish drags on mouse-up anywhere
  window.addEventListener('mouseup', e => {
    // Seekbar
    S.draggingSeek = false;
    // Timeline drag
    if (S.tlDrag) onTimelineMouseUp(e);
    // Grid drag
    if (S.gridDrag) {
      document.querySelectorAll('.grid-cell.drag-target').forEach(el => el.classList.remove('drag-target'));
      const { tick, idx, origX, origZ, targetX, targetZ } = S.gridDrag;
      S.gridDrag = null;
      if (targetX !== undefined && (targetX !== origX || targetZ !== origZ)) {
        const map = getMap();
        if (map[tick]?.[idx]) {
          pushUndo();
          const occupied = map[tick].some((n,i) => i !== idx && n.x === targetX && n.z === targetZ);
          if (!occupied) {
            map[tick][idx].x = targetX;
            map[tick][idx].z = targetZ;
            selectNote(tick, idx);
            flashCell(targetX, targetZ);
            toast(`Note moved → x:${targetX} z:${targetZ}`, '#4fc3f7');
          } else {
            toast('Cell already occupied at this tick', '#f44');
          }
        }
      }
    }
  });
  document.getElementById('btn-apply-props').addEventListener('click', applyNoteProps);
  document.getElementById('btn-delete-note').addEventListener('click', deleteSelectedNote);
  document.getElementById('note-props-form').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyNoteProps();
  });

  const autoFocusFieldOnHover = e => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (!el.matches('input, select, textarea')) return;
    if (document.activeElement === el) return;
    try { el.focus({ preventScroll: true }); } catch {}
  };
  document.getElementById('note-props-form').addEventListener('mouseover', autoFocusFieldOnHover);

  // Metadata panel
  document.getElementById('btn-apply-meta').addEventListener('click', applyMetaProps);
  document.getElementById('btn-duration-from-audio').addEventListener('click', setDurationFromAudio);
  document.getElementById('btn-load-icon').addEventListener('click', () =>
    document.getElementById('file-icon-img').click()
  );
  document.getElementById('file-icon-img').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) loadIconImage(f);
    e.target.value = '';
  });
  document.getElementById('toggle-grid-preview').addEventListener('change', e => {
    S.gridPreview = !!e.target.checked;
    document.getElementById('grid-panel').classList.toggle('preview-mode', S.gridPreview);
  });
  document.getElementById('meta-form').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyMetaProps();
  });
  document.getElementById('meta-form').addEventListener('mouseover', autoFocusFieldOnHover);

  // Keyboard
  window.addEventListener('keydown', e => {
    if (S.screen !== 'editor') return;
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.code === 'Space' && !inInput) {
      e.preventDefault();
      togglePlay();
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && !inInput) {
      e.preventDefault();
      if (e.ctrlKey) clearDiffNotes();
      else deleteSelectedNote();
    }
    if (e.code === 'ArrowRight' && !inInput) {
      e.preventDefault();
      seekTo(now_audio() + (e.shiftKey ? 1.0 : 1/TPS));
    }
    if (e.code === 'ArrowLeft' && !inInput) {
      e.preventDefault();
      seekTo(now_audio() - (e.shiftKey ? 1.0 : 1/TPS));
    }
    if (e.ctrlKey && e.code === 'KeyS') {
      e.preventDefault();
      saveProject();
    }
    if (e.ctrlKey && e.code === 'KeyZ' && !inInput) {
      e.preventDefault();
      undoLast();
    }
    if (e.key === 'Escape' && !inInput) {
      deselectNote();
    }
  });

  // Resize
  window.addEventListener('resize', () => {
    if (S.screen === 'editor') resizeTimeline();
  });
}

// -------- Init --------
function init() {
  S.projects = loadProjects();
  renderProjectList();
  showScreen('projects');
  initEvents();
}

document.addEventListener('DOMContentLoaded', init);
