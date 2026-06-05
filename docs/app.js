// ================================================
// OSU Cubic Editor — app.js
// Areas.Player1: xA:-6 xB:6 zA:-6 zB:6 y:0
// ================================================

const TPS = 20;          // Minecraft ticks per second
const FORMAT_VERSION = '1.0'; // Exported map format version
const GRID_MIN = -6;
const GRID_MAX = 6;
const GRID_SIZE = GRID_MAX - GRID_MIN + 1; // 13
const BEAT_H = 28;       // height of beat lane at bottom of timeline

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
  beatTapStart: null,     // tick of first beat-tap (null = not tapping)
  // Undo history
  history: [],            // [{ diff, map, selection }] snapshots
  historyPtr: -1,         // current position in history
  // Visuals
  animId: null,
  flashCells: new Map(),  // 'x,z' → expire timestamp
  // Grid mouse tracking
  gridMousePos: { x: null, z: null },  // Current mouse position over grid
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
    mapper:       d.mapper       || '',
    icon:         d.icon         || '',
    audioMusicId: d.audioMusicId || '',
    audioPreviewId: d.audioPreviewId || '',
    duration:     Number(d.duration) || 120,
    blockplace:   d.blockplace   || 'minecraft:red_wool',
    maps:         d.maps         || { normal: {} },
    bpmByTick:    d.bpmByTick    || {},  // BPM per tick for visual effects
    bpmMethods:   d.bpmMethods   || {},  // method used: 'manual' | 'tap'
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

function capitalize(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function copyDifficultyMap(sourceDiff, targetDiff) {
  if (!S.project) return;
  if (sourceDiff === targetDiff) {
    toast('Select a different target difficulty', '#f5a623');
    return;
  }
  const sourceMap = JSON.parse(JSON.stringify(S.project.maps[sourceDiff] || {}));
  if (!Object.keys(sourceMap).length) {
    if (!confirm(`Source difficulty ${capitalize(sourceDiff)} is empty. Copy anyway to ${capitalize(targetDiff)}?`)) return;
  }
  const targetMap = S.project.maps[targetDiff] || {};
  if (Object.keys(targetMap).length) {
    if (!confirm(`Copy map from ${capitalize(sourceDiff)} into ${capitalize(targetDiff)}?\nThis will overwrite all existing notes on ${capitalize(targetDiff)}.`)) return;
  }
  S.project.maps[targetDiff] = sourceMap;
  if (S.diff === targetDiff) {
    buildGrid();
    updateNotePanel();
  }
  updateBadge();
  saveProject();
  toast(`Copied map from ${capitalize(sourceDiff)} → ${capitalize(targetDiff)}`, '#4caf50');
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
        <div class="pc-meta">${esc(p.artist)} ${p.mapper ? '— Mapper: ' + esc(p.mapper) : ''} — ${p.duration}s — ${countNotes(p)} notes</div>
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
    mapper:         document.getElementById('np-mapper').value.trim(),
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
  const btns     = { note: 'tab-note', meta: 'tab-meta', tools: 'tab-tools' };
  const contents = { note: 'tab-note-content', meta: 'tab-meta-content', tools: 'tab-tools-content' };
  for (const [key, id] of Object.entries(btns)) {
    document.getElementById(id)?.classList.toggle('active', key === tab);
  }
  for (const [key, id] of Object.entries(contents)) {
    document.getElementById(id)?.classList.toggle('hidden', key !== tab);
  }
  if (tab === 'meta') updateMetaPanel();
}

// -------- Metadata --------
function updateMetaPanel() {
  if (!S.project) return;
  const p = S.project;
  document.getElementById('meta-name').value       = p.name         || '';
  document.getElementById('meta-artist').value     = p.artist       || '';
  document.getElementById('meta-mapper').value     = p.mapper       || '';
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
  p.mapper        = document.getElementById('meta-mapper').value.trim();
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
        // If cell is empty, always add note immediately (ignore drag threshold)
        const tick = curTick();
        const map = getMap();
        const hasNote = map[tick]?.some(n => n.x === x && n.z === z) ?? false;
        if (!hasNote) {
          onGridCellClick(x, z); // Empty cell - add note instantly
          return;
        }
        onGridCellClick(x, z);
      });

      // Prevent browser's native drag (text/image) from interfering
      cell.addEventListener('dragstart', e => e.preventDefault());
      bubble.addEventListener('dragstart', e => e.preventDefault());

      // Mousedown: start potential note drag (only if note exists at this cell)
      cell.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const tick = curTick();
        const map  = getMap();
        const ns   = map[tick];
        const idx  = ns ? ns.findIndex(n => n.x === x && n.z === z) : -1;
        // Only enable drag if note exists; empty cells allow instant click
        if (idx !== -1) {
          S.gridDrag = { tick, idx, origX: x, origZ: z, startX: e.clientX, startY: e.clientY };
          S._gridDragMoved = false;
        }
      });

      // Mouseenter: update grid drag target (only if real movement detected)
      cell.addEventListener('mouseenter', (evt) => {
        if (!S.gridDrag) return;
        // Only consider drag if mouse moved 5+ pixels from start
        const dx = Math.abs(evt.clientX - S.gridDrag.startX);
        const dy = Math.abs(evt.clientY - S.gridDrag.startY);
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 5) return; // Threshold: 5px
        
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
  // Apply BPM to all selected ticks (if there's a value)
  const bpmEl = document.getElementById('prop-bpm');
  if (bpmEl.value) {
    const bpm = parseFloat(bpmEl.value);
    if (bpm > 0) {
      const tick = S.selection[0].tick;
      if (!S.project.bpmByTick) S.project.bpmByTick = {};
      if (!S.project.bpmMethods) S.project.bpmMethods = {};
      S.project.bpmByTick[tick] = bpm;
      S.project.bpmMethods[tick] = 'manual';
    }
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
  const tick = pairs[0].s.tick;
  const bpmAtTick = S.project?.bpmByTick?.[tick] || '';
  if (pairs.length === 1) {
    const { s, note } = pairs[0];
    document.getElementById('prop-tick').value  = s.tick;
    document.getElementById('prop-x').value     = note.x;
    document.getElementById('prop-z').value     = note.z;
    document.getElementById('prop-bpm').value   = bpmAtTick;
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
    document.getElementById('prop-bpm').value  = bpmAtTick;
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
    updateAudioBtn();
  } catch(e) {
    document.getElementById('audio-status').textContent = 'Error restoring audio — please reload the file';
    console.warn('restoreAudio:', e);
  }
}

function updateAudioBtn() {
  const btn = document.getElementById('btn-load-audio');
  if (!btn) return;
  if (S.buf && S.project?.audioFileName) {
    const name = S.project.audioFileName.length > 18
      ? S.project.audioFileName.slice(0, 16) + '…'
      : S.project.audioFileName;
    btn.textContent = `🎵 ${name}`;
    btn.classList.add('btn-audio-loaded');
  } else {
    btn.textContent = '🎵 Load Audio';
    btn.classList.remove('btn-audio-loaded');
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
    updateAudioBtn();
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
  const rowH  = (H - HEAD_H - BEAT_H) / numZ;
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

  // ---- Beat Lane ----
  const beatLaneY = HEAD_H + numZ * rowH;
  ctx.fillStyle = '#080814';
  ctx.fillRect(0, beatLaneY, W, BEAT_H);
  ctx.fillStyle = '#252550';
  ctx.fillRect(0, beatLaneY, W, 1);

  ctx.fillStyle = '#445';
  ctx.font = '9px monospace';
  ctx.fillText('BEAT', 3, beatLaneY + BEAT_H * 0.62 + 3);

  const bpmRaw = S.project?.bpmByTick || {};
  const bpmMarkers = Object.entries(bpmRaw)
    .map(([t, b]) => ({ tick: Number(t), bpm: Number(b) }))
    .sort((a, b) => a.tick - b.tick);

  const visStart = S.viewOff;
  const visEnd   = visStart + W / pps;

  if (bpmMarkers.length === 0) {
    ctx.fillStyle = '#334';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Clique: BPM manual  |  Shift+clique: 2-tap  |  Botão dir.: remover', W / 2, beatLaneY + BEAT_H / 2 + 4);
    ctx.textAlign = 'left';
  } else {
    // Build visible segments
    for (let bi = 0; bi < bpmMarkers.length; bi++) {
      const segStartSec = bpmMarkers[bi].tick / TPS;
      const segEndSec   = bi + 1 < bpmMarkers.length
        ? bpmMarkers[bi + 1].tick / TPS
        : visEnd + 60;
      if (segStartSec > visEnd) break;
      if (segEndSec < visStart) continue;

      const bpm = bpmMarkers[bi].bpm;
      const beatSec = 60 / bpm;
      const firstIdx = Math.max(0, Math.floor((visStart - segStartSec) / beatSec));
      let beatIdx = firstIdx;

      while (true) {
        const beatTime = segStartSec + beatIdx * beatSec;
        if (beatTime > segEndSec || beatTime > visEnd + beatSec) break;
        const bx = beatTime * pps - offPx;
        if (bx >= -2 && bx <= W + 2) {
          const isDownbeat = beatIdx % 4 === 0;
          const isHalf     = !isDownbeat && beatIdx % 2 === 0;
          ctx.beginPath();
          ctx.moveTo(bx, beatLaneY + (isDownbeat ? 2 : isHalf ? 8 : 12));
          ctx.lineTo(bx, beatLaneY + BEAT_H - 2);
          ctx.strokeStyle = isDownbeat
            ? 'rgba(79,195,247,0.75)'
            : isHalf
            ? 'rgba(79,195,247,0.38)'
            : 'rgba(79,195,247,0.18)';
          ctx.lineWidth = isDownbeat ? 1.5 : 0.8;
          ctx.stroke();
        }
        beatIdx++;
      }
    }

    // BPM marker diamonds (pink=manual, orange=tap)
    for (const e of bpmMarkers) {
      const bx = e.tick / TPS * pps - offPx;
      if (bx < -20 || bx > W + 20) continue;
      const cy = beatLaneY + BEAT_H / 2;
      const r  = 5;
      const method = S.project?.bpmMethods?.[e.tick] || 'manual';
      const color  = method === 'tap' ? '#f5a623' : '#e94fbb';
      ctx.beginPath();
      ctx.moveTo(bx, cy - r);
      ctx.lineTo(bx + r, cy);
      ctx.lineTo(bx, cy + r);
      ctx.lineTo(bx - r, cy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      if (bx + 8 < W) {
        ctx.fillStyle = color;
        ctx.font = 'bold 9px monospace';
        ctx.fillText(String(e.bpm), bx + 8, cy + 3);
      }
    }

    // Pending beat-tap indicator (dashed line at first tap position)
    if (S.beatTapStart !== null) {
      const bx = S.beatTapStart / TPS * pps - offPx;
      if (bx >= -5 && bx <= W + 5) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(bx, beatLaneY + 2);
        ctx.lineTo(bx, beatLaneY + BEAT_H - 2);
        ctx.strokeStyle = '#f5a623';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#f5a623';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`1ª t${S.beatTapStart}`, bx + 3, beatLaneY + 11);
      }
    }
  }
}

function _tlCoords(e) {
  const canvas = document.getElementById('timeline-canvas');
  const r  = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  const H  = canvas.height;
  const HEAD_H = 18;
  const numZ = GRID_SIZE;
  const rowH = (H - HEAD_H - BEAT_H) / numZ;
  const sec  = (mx + S.viewOff * S.pps) / S.pps;
  const tick = Math.round(sec * TPS);
  const zi   = Math.floor((my - HEAD_H) / rowH);
  const inBeatLane = my >= H - BEAT_H;
  return { mx, my, sec, tick, zi, rowH, HEAD_H, H, inBeatLane };
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
  const { mx, my, sec, tick, zi, rowH, HEAD_H, inBeatLane } = _tlCoords(e);
  const canvas = document.getElementById('timeline-canvas');

  if (inBeatLane) {
    if (e.shiftKey) {
      // TAP METHOD: dois cliques na beat lane → BPM calculado pelo intervalo
      if (S.beatTapStart === null) {
        S.beatTapStart = tick;
        toast(`1ª batida: tick ${tick} — Shift+clique na 2ª batida`, '#f5a623');
      } else {
        const interval = tick - S.beatTapStart;
        if (interval <= 0) {
          S.beatTapStart = null;
          toast('2ª batida deve ser após a 1ª. Tap cancelado.', '#f44');
          e.preventDefault();
          return;
        }
        const bpm = Math.round(60 * TPS / interval * 10) / 10;
        if (!S.project.bpmByTick) S.project.bpmByTick = {};
        if (!S.project.bpmMethods) S.project.bpmMethods = {};
        S.project.bpmByTick[S.beatTapStart] = bpm;
        S.project.bpmMethods[S.beatTapStart] = 'tap';
        const tapTick = S.beatTapStart;
        S.beatTapStart = null;
        saveProject();
        toast(`BPM calculado: ${bpm} (tap) — tick ${tapTick}`, '#f5a623');
      }
    } else {
      // MANUAL METHOD: digitar valor de BPM
      const bpmStr = prompt(`BPM no tick ${tick} (${(tick / TPS).toFixed(2)}s):`, '120');
      if (bpmStr === null) { e.preventDefault(); return; }
      const bpm = parseFloat(bpmStr);
      if (!bpm || bpm <= 0 || bpm > 9999) { toast('Valor de BPM inválido', '#f44'); e.preventDefault(); return; }
      if (!S.project.bpmByTick) S.project.bpmByTick = {};
      if (!S.project.bpmMethods) S.project.bpmMethods = {};
      S.project.bpmByTick[tick] = bpm;
      S.project.bpmMethods[tick] = 'manual';
      saveProject();
      toast(`BPM ${bpm} definido no tick ${tick}`, '#e94fbb');
    }
    e.preventDefault();
    return;
  }

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
  const { mx, my, sec, tick, zi, inBeatLane } = _tlCoords(e);

  // Update cursor hint when not dragging
  if (!S.tlDrag) {
    if (inBeatLane) { canvas.style.cursor = 'pointer'; return; }
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
      const rowH = (H - HEAD_H - BEAT_H) / GRID_SIZE;
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

// Timeline right-click: delete note or BPM marker
function onTimelineContextMenu(e) {
  e.preventDefault();
  if (!S.project) return;
  const { tick, zi, mx, inBeatLane } = _tlCoords(e);

  if (inBeatLane) {
    const bpmByTick = S.project.bpmByTick;
    if (!bpmByTick || !Object.keys(bpmByTick).length) return;
    const tolTicks = Math.ceil(10 / S.pps * TPS);
    let nearestTick = null, nearestDist = Infinity;
    for (const t of Object.keys(bpmByTick)) {
      const dist = Math.abs(Number(t) - tick);
      if (dist < tolTicks && dist < nearestDist) {
        nearestDist = dist;
        nearestTick = Number(t);
      }
    }
    if (nearestTick !== null) {
      delete bpmByTick[nearestTick];
      if (S.project.bpmMethods) delete S.project.bpmMethods[nearestTick];
      saveProject();
      toast(`Marcador de BPM removido no tick ${nearestTick}`, '#f44');
    }
    if (S.beatTapStart !== null) { S.beatTapStart = null; toast('Tap cancelado', '#888'); }
    return;
  }

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
    if (obj.mapper)       S.project.mapper       = obj.mapper;
    if (obj.icon)         S.project.icon         = obj.icon;
    if (obj.audioMusic)   S.project.audioMusicId = obj.audioMusic;
    if (obj.audioPreview) S.project.audioPreviewId = obj.audioPreview;
    if (obj.duration)     S.project.duration     = Number(obj.duration);
    if (obj.blockplace)   S.project.blockplace   = obj.blockplace;
    if (obj.bpmByTick)    S.project.bpmByTick    = obj.bpmByTick;
    if (obj.bpmMethods)   S.project.bpmMethods   = obj.bpmMethods;

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
      mapper:       obj.mapper       || '',
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
    if (obj.bpmByTick)  p.bpmByTick  = obj.bpmByTick;
    if (obj.bpmMethods) p.bpmMethods = obj.bpmMethods;
    S.projects[p.id] = p;
    saveProjects();
    renderProjectList();
    toast(`Project imported: ${p.name}`, '#4caf50');
  } catch(e) {
    toast('Import error: ' + e.message, '#f44');
    console.error(e);
  }
}

// -------- Export / Import Project (.ocproj) --------
function exportProject() {
  if (!S.project) return;
  // Save current state first so audio/icon are included
  saveProject();
  const blob = new Blob([JSON.stringify(S.project)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (S.project.name || 'project').replace(/[^a-z0-9_\- ]/gi, '_') + '.ocproj';
  a.click();
  URL.revokeObjectURL(url);
  toast('Project exported!', '#4caf50');
}

async function importProjectFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.maps) throw new Error('Not a valid .ocproj file');

    // Build a clean project preserving embedded assets
    const p = mkProject(data);
    p.audioDataUrl   = data.audioDataUrl   || null;
    p.audioFileName  = data.audioFileName  || null;
    p.iconDataUrl    = data.iconDataUrl    || null;
    p.bpmByTick      = data.bpmByTick      || {};
    p.bpmMethods     = data.bpmMethods     || {};

    // Save current project state before switching
    if (S.project) saveProject();

    S.projects[p.id] = p;
    saveProjects();
    openProject(p.id);
    toast(`Project loaded: ${p.name}`, '#4caf50');
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
  lines.push(`    mapper: ${JSON.stringify(p.mapper||'')},`);
  lines.push(`    icon: ${JSON.stringify(p.icon||'')},`);
  lines.push(`    audioMusic: ${JSON.stringify(p.audioMusicId||'')},`);
  lines.push(`    audioPreview: ${JSON.stringify(p.audioPreviewId||'')},`);
  lines.push(`    duration: ${p.duration},`);
  lines.push(`    blockplace: ${JSON.stringify(p.blockplace||'minecraft:red_wool')},`);
  lines.push(`    bpmByTick: ${JSON.stringify(p.bpmByTick||{})},`);
  lines.push(`    bpmMethods: ${JSON.stringify(p.bpmMethods||{})},`);
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
  // Projects screen dropdown
  const ddMain     = document.getElementById('btn-import-project');
  const ddMainMenu = document.getElementById('dd-import-main-menu');
  ddMain.addEventListener('click', e => {
    e.stopPropagation();
    ddMainMenu.classList.toggle('hidden');
  });
  document.getElementById('dd-main-import-js').addEventListener('click', () =>
    document.getElementById('file-import-project').click()
  );
  document.getElementById('dd-main-import-proj').addEventListener('click', () =>
    document.getElementById('file-import-proj-main').click()
  );
  document.getElementById('file-import-project').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => importJSAsNewProject(ev.target.result);
    rd.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('file-import-proj-main').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await importProjectFile(f);
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
  document.getElementById('btn-auto-bpm').addEventListener('click', autoBpmDetect);
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-export').addEventListener('click', exportJS);
  document.getElementById('btn-load-audio').addEventListener('click', () => {
    if (S.buf && !confirm('Replace the current audio?')) return;
    document.getElementById('file-audio').click();
  });
  document.getElementById('file-audio').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await loadAudio(f);
    e.target.value = '';
  });
  // Dropdown toggle
  const ddBtn  = document.getElementById('btn-dd-project');
  const ddMenu = document.getElementById('dd-project-menu');
  ddBtn.addEventListener('click', e => {
    e.stopPropagation();
    ddMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => ddMenu.classList.add('hidden'));

  // Dropdown items
  document.getElementById('dd-import-js').addEventListener('click', () =>
    document.getElementById('file-import').click()
  );
  document.getElementById('dd-import-proj').addEventListener('click', () =>
    document.getElementById('file-import-proj').click()
  );
  document.getElementById('dd-export-proj').addEventListener('click', exportProject);

  // File inputs
  document.getElementById('file-import').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => importJS(ev.target.result);
    rd.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('file-import-proj').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await importProjectFile(f);
    e.target.value = '';
  });

  document.getElementById('difficulty-select').addEventListener('change', e => {
    const d = e.target.value;
    if (!S.project.maps[d]) S.project.maps[d] = {};
    S.diff = d;
    deselectNote();
    updateBadge();
  });

  document.getElementById('btn-copy-map').addEventListener('click', () => {
    const sourceDiff = document.getElementById('copy-source-select').value;
    const targetDiff = document.getElementById('copy-target-select').value;
    copyDifficultyMap(sourceDiff, targetDiff);
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

  // Track mouse position over grid
  gridWrap?.addEventListener('mousemove', (e) => {
    const rect = gridEl?.getBoundingClientRect();
    if (!rect) return;
    const cellSize = rect.width > 0 ? rect.width / GRID_SIZE : 36;
    const x = Math.floor((e.clientX - rect.left) / cellSize) + GRID_MIN;
    const z = Math.floor((e.clientY - rect.top) / cellSize) + GRID_MIN;
    if (x >= GRID_MIN && x <= GRID_MAX && z >= GRID_MIN && z <= GRID_MAX) {
      S.gridMousePos = { x, z };
    }
  });

  gridWrap?.addEventListener('mouseleave', () => {
    S.gridMousePos = { x: null, z: null };
  });

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
      const { tick, idx, origX, origZ, targetX, targetZ, startX, startY } = S.gridDrag;
      // Only process drag if there was real movement (5px threshold)
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      const distance = Math.sqrt(dx * dx + dy * dy);
      S.gridDrag = null;
      if (distance >= 5 && targetX !== undefined && (targetX !== origX || targetZ !== origZ)) {
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
      if (S.beatTapStart !== null) { S.beatTapStart = null; toast('Tap cancelado', '#888'); }
    }
    if ((e.key === 'f' || e.key === 'F') && !inInput) {
      e.preventDefault();
      // Add note at current mouse position over grid
      if (S.gridMousePos.x !== null && S.gridMousePos.z !== null) {
        onGridCellClick(S.gridMousePos.x, S.gridMousePos.z);
      } else {
        toast('Move mouse over grid to add note with F', '#f5a623');
      }
    }
  });

  // Resize
  document.getElementById('btn-toggle-grid-size').addEventListener('click', () => {
    document.getElementById('editor-body').classList.toggle('expanded-grid');
  });

  const tlWrap = document.getElementById('timeline-wrap');
  if (tlWrap) {
    new ResizeObserver(() => {
      if (S.screen === 'editor') resizeTimeline();
    }).observe(tlWrap);
  }
}

// -------- Auto BPM Detection --------
async function autoBpmDetect() {
  if (!S.buf) { toast('Load audio first', '#f44'); return; }
  if (!S.project) return;

  toast('Analyzing audio…', '#f5a623', 60000);
  await new Promise(r => setTimeout(r, 30));

  const sr   = S.buf.sampleRate;
  const HOP  = 512;
  const fps  = sr / HOP;

  // Mix to mono
  const ch0 = S.buf.getChannelData(0);
  let data;
  if (S.buf.numberOfChannels >= 2) {
    const ch1 = S.buf.getChannelData(1);
    data = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) data[i] = (ch0[i] + ch1[i]) * 0.5;
  } else {
    data = ch0;
  }

  // Full song length for beat tracking (after BPM estimated from first 45s)
  const fullLen = data.length;

  // --- Step 1: RMS energy + onset strength for the full song ---
  const fullFrames = Math.floor((fullLen - HOP) / HOP);
  const onset = new Float32Array(fullFrames);
  let prevE = 0;
  for (let i = 0; i < fullFrames; i++) {
    let e = 0;
    const base = i * HOP;
    for (let j = 0; j < HOP; j++) e += data[base + j] ** 2;
    e = Math.sqrt(e / HOP);
    onset[i] = Math.max(0, e - prevE);
    prevE = e;
  }

  // --- Step 2: Autocorrelation on first 45s to estimate BPM ---
  const N45 = Math.min(fullFrames, Math.floor(fps * 45));
  const lagMin = Math.floor(fps * 60 / 220);
  const lagMax = Math.ceil(fps * 60 / 60);

  let bestLag = lagMin, bestCorr = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let corr = 0;
    for (let i = 0; i < N45 - lag; i++) corr += onset[i] * onset[i + lag];
    corr /= (N45 - lag);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  // Half-time / double-time check
  for (const lag of [bestLag * 2, Math.round(bestLag / 2)]) {
    if (lag < lagMin || lag > lagMax) continue;
    let corr = 0;
    for (let i = 0; i < N45 - lag; i++) corr += onset[i] * onset[i + lag];
    corr /= (N45 - lag);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const globalBpm = 60 * fps / bestLag;

  // --- Step 3: Find beat phase ---
  let bestPhase = 0, bestScore = -Infinity;
  for (let phase = 0; phase < bestLag; phase++) {
    let score = 0;
    for (let pos = phase; pos < N45; pos += bestLag)
      score += onset[Math.round(pos)] || 0;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }

  // --- Step 4: Track every beat across full song ---
  // For each expected beat position, snap to local onset peak within ±20% of the period
  const snap = Math.floor(bestLag * 0.2);
  const beatFrames = [];
  for (let pos = bestPhase; pos < fullFrames; pos += bestLag) {
    const center = Math.round(pos);
    const lo = Math.max(0, center - snap);
    const hi = Math.min(fullFrames - 1, center + snap);
    let peakFrame = center, peakVal = onset[center] || 0;
    for (let k = lo; k <= hi; k++) {
      if ((onset[k] || 0) > peakVal) { peakVal = onset[k]; peakFrame = k; }
    }
    beatFrames.push(peakFrame);
  }

  // --- Step 5: Store each beat in bpmByTick ---
  // Remove previous auto-detected markers, keep manual/tap ones
  if (!S.project.bpmByTick)  S.project.bpmByTick  = {};
  if (!S.project.bpmMethods) S.project.bpmMethods = {};
  for (const t of Object.keys(S.project.bpmByTick)) {
    if (S.project.bpmMethods[t] === 'auto') {
      delete S.project.bpmByTick[t];
      delete S.project.bpmMethods[t];
    }
  }

  for (let i = 0; i < beatFrames.length; i++) {
    const tick = Math.max(0, Math.round((beatFrames[i] * HOP / sr) * TPS));
    // Local BPM = interval to next beat; fallback to global on last beat
    let localBpm = globalBpm;
    if (i + 1 < beatFrames.length) {
      const intervalFrames = beatFrames[i + 1] - beatFrames[i];
      if (intervalFrames > 0) localBpm = 60 * fps / intervalFrames;
    }
    const bpmRounded = Math.round(localBpm * 10) / 10;
    S.project.bpmByTick[tick]  = bpmRounded;
    S.project.bpmMethods[tick] = 'auto';
  }

  document.getElementById('toast')?.remove?.();
  renderTimeline();
  toast(
    `${beatFrames.length} beats marked — ~${Math.round(globalBpm)} BPM`,
    '#4caf50', 4000
  );
}

// -------- Init --------
function init() {
  S.projects = loadProjects();
  renderProjectList();
  showScreen('projects');
  initEvents();
}

document.addEventListener('DOMContentLoaded', init);
