// ─── STATE ────────────────────────────────────────────────────────────────────
const MAX_LAYERS = 15;
const FPS = 30;

let layers = [
  { shape: null, animation: null },
];
let activeLayer = 0;
let currentTool = null;
let currentColor = '#ff4136';

// Interaction modes: 'draw' | 'record'
let appMode = 'draw';

// Canvas settings
let canvasRatio  = '16:9';   // '16:9' | '1:1' | '9:16'
let canvasBgColor = '#ffffff';

// Draw state
let isDrawing = false;
let drawStart = null; // {x, y} in canvas pixels

// Record state
let isRecording = false;
let isPlaying = false;
let recordedPath = [];
let recordStartTime = null;
let recordDuration = 5;
let playbackStart = null;
let playbackRAF = null;
let recTimerInterval = null;
let scrubbing = false;
let playheadPct = 0;

// ─── CANVAS SETUP ─────────────────────────────────────────────────────────────
const canvasArea = document.getElementById('canvas-area');
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');

const RATIOS = { '16:9': [16, 9], '1:1': [1, 1], '9:16': [9, 16] };
const PADDING = 28; // px gap around canvas within canvas-area

function resizeCanvas() {
  const r   = canvasArea.getBoundingClientRect();
  const aW  = r.width  - PADDING * 2;
  const aH  = r.height - PADDING * 2;
  const [rW, rH] = RATIOS[canvasRatio];

  // Fit the ratio inside the available space
  let w = aW;
  let h = w * rH / rW;
  if (h > aH) { h = aH; w = h * rW / rH; }

  canvas.width  = Math.round(w);
  canvas.height = Math.round(h);
  drawFrame(playheadPct);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── SHAPE MODEL ─────────────────────────────────────────────────────────────
// Shapes store geometry explicitly rather than just a centre + size.
// rect:   { type, color, x1, y1, x2, y2 }   (normalised 0-1 coords)
// circle: { type, color, cx, cy, rx, ry }    (normalised — rx horizontal, ry vertical; equal = perfect circle)
// line:   { type, color, x1, y1, x2, y2 }   (normalised)
// image:  { type, img, cx, cy, w, h, scale } (normalised centre + half-dimensions)

function shapeCentre(shape) {
  if (shape.type === 'circle' || shape.type === 'image' || shape.type === 'text')
    return { x: shape.cx, y: shape.cy };
  return { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 };
}

// ─── SHAPE MOVE (draw mode drag) ─────────────────────────────────────────────
// Snapshot the position coords of a shape so we can move from a clean baseline.
function snapshotShape(shape) {
  if (shape.type === 'rect' || shape.type === 'line')
    return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
  if (shape.type === 'circle' || shape.type === 'image' || shape.type === 'text')
    return { cx: shape.cx, cy: shape.cy };
  return {};
}

// Apply a normalised delta (ndx, ndy) from a snapshot — avoids float drift.
function moveShapeByDelta(shape, snap, ndx, ndy) {
  if (shape.type === 'rect' || shape.type === 'line') {
    shape.x1 = snap.x1 + ndx; shape.x2 = snap.x2 + ndx;
    shape.y1 = snap.y1 + ndy; shape.y2 = snap.y2 + ndy;
  } else if (shape.type === 'circle' || shape.type === 'image' || shape.type === 'text') {
    shape.cx = snap.cx + ndx;
    shape.cy = snap.cy + ndy;
  }
}

function centreShapeH(shape) {
  const c = shapeCentre(shape);
  const dx = 0.5 - c.x;
  moveShapeByDelta(shape, snapshotShape(shape), dx, 0);
}

function centreShapeV(shape) {
  const c = shapeCentre(shape);
  const dy = 0.5 - c.y;
  moveShapeByDelta(shape, snapshotShape(shape), 0, dy);
}

document.getElementById('align-h').addEventListener('click', () => {
  const shape = layers[activeLayer] && layers[activeLayer].shape;
  if (!shape || appMode !== 'draw') return;
  centreShapeH(shape);
  drawFrame(playheadPct);
  markUnsaved();
});

document.getElementById('align-v').addEventListener('click', () => {
  const shape = layers[activeLayer] && layers[activeLayer].shape;
  if (!shape || appMode !== 'draw') return;
  centreShapeV(shape);
  drawFrame(playheadPct);
  markUnsaved();
});

let shapeDragStart    = null; // normalised canvas pos where drag began
let shapeDragSnap     = null; // coord snapshot at drag start
let shapeDragging     = false; // true once movement exceeds threshold
let shapeDragClientXY = null; // saved for inspector fallback on tiny moves

function drawShapeCtx(offCtx, shape, W, H, dx, dy) {
  offCtx.save();
  offCtx.fillStyle = shape.color;
  offCtx.strokeStyle = shape.color;

  if (shape.type === 'rect') {
    const px1 = shape.x1 * W + dx, py1 = shape.y1 * H + dy;
    const px2 = shape.x2 * W + dx, py2 = shape.y2 * H + dy;
    offCtx.fillRect(
      Math.min(px1, px2), Math.min(py1, py2),
      Math.abs(px2 - px1), Math.abs(py2 - py1)
    );
  } else if (shape.type === 'circle') {
    const px = shape.cx * W + dx, py = shape.cy * H + dy;
    const prx = (shape.rx || shape.r) * W;
    const pry = (shape.ry || shape.r) * H;
    offCtx.beginPath();
    offCtx.ellipse(px, py, prx, pry, 0, 0, Math.PI * 2);
    offCtx.fill();
  } else if (shape.type === 'line') {
    const px1 = shape.x1 * W + dx, py1 = shape.y1 * H + dy;
    const px2 = shape.x2 * W + dx, py2 = shape.y2 * H + dy;
    const len = Math.hypot(px2 - px1, py2 - py1);
    offCtx.lineWidth = Math.max(3, len * 0.04);
    offCtx.lineCap = 'round';
    offCtx.beginPath();
    offCtx.moveTo(px1, py1);
    offCtx.lineTo(px2, py2);
    offCtx.stroke();
  } else if (shape.type === 'image') {
    const px = shape.cx * W + dx, py = shape.cy * H + dy;
    const pw = shape.w * W, ph = shape.h * H;
    offCtx.drawImage(shape.img, px - pw / 2, py - ph / 2, pw, ph);
  } else if (shape.type === 'text') {
    const fs = shape.fontSize * H * (shape.scale || 1.0);
    offCtx.save();
    offCtx.font = `500 ${fs}px 'Geist', sans-serif`;
    offCtx.fillStyle = shape.color;
    offCtx.textAlign = 'center';
    offCtx.textBaseline = 'middle';
    offCtx.fillText(shape.text, shape.cx * W + dx, shape.cy * H + dy);
    offCtx.restore();
  }
  offCtx.restore();
}

function drawShape(shape, dx, dy) {
  drawShapeCtx(ctx, shape, canvas.width, canvas.height, dx, dy);
}

function drawGhost(shape) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  drawShape(shape, 0, 0);
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#4a6cf7';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  if (shape.type === 'rect' || shape.type === 'line') {
    const x1 = shape.x1 * canvas.width, y1 = shape.y1 * canvas.height;
    const x2 = shape.x2 * canvas.width, y2 = shape.y2 * canvas.height;
    ctx.strokeRect(
      Math.min(x1,x2)-2, Math.min(y1,y2)-2,
      Math.abs(x2-x1)+4, Math.abs(y2-y1)+4
    );
  } else if (shape.type === 'circle') {
    const px = shape.cx * canvas.width, py = shape.cy * canvas.height;
    const prx = (shape.rx || shape.r) * canvas.width + 2;
    const pry = (shape.ry || shape.r) * canvas.height + 2;
    ctx.beginPath();
    ctx.ellipse(px, py, prx, pry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function getPositionAtTime(anim, t) {
  if (!anim || anim.length === 0) return null;
  const dur = anim[anim.length-1].t;
  if (dur === 0) return { x: anim[0].x, y: anim[0].y };
  const clampedT = Math.min(t, dur);
  for (let i = 1; i < anim.length; i++) {
    if (clampedT <= anim[i].t) {
      const prev = anim[i-1], next = anim[i];
      const seg = next.t - prev.t;
      const alpha = seg === 0 ? 1 : (clampedT - prev.t) / seg;
      return {
        x: prev.x + (next.x - prev.x) * alpha,
        y: prev.y + (next.y - prev.y) * alpha,
      };
    }
  }
  return { x: anim[anim.length-1].x, y: anim[anim.length-1].y };
}


function drawFrame(pct) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Fill background colour
  ctx.fillStyle = canvasBgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t = pct * recordDuration;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.shape) continue;

    let dx = 0, dy = 0;
    if (layer.animation && layer.animation.length > 0) {
      const centre = shapeCentre(layer.shape);
      const pos = getPositionAtTime(layer.animation, t);
      if (!pos) continue;
      dx = (pos.x - centre.x) * canvas.width;
      dy = (pos.y - centre.y) * canvas.height;
    }
    drawShape(layer.shape, dx, dy);
  }

  // Draw selection outline around the active layer's shape (only if it has one)
  const active = layers[activeLayer];
  if (active && active.shape) {
    let dx = 0, dy = 0;
    if (active.animation && active.animation.length > 0) {
      const centre = shapeCentre(active.shape);
      const pos = getPositionAtTime(active.animation, t);
      if (pos) { dx = (pos.x - centre.x) * canvas.width; dy = (pos.y - centre.y) * canvas.height; }
    }
    drawSelectionOutline(active.shape, dx, dy);
  }
}

function drawSelectionOutline(shape, dx = 0, dy = 0) {
  const W = canvas.width, H = canvas.height;
  const PAD = 6;
  ctx.save();
  ctx.strokeStyle = '#4a6cf7';
  ctx.lineWidth = 0.75;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.6;

  let x, y, w, h;
  if (shape.type === 'rect') {
    x = Math.min(shape.x1, shape.x2) * W + dx - PAD;
    y = Math.min(shape.y1, shape.y2) * H + dy - PAD;
    w = Math.abs(shape.x2 - shape.x1) * W + PAD * 2;
    h = Math.abs(shape.y2 - shape.y1) * H + PAD * 2;
  } else if (shape.type === 'circle') {
    const prx = (shape.rx || shape.r) * W + PAD;
    const pry = (shape.ry || shape.r) * H + PAD;
    x = shape.cx * W + dx - prx;
    y = shape.cy * H + dy - pry;
    w = prx * 2; h = pry * 2;
  } else if (shape.type === 'line') {
    x = Math.min(shape.x1, shape.x2) * W + dx - PAD;
    y = Math.min(shape.y1, shape.y2) * H + dy - PAD;
    w = Math.abs(shape.x2 - shape.x1) * W + PAD * 2;
    h = Math.abs(shape.y2 - shape.y1) * H + PAD * 2;
  } else if (shape.type === 'image') {
    const iw = shape.w * W;
    const ih = shape.h * H;
    x = shape.cx * W + dx - iw / 2 - PAD;
    y = shape.cy * H + dy - ih / 2 - PAD;
    w = iw + PAD * 2; h = ih + PAD * 2;
  } else if (shape.type === 'text') {
    const fs = shape.fontSize * Math.min(W, H) * (shape.scale || 1);
    const approxW = shape.text.length * fs * 0.55;
    x = shape.cx * W + dx - approxW / 2 - PAD;
    y = shape.cy * H + dy - fs - PAD;
    w = approxW + PAD * 2; h = fs * 1.4 + PAD * 2;
  }

  if (w !== undefined) ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ─── DELETE BUTTON ────────────────────────────────────────────────────────────
function doDelete() {
  if (isRecording || isPlaying || isDrawing) return;
  const layer = layers[activeLayer];
  if (!layer.animation && !layer.shape) {
    if (layers.length === 1) return; // keep at least one layer
    const tabs = [...document.querySelectorAll('.layer-tab')];
    layers.splice(activeLayer, 1);
    tabs[activeLayer].remove();
    activeLayer = Math.min(activeLayer, layers.length - 1);
    updateLayerTabs();
    drawFrame(playheadPct);
    setStatus('Empty layer removed.');
    markUnsaved();
    return;
  }

  if (layer.animation) {
    // First delete: clear animation only, keep the shape
    layer.animation = null;
    updateLayerTabs();
    drawFrame(playheadPct);
    checkExportReady();
    setStatus(`Animation cleared from ${layerLabel(activeLayer)}. Delete again to remove the object.`);
    markUnsaved();
  } else if (layer.shape) {
    if (layers.length === 1) {
      // Last remaining layer — just clear it, don't remove the tab
      layer.shape = null;
      updateLayerTabs();
      drawFrame(playheadPct);
      checkExportReady();
      setStatus(`${layerLabel(activeLayer)} cleared.`);
      setAppMode('draw');
      markUnsaved();
    } else {
      // Remove the layer and its tab entirely
      const name = layerLabel(activeLayer);
      layers.splice(activeLayer, 1);
      const tabs = [...document.querySelectorAll('.layer-tab')];
      tabs[activeLayer].remove();
      activeLayer = Math.min(activeLayer, layers.length - 1);
      updateLayerTabs();
      drawFrame(playheadPct);
      checkExportReady();
      setStatus(`${name} removed.`);
      setAppMode('draw');
      markUnsaved();
    }
  }
}

document.querySelectorAll('.delete-btn').forEach(btn => {
  btn.addEventListener('click', doDelete);
});

// ─── TOOL SELECTION ───────────────────────────────────────────────────────────
document.querySelectorAll('.tool-btn[id^="tool-"]:not(#tool-image)').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.id.replace('tool-', '');
    updateCursor();
  });
});

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────
document.getElementById('tool-image').addEventListener('click', () => {
  if (isRecording || isDrawing) return;
  document.getElementById('image-input').click();
});

document.getElementById('image-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  // Reset so the same file can be re-selected
  e.target.value = '';

  // Use FileReader to load as a data URL — Chrome treats data URLs as
  // same-origin so drawImage won't taint the canvas, keeping captureStream
  // working correctly during export.
  const reader = new FileReader();
  reader.onload = re => {
    const img = new Image();
    img.onload = () => {
      const aspect = img.naturalWidth / img.naturalHeight;
      let w, h;
      // Fit image so its longest dimension is 40% of the canvas
      if (aspect >= 1) {
        w = 0.4;
        h = 0.4 / aspect * (canvas.width / canvas.height);
      } else {
        h = 0.4;
        w = 0.4 * aspect * (canvas.height / canvas.width);
      }
      const shape = { type: 'image', img, cx: 0.5, cy: 0.5, w, h, scale: 1.0 };
      ensureLayerForNewShape();
      layers[activeLayer].shape = shape;
      layers[activeLayer].animation = null;
      updateLayerTabs();
      drawFrame(playheadPct);
      checkExportReady();
      setStatus(`Image placed on canvas ${activeLayer + 1}. Resize from top toolbar.`);
      markUnsaved();
    };
    img.src = re.target.result;
  };
  reader.readAsDataURL(file);
});


const colorInput  = document.getElementById('color-input');
const colorPreview = document.getElementById('color-preview');
const toolbarSizeWrap = document.getElementById('toolbar-size-wrap');
const toolbarSize    = document.getElementById('toolbar-size');
const toolbarSizeVal = document.getElementById('toolbar-size-val');

// Sync toolbar colour + size controls to reflect the active layer's shape.
// Called whenever the active layer changes or a shape is placed/modified.
function syncToolbarToLayer() {
  const shape = layers[activeLayer] && layers[activeLayer].shape;
  if (!shape || appMode !== 'draw') {
    toolbarSizeWrap.classList.remove('active');
    return;
  }
  toolbarSizeWrap.classList.add('active');
  if (shape.type !== 'image') {
    colorInput.value = shape.color;
    colorPreview.style.background = shape.color;
  }
  const pct = Math.round((shape.scale || 1) * 100);
  toolbarSize.value = pct;
  toolbarSizeVal.textContent = pct + '%';
}

colorInput.addEventListener('input', e => {
  currentColor = e.target.value;
  colorPreview.style.background = currentColor;
  if (appMode !== 'draw') return;
  const shape = layers[activeLayer] && layers[activeLayer].shape;
  if (shape && shape.type !== 'image') {
    shape.color = e.target.value;
    drawFrame(playheadPct);
    markUnsaved();
  }
});

toolbarSize.addEventListener('input', e => {
  toolbarSizeVal.textContent = e.target.value + '%';
  if (appMode !== 'draw') return;
  const shape = layers[activeLayer] && layers[activeLayer].shape;
  if (!shape) return;
  applyScale(shape, parseInt(e.target.value) / 100);
  drawFrame(playheadPct);
  markUnsaved();
});

function updateCursor() {
  canvas.style.cursor = (appMode === 'draw' && currentTool) ? 'crosshair' : 'default';
}

// ─── MODE SWITCHING ───────────────────────────────────────────────────────────
const btnDraw   = document.getElementById('btn-draw');
const btnRecord = document.getElementById('btn-record');

btnDraw.addEventListener('click', () => {
  if (isRecording || isDrawing || isPlaying) return;
  setAppMode('draw');
});

btnRecord.addEventListener('click', () => {
  if (isRecording || isDrawing || isPlaying) return;
  setAppMode('record');
});

// Initialise pill position once layout is ready
requestAnimationFrame(updateModePill);

function updateModePill() {
  const pill = document.getElementById('mode-pill');
  const activeBtn = appMode === 'draw' ? btnDraw : btnRecord;
  pill.style.width = activeBtn.offsetWidth + 'px';
  pill.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
  pill.classList.toggle('animate', appMode === 'record');
}

function setAppMode(mode) {
  appMode = mode;
  // Active / inactive states
  btnDraw.classList.toggle('active', mode === 'draw');
  btnRecord.classList.toggle('active', mode === 'record');
  updateModePill();
  document.getElementById('draw-tools').classList.toggle('hidden', mode !== 'draw');
  document.getElementById('record-tools').classList.toggle('hidden', mode !== 'record');
  if (mode === 'draw') {
    currentTool = null;
    document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(b => b.classList.remove('active'));
    setStatus('Draw — add an image, text or shape to the canvas, edit objects from top toolbar');
  } else {
    setStatus('Animate — press REC to record motion and move your mouse on the trackpad');
  }
  updateCursor();
  syncToolbarToLayer();
}

// ─── LAYER TABS ───────────────────────────────────────────────────────────────
// Returns a short display label for a layer, e.g. "CIRCLE 1", "RECT 2", "LINE 3"
function layerLabel(idx) {
  const shape = layers[idx] && layers[idx].shape;
  const typeName = shape ? shape.type.toUpperCase() : 'LAYER';
  return `${typeName} ${idx + 1}`;
}

function updateLayerTabs() {
  document.querySelectorAll('.layer-tab').forEach((tab, i) => {
    tab.dataset.layer = i; // keep in sync after drag reorder
    const layer = layers[i];
    tab.classList.remove('active', 'has-shape', 'has-animation');
    if (i === activeLayer) tab.classList.add('active');
    if (layer && layer.animation) tab.classList.add('has-animation');
    else if (layer && layer.shape) tab.classList.add('has-shape');
    tab.textContent = layerLabel(i);
  });
  syncToolbarToLayer();
}

// ─── LAYER DRAG-TO-REORDER ────────────────────────────────────────────────────
let dragFromIdx = null;

function attachTabListeners(tab) {
  tab.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    activeLayer = parseInt(tab.dataset.layer);
    updateLayerTabs();
    drawFrame(playheadPct);
    setStatus(`${layerLabel(activeLayer)} selected.`);
  });

  tab.setAttribute('draggable', 'true');

  tab.addEventListener('dragstart', e => {
    if (isRecording || isDrawing) { e.preventDefault(); return; }
    dragFromIdx = parseInt(tab.dataset.layer);
    e.dataTransfer.effectAllowed = 'move';
    tab.classList.add('dragging');
  });

  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    document.querySelectorAll('.layer-tab').forEach(t => t.classList.remove('drag-over'));
  });

  tab.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.layer-tab').forEach(t => t.classList.remove('drag-over'));
    tab.classList.add('drag-over');
  });

  tab.addEventListener('drop', e => {
    e.preventDefault();
    const dragToIdx = parseInt(tab.dataset.layer);
    if (dragFromIdx === null || dragFromIdx === dragToIdx) return;

    // Reorder layers array
    const [moved] = layers.splice(dragFromIdx, 1);
    layers.splice(dragToIdx, 0, moved);

    // Reorder DOM tabs to match
    const row = document.getElementById('layer-row');
    const tabs = [...document.querySelectorAll('.layer-tab')];
    const draggedTab = tabs[dragFromIdx];
    const targetTab  = tabs[dragToIdx];
    if (dragToIdx < dragFromIdx) {
      row.insertBefore(draggedTab, targetTab);
    } else {
      targetTab.after(draggedTab);
    }

    // Keep activeLayer pointing at the same layer data
    if (activeLayer === dragFromIdx) {
      activeLayer = dragToIdx;
    } else if (dragFromIdx < dragToIdx) {
      if (activeLayer > dragFromIdx && activeLayer <= dragToIdx) activeLayer--;
    } else {
      if (activeLayer >= dragToIdx && activeLayer < dragFromIdx) activeLayer++;
    }

    dragFromIdx = null;
    updateLayerTabs();
    drawFrame(playheadPct);
    markUnsaved();
  });
}

document.querySelectorAll('.layer-tab').forEach(tab => attachTabListeners(tab));

// Allow drops anywhere on the row, not just exactly on a tab
document.getElementById('layer-row').addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
document.getElementById('layer-row').addEventListener('dragleave', e => {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    document.querySelectorAll('.layer-tab').forEach(t => t.classList.remove('drag-over'));
  }
});

document.getElementById('add-layer-btn').addEventListener('click', () => {
  if (layers.length >= MAX_LAYERS) return;
  layers.push({ shape: null, animation: null });
  const row = document.getElementById('layer-row');
  const addBtn = document.getElementById('add-layer-btn');
  const tab = document.createElement('button');
  tab.className = 'layer-tab';
  tab.dataset.layer = layers.length - 1;
  tab.textContent = layerLabel(layers.length - 1);
  attachTabListeners(tab);
  row.insertBefore(tab, addBtn);
  activeLayer = layers.length - 1;
  updateLayerTabs();
  markUnsaved();
});

// Creates a new empty layer and activates it (called after placing a shape/image)
function autoAdvanceLayer() {
  if (layers.length >= MAX_LAYERS) return;
  layers.push({ shape: null, animation: null });
  const row    = document.getElementById('layer-row');
  const addBtn = document.getElementById('add-layer-btn');
  const tab    = document.createElement('button');
  tab.className    = 'layer-tab';
  tab.dataset.layer = layers.length - 1;
  tab.textContent  = layerLabel(layers.length - 1);
  attachTabListeners(tab);
  row.insertBefore(tab, addBtn);
  activeLayer = layers.length - 1;
  updateLayerTabs();
}

function ensureLayerForNewShape() {
  if (layers[activeLayer].shape) autoAdvanceLayer();
}

// ─── SHAPE HIT TEST ───────────────────────────────────────────────────────────
function hitTestShape(shape, px, py) {
  if (!shape) return false;
  const W = canvas.width, H = canvas.height;
  if (shape.type === 'rect') {
    return px >= Math.min(shape.x1, shape.x2) && px <= Math.max(shape.x1, shape.x2) &&
           py >= Math.min(shape.y1, shape.y2) && py <= Math.max(shape.y1, shape.y2);
  } else if (shape.type === 'circle') {
    const dx = (px - shape.cx) * W, dy = (py - shape.cy) * H;
    const prx = (shape.rx || shape.r) * W, pry = (shape.ry || shape.r) * H;
    return (dx * dx) / (prx * prx) + (dy * dy) / (pry * pry) <= 1;
  } else if (shape.type === 'line') {
    const x1 = shape.x1*W, y1 = shape.y1*H, x2 = shape.x2*W, y2 = shape.y2*H;
    const mx = px*W, my = py*H;
    const len2 = (x2-x1)**2 + (y2-y1)**2;
    if (len2 === 0) return Math.hypot(mx-x1, my-y1) < 12;
    const t = Math.max(0, Math.min(1, ((mx-x1)*(x2-x1)+(my-y1)*(y2-y1)) / len2));
    return Math.hypot(mx-(x1+t*(x2-x1)), my-(y1+t*(y2-y1))) < 12;
  } else if (shape.type === 'image') {
    return px >= shape.cx - shape.w / 2 && px <= shape.cx + shape.w / 2 &&
           py >= shape.cy - shape.h / 2 && py <= shape.cy + shape.h / 2;
  } else if (shape.type === 'text') {
    ctx.font = `500 ${shape.fontSize * canvas.height * (shape.scale || 1.0)}px 'Geist', sans-serif`;
    const metrics = ctx.measureText(shape.text);
    const hw = (metrics.width / canvas.width) / 2 + 0.01;
    const hh = shape.fontSize * (shape.scale || 1.0) * 0.8;
    return Math.abs(px - shape.cx) < hw && Math.abs(py - shape.cy) < hh;
  }
  return false;
}

// ─── SHAPE INSPECTOR ─────────────────────────────────────────────────────────
const inspector    = document.getElementById('inspector');
const inspColor    = document.getElementById('insp-color');
const inspColorPrev= document.getElementById('insp-color-preview');
const inspSize     = document.getElementById('insp-size');
const inspSizeVal  = document.getElementById('insp-size-val');
let   inspecting   = false;

function openInspector(shape, anchorX, anchorY) {
  inspecting = true;
  const isImage = shape.type === 'image';
  document.getElementById('inspector-title').textContent = shape.type.toUpperCase();
  // Image has no color property; all other types (rect, circle, line, text) do
  document.getElementById('insp-color-row').style.display = isImage ? 'none' : '';
  if (!isImage) {
    inspColor.value = shape.color;
    inspColorPrev.style.background = shape.color;
  }

  if (shape.scale == null) shape.scale = 1.0;
  const pct = Math.round(shape.scale * 100);
  inspSize.value = pct;
  inspSizeVal.textContent = pct + '%';

  // Position near click. anchorX/Y are relative to canvas-area,
  // which is the inspector's offset parent (position:relative).
  const iW = 236, iH = 180;
  const areaW = canvasArea.clientWidth, areaH = canvasArea.clientHeight;
  let left = anchorX + 12;
  let top  = anchorY - 20;
  if (left + iW > areaW)  left = anchorX - iW - 12;
  if (top  + iH > areaH) top  = areaH - iH - 8;
  if (top  < 4)  top  = 4;
  if (left < 4)  left = 4;
  inspector.style.left = left + 'px';
  inspector.style.top  = top  + 'px';
  inspector.classList.add('visible');
}

function closeInspector() {
  inspector.classList.remove('visible');
  inspecting = false;
  drawFrame(playheadPct);
  markUnsaved();
}

inspColor.addEventListener('input', e => {
  const layer = layers[activeLayer];
  if (!layer.shape) return;
  layer.shape.color = e.target.value;
  inspColorPrev.style.background = e.target.value;
  drawFrame(playheadPct);
});

inspSize.addEventListener('input', e => {
  const layer = layers[activeLayer];
  if (!layer.shape) return;
  const scale = parseInt(e.target.value) / 100;
  inspSizeVal.textContent = e.target.value + '%';
  applyScale(layer.shape, scale);
  drawFrame(playheadPct);
});

document.getElementById('insp-close').addEventListener('click', closeInspector);

function applyScale(shape, newScale) {
  if (shape.scale == null) shape.scale = 1.0;
  const ratio = newScale / shape.scale;
  shape.scale = newScale;
  if (shape.type === 'rect') {
    const cx = (shape.x1 + shape.x2) / 2, cy = (shape.y1 + shape.y2) / 2;
    const hw = (shape.x2 - shape.x1) / 2 * ratio;
    const hh = (shape.y2 - shape.y1) / 2 * ratio;
    shape.x1 = cx - hw; shape.x2 = cx + hw;
    shape.y1 = cy - hh; shape.y2 = cy + hh;
  } else if (shape.type === 'circle') {
    if (shape.rx != null) { shape.rx *= ratio; shape.ry *= ratio; }
    else shape.r *= ratio;
  } else if (shape.type === 'line') {
    const cx = (shape.x1 + shape.x2) / 2, cy = (shape.y1 + shape.y2) / 2;
    const dx1 = (shape.x1 - cx) * ratio, dy1 = (shape.y1 - cy) * ratio;
    const dx2 = (shape.x2 - cx) * ratio, dy2 = (shape.y2 - cy) * ratio;
    shape.x1 = cx + dx1; shape.y1 = cy + dy1;
    shape.x2 = cx + dx2; shape.y2 = cy + dy2;
  } else if (shape.type === 'image') {
    shape.w *= ratio;
    shape.h *= ratio;
  }
  // text: fontSize stays fixed; scale multiplier handles sizing — nothing extra to do
}

// Close inspector when clicking outside it (canvas clicks handled separately below)
document.addEventListener('mousedown', e => {
  if (inspecting && !inspector.contains(e.target) && e.target !== canvas) {
    closeInspector();
  }
});

// ─── DRAW ON CANVAS ───────────────────────────────────────────────────────────
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / canvas.width,
    y: (e.clientY - r.top)  / canvas.height,
  };
}

function buildShapeFromDrag(start, end, shiftKey) {
  const minW = 8 / canvas.width, minH = 8 / canvas.height;

  if (currentTool === 'rect') {
    let x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
    if (shiftKey) {
      // Constrain to a square in pixel space
      const dxPx = (x2 - x1) * canvas.width;
      const dyPx = (y2 - y1) * canvas.height;
      const size = Math.min(Math.abs(dxPx), Math.abs(dyPx));
      x2 = x1 + Math.sign(dxPx || 1) * size / canvas.width;
      y2 = y1 + Math.sign(dyPx || 1) * size / canvas.height;
    }
    return { type: 'rect', color: currentColor,
      x1: Math.min(x1, x2), y1: Math.min(y1, y2),
      x2: Math.max(x1, x2) || x1 + minW,
      y2: Math.max(y1, y2) || y1 + minH,
    };
  } else if (currentTool === 'circle') {
    const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
    const dxPx = Math.abs(end.x - start.x) * canvas.width;
    const dyPx = Math.abs(end.y - start.y) * canvas.height;
    const minR = 4;
    let rx, ry;
    if (shiftKey) {
      // Shift → perfect circle, use smaller axis
      const sizePx = Math.max(Math.min(dxPx, dyPx), minR * 2);
      rx = sizePx / 2 / canvas.width;
      ry = sizePx / 2 / canvas.height;
    } else {
      // Default → free ellipse from drag extents
      rx = Math.max(dxPx / 2, minR) / canvas.width;
      ry = Math.max(dyPx / 2, minR) / canvas.height;
    }
    return { type: 'circle', color: currentColor, cx, cy, rx, ry };
  } else if (currentTool === 'line') {
    let x2 = end.x, y2 = end.y;
    if (shiftKey) {
      // Snap to nearest 45° increment in pixel space
      const dxPx = (end.x - start.x) * canvas.width;
      const dyPx = (end.y - start.y) * canvas.height;
      const angle   = Math.atan2(dyPx, dxPx);
      const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const mag = Math.hypot(dxPx, dyPx);
      x2 = start.x + Math.cos(snapped) * mag / canvas.width;
      y2 = start.y + Math.sin(snapped) * mag / canvas.height;
    }
    return { type: 'line', color: currentColor,
      x1: start.x, y1: start.y, x2, y2,
    };
  }
}

canvas.addEventListener('mousedown', e => {
  if (isRecording || isPlaying) return;

  const pos = canvasPos(e);
  const layer = layers[activeLayer];

  // Text tool: hitting an existing shape starts a drag-or-click (same as normal
  // draw mode); clicking empty canvas opens the text input.
  if (appMode === 'draw' && currentTool === 'text') {
    if (layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
      // Let the normal drag/click logic below handle this hit
      shapeDragStart    = pos;
      shapeDragSnap     = snapshotShape(layer.shape);
      shapeDragging     = false;
      shapeDragClientXY = { clientX: e.clientX, clientY: e.clientY };
      return;
    }
    // Clicking empty canvas → new text.
    // preventDefault stops the browser resetting focus away from the textarea.
    e.preventDefault();
    openTextInput(pos.x, pos.y, null);
    return;
  }

  if (!isDrawing && layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
    if (appMode === 'draw') {
      // May become a drag-move or a click; decide on mouseup / mousemove
      shapeDragStart    = pos;
      shapeDragSnap     = snapshotShape(layer.shape);
      shapeDragging     = false;
      shapeDragClientXY = { clientX: e.clientX, clientY: e.clientY };
    }
    return;
  }

  if (appMode !== 'draw') return;
  if (!currentTool) return;
  if (inspecting) { closeInspector(); return; }
  isDrawing = true;
  drawStart = pos;
});

canvas.addEventListener('mousemove', e => {
  // ── Shape drag-move in draw mode ──
  if (shapeDragStart) {
    const cur  = canvasPos(e);
    const ndx  = cur.x - shapeDragStart.x;
    const ndy  = cur.y - shapeDragStart.y;
    if (!shapeDragging && Math.hypot(ndx * canvas.width, ndy * canvas.height) > 4)
      shapeDragging = true;
    if (shapeDragging) {
      const layer = layers[activeLayer];
      if (layer.shape) { moveShapeByDelta(layer.shape, shapeDragSnap, ndx, ndy); drawFrame(playheadPct); }
      canvas.style.cursor = 'grabbing';
    }
    return;
  }

  // ── Hover cursor ──
  if (!isDrawing && !isRecording && !isPlaying) {
    const hPos   = canvasPos(e);
    const hLayer = layers[activeLayer];
    if (hLayer.shape && hitTestShape(hLayer.shape, hPos.x, hPos.y)) {
      canvas.style.cursor = appMode === 'draw' ? 'grab' : 'pointer';
    } else {
      updateCursor();
    }
  }

  if (appMode === 'draw' && isDrawing && drawStart) {
    const cur = canvasPos(e);
    const ghost = buildShapeFromDrag(drawStart, cur, e.shiftKey);
    drawFrame(playheadPct);
    if (ghost) drawGhost(ghost);
    return;
  }

  // recording path capture
  if (appMode === 'record' && isRecording) {
    const r = canvas.getBoundingClientRect();
    let x = (e.clientX - r.left) / canvas.width;
    let y = (e.clientY - r.top)  / canvas.height;

    if (e.shiftKey && recordedPath.length > 0) {
      const origin = recordedPath[0];
      const dx = Math.abs(x - origin.x);
      const dy = Math.abs(y - origin.y);
      if (dx >= dy) y = origin.y;
      else          x = origin.x;
    }

    const t = performance.now();
    if (!recordStartTime) recordStartTime = t;
    const elapsed = (t - recordStartTime) / 1000;
    recordedPath.push({ t: elapsed, x, y });

    drawFrame(0);
    const layer = layers[activeLayer];
    if (layer.shape) {
      const centre = shapeCentre(layer.shape);
      // Use same offset as stopRecording so live preview matches final animation
      const xOff = centre.x - recordedPath[0].x;
      const yOff = centre.y - recordedPath[0].y;
      drawShape(layer.shape, (x + xOff - centre.x) * canvas.width, (y + yOff - centre.y) * canvas.height);
    }
    if (recordedPath.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(74,108,247,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      recordedPath.forEach((p, i) => {
        const px = p.x * canvas.width, py = p.y * canvas.height;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }
    if (elapsed >= recordDuration) stopRecording();
  }
});

canvas.addEventListener('mouseup', e => {
  // ── Finish shape drag / treat as click ──
  if (shapeDragStart) {
    if (shapeDragging) {
      // Shape was moved — persist the new position
      markUnsaved();
    }
    shapeDragStart = shapeDragSnap = shapeDragClientXY = null;
    shapeDragging = false;
    updateCursor();
    return;
  }

  if (appMode !== 'draw' || !isDrawing || !drawStart) return;
  isDrawing = false;
  const end = canvasPos(e);
  const shape = buildShapeFromDrag(drawStart, end, e.shiftKey);
  drawStart = null;
  if (!shape) return;

  const tooSmall = (shape.type === 'circle' && Math.min((shape.rx || shape.r) * canvas.width, (shape.ry || shape.r) * canvas.height) < 4) ||
                   (shape.type !== 'circle' && Math.abs(shape.x2 - shape.x1) * canvas.width < 4 &&
                    Math.abs(shape.y2 - shape.y1) * canvas.height < 4);
  if (tooSmall) { drawFrame(playheadPct); return; }

  ensureLayerForNewShape();
  layers[activeLayer].shape = shape;
  layers[activeLayer].animation = null;
  updateLayerTabs();
  drawFrame(playheadPct);
  checkExportReady();
  setStatus(`${layerLabel(activeLayer)} drawn. Change color or size from top toolbar.`);
  markUnsaved();
});

canvas.addEventListener('mouseleave', e => {
  if (shapeDragStart) {
    shapeDragStart = shapeDragSnap = shapeDragClientXY = null;
    shapeDragging = false;
    updateCursor();
  }
  if (isDrawing) {
    isDrawing = false;
    const end = canvasPos(e);
    const shape = buildShapeFromDrag(drawStart || end, end);
    drawStart = null;
    if (shape) {
      ensureLayerForNewShape();
      layers[activeLayer].shape = shape;
      layers[activeLayer].animation = null;
      updateLayerTabs();
      checkExportReady();
      markUnsaved();
    }
    drawFrame(playheadPct);
  }
  if (appMode === 'record' && isRecording && recordedPath.length > 5) stopRecording();
  updateCursor();
});

// ─── TOUCH SUPPORT ────────────────────────────────────────────────────────────
// Extract a {clientX, clientY} pair from a touch or mouse event
function touchPt(e) {
  const t = e.touches && e.touches.length ? e.touches[0] : e.changedTouches[0];
  return { clientX: t.clientX, clientY: t.clientY };
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (isRecording || isPlaying) return;
  const pt  = touchPt(e);
  const pos = canvasPos(pt);
  const layer = layers[activeLayer];

  // Text tool: hitting an existing shape starts drag-or-click; empty area → new text.
  if (appMode === 'draw' && currentTool === 'text') {
    if (layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
      shapeDragStart    = pos;
      shapeDragSnap     = snapshotShape(layer.shape);
      shapeDragging     = false;
      shapeDragClientXY = { clientX: pt.clientX, clientY: pt.clientY };
      return;
    }
    e.preventDefault();
    openTextInput(pos.x, pos.y, null);
    return;
  }

  if (!isDrawing && layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
    if (appMode === 'draw') {
      shapeDragStart    = pos;
      shapeDragSnap     = snapshotShape(layer.shape);
      shapeDragging     = false;
      shapeDragClientXY = { clientX: pt.clientX, clientY: pt.clientY };
    }
    return;
  }

  if (appMode !== 'draw') return;
  if (!currentTool) return;
  if (inspecting) { closeInspector(); return; }
  isDrawing = true;
  drawStart = pos;
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const pt = touchPt(e);

  // ── Shape drag-move (touch) ──
  if (shapeDragStart) {
    const cur = canvasPos(pt);
    const ndx = cur.x - shapeDragStart.x;
    const ndy = cur.y - shapeDragStart.y;
    if (!shapeDragging && Math.hypot(ndx * canvas.width, ndy * canvas.height) > 4)
      shapeDragging = true;
    if (shapeDragging) {
      const layer = layers[activeLayer];
      if (layer.shape) { moveShapeByDelta(layer.shape, shapeDragSnap, ndx, ndy); drawFrame(playheadPct); }
    }
    return;
  }

  if (appMode === 'draw' && isDrawing && drawStart) {
    const cur   = canvasPos(pt);
    const ghost = buildShapeFromDrag(drawStart, cur);
    drawFrame(playheadPct);
    if (ghost) drawGhost(ghost);
    return;
  }

  if (appMode === 'record' && isRecording) {
    const r = canvas.getBoundingClientRect();
    const x = (pt.clientX - r.left) / canvas.width;
    const y = (pt.clientY - r.top)  / canvas.height;
    const t = performance.now();
    if (!recordStartTime) recordStartTime = t;
    const elapsed = (t - recordStartTime) / 1000;
    recordedPath.push({ t: elapsed, x, y });

    drawFrame(0);
    const layer = layers[activeLayer];
    if (layer.shape) {
      const centre = shapeCentre(layer.shape);
      const xOff = centre.x - recordedPath[0].x;
      const yOff = centre.y - recordedPath[0].y;
      drawShape(layer.shape, (x + xOff - centre.x) * canvas.width, (y + yOff - centre.y) * canvas.height);
    }
    // Draw trail
    if (recordedPath.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(74,108,247,0.25)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      recordedPath.forEach((p, i) => {
        const px = p.x * canvas.width, py = p.y * canvas.height;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }
    if (elapsed >= recordDuration) stopRecording();
  }
}, { passive: false });

let lastTapTime = 0;
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  if (shapeDragStart) {
    if (shapeDragging) markUnsaved();
    shapeDragStart = shapeDragSnap = shapeDragClientXY = null;
    shapeDragging = false;
    return;
  }
  if (appMode !== 'draw' || !isDrawing || !drawStart) {
    // Double-tap to edit text (when not mid-draw and no shape drag)
    const now = Date.now();
    if (now - lastTapTime < 300) {
      const pt  = touchPt(e);
      const pos = canvasPos(pt);
      const layer = layers[activeLayer];
      if (layer.shape && layer.shape.type === 'text' && hitTestShape(layer.shape, pos.x, pos.y)) {
        openTextInput(layer.shape.cx, layer.shape.cy, layer.shape);
      }
    }
    lastTapTime = now;
    return;
  }
  isDrawing = false;
  const pt    = touchPt(e);
  const end   = canvasPos(pt);
  const shape = buildShapeFromDrag(drawStart, end);
  drawStart   = null;
  if (!shape) return;

  const tooSmall =
    (shape.type === 'circle' && Math.min((shape.rx || shape.r) * canvas.width, (shape.ry || shape.r) * canvas.height) < 4) ||
    (shape.type !== 'circle' && Math.abs(shape.x2 - shape.x1) * canvas.width  < 4 &&
                                Math.abs(shape.y2 - shape.y1) * canvas.height < 4);
  if (tooSmall) { drawFrame(playheadPct); return; }

  ensureLayerForNewShape();
  layers[activeLayer].shape     = shape;
  layers[activeLayer].animation = null;
  updateLayerTabs();
  drawFrame(playheadPct);
  checkExportReady();
  setStatus(`${layerLabel(activeLayer)} drawn. Edit from top toolbar.`);
  markUnsaved();
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  if (isDrawing) { isDrawing = false; drawStart = null; drawFrame(playheadPct); }
  if (appMode === 'record' && isRecording && recordedPath.length > 5) stopRecording();
});

// ─── TEXT TOOL ────────────────────────────────────────────────────────────────
let editingTextShape = null; // the shape being edited (null = new)
let editingTextLayer = -1;

function openTextInput(cx, cy, shape) {
  editingTextShape = shape;
  editingTextLayer = activeLayer;

  const input = document.getElementById('text-edit-input');

  const fontSize = shape
    ? shape.fontSize * canvas.height * (shape.scale || 1.0)
    : 0.07 * canvas.height;

  // Position relative to the viewport (input is position:fixed)
  const canvasR = canvas.getBoundingClientRect();
  const screenX = canvasR.left + cx * canvas.width;
  const screenY = canvasR.top  + cy * canvas.height;

  input.value = shape ? shape.text : '';
  input.style.fontSize   = fontSize + 'px';
  input.style.color      = shape ? shape.color : '#000000';
  input.style.left       = screenX + 'px';
  input.style.top        = (screenY - fontSize * 0.6) + 'px';
  input.style.width      = '120px';

  input.dataset.cx = cx;
  input.dataset.cy = cy;

  input.classList.remove('hidden');
  // Defer focus so the browser finishes processing mousedown before we take focus
  setTimeout(() => { input.focus(); if (shape) input.select(); }, 0);

  // Grow width as the user types
  function resize() {
    input.style.width = '2px';
    input.style.width = Math.max(120, input.scrollWidth + 16) + 'px';
  }
  input.oninput = resize;
  resize();
}

function commitTextInput() {
  const input = document.getElementById('text-edit-input');
  // Guard: if already hidden, a previous commit already ran (e.g. Enter → blur double-fire)
  if (input.classList.contains('hidden')) return;

  const text = input.value.trim();
  // Hide first, then clear value so a blur-triggered second call sees empty string & bails
  input.classList.add('hidden');
  input.value = '';

  if (!text) {
    editingTextShape = null;
    return;
  }

  const cx = parseFloat(input.dataset.cx);
  const cy = parseFloat(input.dataset.cy);

  if (editingTextShape) {
    editingTextShape.text = text;
  } else {
    const shape = {
      type: 'text',
      text,
      cx,
      cy,
      color: '#000000',
      fontSize: 0.07,
      scale: 1.0,
    };
    ensureLayerForNewShape();
    layers[activeLayer].shape     = shape;
    layers[activeLayer].animation = null;
    updateLayerTabs();
    checkExportReady();
    setStatus(`Text placed on layer ${activeLayer + 1}. Change color or size from top toolbar.`);
  }

  editingTextShape = null;
  drawFrame(playheadPct);
  markUnsaved();
}

// Wire up commit on Enter / Escape / blur
const textInput = document.getElementById('text-edit-input');
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); commitTextInput(); }
  if (e.key === 'Escape') { textInput.classList.add('hidden'); editingTextShape = null; }
});
textInput.addEventListener('blur', commitTextInput);

// Double-click to edit existing text shape
canvas.addEventListener('dblclick', e => {
  if (appMode !== 'draw') return;
  const pos   = canvasPos(e);
  const layer = layers[activeLayer];
  if (layer.shape && layer.shape.type === 'text' && hitTestShape(layer.shape, pos.x, pos.y)) {
    openTextInput(layer.shape.cx, layer.shape.cy, layer.shape);
  }
});

// ─── RECORDING ────────────────────────────────────────────────────────────────
const recBtn = document.getElementById('rec-btn');
const recOverlay = document.getElementById('rec-overlay');
const recTimerEl = document.getElementById('rec-timer');

recBtn.addEventListener('click', () => {
  if (isPlaying || isDrawing) return;
  if (!layers[activeLayer].shape) {
    setStatus('Draw a shape on this layer first');
    setAppMode('draw');
    return;
  }
  if (isRecording) stopRecording();
  else startRecording();
});

function startRecording() {
  isRecording = true;
  recordedPath = [];
  recordStartTime = null;
  recordDuration = parseInt(document.getElementById('duration-select').value);
  recBtn.classList.add('recording');
  recOverlay.classList.add('visible');
  setAppMode('record');
  setStatus('Recording… move your mouse over the canvas.');
  canvas.style.cursor = 'none';

  recTimerInterval = setInterval(() => {
    if (!recordStartTime) return;
    const elapsed = (performance.now() - recordStartTime) / 1000;
    recTimerEl.textContent = elapsed.toFixed(1) + 's';
    if (elapsed >= recordDuration) stopRecording();
  }, 50);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(recTimerInterval);
  recBtn.classList.remove('recording');
  recOverlay.classList.remove('visible');
  canvas.style.cursor = 'crosshair';

  if (recordedPath.length > 1) {
    const t0 = recordedPath[0].t;
    const actualDur = (recordedPath[recordedPath.length-1].t - t0).toFixed(1);
    // Offset so the first point maps to the shape's current centre → no jump at t=0
    const centre = shapeCentre(layers[activeLayer].shape);
    const xOff = centre.x - recordedPath[0].x;
    const yOff = centre.y - recordedPath[0].y;
    const norm = recordedPath.map(p => ({
      t: p.t - t0,
      x: p.x + xOff, y: p.y + yOff,
    }));
    layers[activeLayer].animation = norm;
    updateLayerTabs();
    setStatus(`Motion recorded · ${actualDur}s. Press ▶ or SPACE to play.`);
    checkExportReady();
    setPlayhead(0);
    drawFrame(0);
    markUnsaved();
  } else {
    setStatus('Recording too short — try again.');
  }
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');

playBtn.addEventListener('click', () => {
  if (isRecording) return;
  if (isPlaying) { pausePlayback(); return; }
  startPlayback();
});

stopBtn.addEventListener('click', () => {
  stopPlayback();
});

function startPlayback() {
  const hasAny = layers.some(l => l.animation);
  if (!hasAny) { setStatus('No animations recorded yet.'); return; }
  isPlaying = true;
  recordDuration = parseInt(document.getElementById('duration-select').value);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="2" y="1" width="4" height="12" rx="1" fill="#ccc"/>
    <rect x="8" y="1" width="4" height="12" rx="1" fill="#ccc"/>
  </svg>`;
  playbackStart = performance.now() - playheadPct * recordDuration * 1000;

  function tick(now) {
    if (!isPlaying) return;
    const elapsed = (now - playbackStart) / 1000;
    const pct = Math.min(elapsed / recordDuration, 1);
    setPlayhead(pct);
    drawFrame(pct);
    if (pct >= 1) { stopPlayback(); return; }
    playbackRAF = requestAnimationFrame(tick);
  }
  playbackRAF = requestAnimationFrame(tick);
}

function pausePlayback() {
  isPlaying = false;
  cancelAnimationFrame(playbackRAF);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="#ccc"/></svg>`;
}

function stopPlayback() {
  isPlaying = false;
  cancelAnimationFrame(playbackRAF);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="#ccc"/></svg>`;
  setPlayhead(0);
  drawFrame(0);
}

// ─── TIMELINE SCRUB ───────────────────────────────────────────────────────────
const timelineTrack = document.getElementById('timeline-track');
const timelineFilled = document.getElementById('timeline-filled');
const timelineHead = document.getElementById('timeline-head');
const timeEnd = document.getElementById('time-end');

function setPlayhead(pct) {
  playheadPct = pct;
  timelineFilled.style.width = (pct * 100) + '%';
  timelineHead.style.left = (pct * 100) + '%';
  const secs = Math.round(pct * recordDuration);
  const m = String(Math.floor(secs/60)).padStart(2,'0');
  const s = String(secs%60).padStart(2,'0');
  document.getElementById('time-start').textContent = `${m}:${s}`;
}

document.getElementById('duration-select').addEventListener('change', e => {
  recordDuration = parseInt(e.target.value);
  const m = String(Math.floor(recordDuration/60)).padStart(2,'0');
  const s = String(recordDuration%60).padStart(2,'0');
  timeEnd.textContent = `${m}:${s}`;
});
timeEnd.textContent = '00:05';

timelineTrack.addEventListener('mousedown', e => {
  if (isRecording) return;
  scrubbing = true;
  pausePlayback();
  doScrub(e);
});
document.addEventListener('mousemove', e => {
  if (!scrubbing) return;
  doScrub(e);
});
document.addEventListener('mouseup', () => { scrubbing = false; });

// Touch scrubbing
timelineTrack.addEventListener('touchstart', e => {
  e.preventDefault();
  if (isRecording) return;
  scrubbing = true;
  pausePlayback();
  doScrub({ clientX: e.touches[0].clientX });
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (!scrubbing) return;
  doScrub({ clientX: e.touches[0].clientX });
}, { passive: false });
document.addEventListener('touchend', () => { scrubbing = false; });

function doScrub(e) {
  const r = timelineTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  setPlayhead(pct);
  drawFrame(pct);
}

// ─── LIVE GHOST UPDATE ON SHIFT PRESS/RELEASE ────────────────────────────────
// Track the last mouse position so we can re-draw the ghost when Shift changes
let lastMouseEvent = null;
canvas.addEventListener('mousemove', e => { lastMouseEvent = e; }, { passive: true });

function redrawGhostIfDrawing(shiftKey) {
  if (appMode === 'draw' && isDrawing && drawStart && lastMouseEvent) {
    const cur   = canvasPos(lastMouseEvent);
    const ghost = buildShapeFromDrag(drawStart, cur, shiftKey);
    drawFrame(playheadPct);
    if (ghost) drawGhost(ghost);
  }
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Shift') { redrawGhostIfDrawing(true); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === ' ') {
    e.preventDefault();
    if (appMode === 'record' && !isRecording) playBtn.click();
    return;
  }

  if (e.key === 'r' || e.key === 'R') recBtn.click();

  if ((e.key === 'l' || e.key === 'L') && appMode === 'draw') {
    document.getElementById('add-layer-btn').click();
  }

  // Escape closes the inspector
  if (e.key === 'Escape' && inspecting) {
    closeInspector();
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    doDelete();
  }
});

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ─── EXPORT MP4 ───────────────────────────────────────────────────────────────
function checkExportReady() {
  const hasAny = layers.some(l => l.animation && l.shape);
  document.getElementById('export-btn').disabled = !hasAny;
}

const exportBtn = document.getElementById('export-btn');
const modal = document.getElementById('modal');
const modalProgress = document.getElementById('modal-progress');
const modalStatus = document.getElementById('modal-status');
let exportCancelled = false;

exportBtn.addEventListener('click', async () => {
  if (exportBtn.disabled) return;
  modal.classList.add('visible');
  document.getElementById('modal-render-phase').classList.remove('hidden');
  document.getElementById('modal-save-phase').classList.add('hidden');
  exportCancelled = false;
  modalProgress.style.width = '0%';
  modalStatus.textContent = '';

  const W = canvas.width, H = canvas.height;
  const EW = W * 2, EH = H * 2;
  const totalFrames = Math.round(recordDuration * FPS);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = EW; offCanvas.height = EH;
  const offCtx = offCanvas.getContext('2d');

  const stream = offCanvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.start();

  for (let f = 0; f <= totalFrames; f++) {
    if (exportCancelled) { recorder.stop(); modal.classList.remove('visible'); return; }
    const pct = f / totalFrames;
    const t = pct * recordDuration;

    offCtx.clearRect(0, 0, EW, EH);
    offCtx.fillStyle = canvasBgColor;
    offCtx.fillRect(0, 0, EW, EH);

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.shape) continue;
      let dx = 0, dy = 0;
      if (layer.animation) {
        const centre = shapeCentre(layer.shape);
        const pos = getPositionAtTime(layer.animation, t);
        if (pos) {
          dx = (pos.x - centre.x) * EW;
          dy = (pos.y - centre.y) * EH;
        }
      }
      drawShapeCtx(offCtx, layer.shape, EW, EH, dx, dy);
    }

    modalProgress.style.width = (pct * 100) + '%';
    modalStatus.textContent = `Frame ${f} / ${totalFrames}`;
    await new Promise(r => setTimeout(r, 1000 / FPS));
  }

  recorder.stop();
  await new Promise(r => recorder.onstop = r);

  if (exportCancelled) { modal.classList.remove('visible'); return; }

  const blob = new Blob(chunks, { type: 'video/webm' });
  const exportUrl = URL.createObjectURL(blob);

  // Switch to save phase
  document.getElementById('modal-render-phase').classList.add('hidden');
  const savePhase = document.getElementById('modal-save-phase');
  savePhase.classList.remove('hidden');
  const filenameInput = document.getElementById('modal-filename');
  filenameInput.value = '';
  filenameInput.focus();

  document.getElementById('modal-save-done').onclick = () => {
    const filename = (filenameInput.value.trim() || 'motion') + '.webm';
    const a = document.createElement('a');
    a.href = exportUrl; a.download = filename; a.click();
    URL.revokeObjectURL(exportUrl);
    modal.classList.remove('visible');
  };

  document.getElementById('modal-save-cancel').onclick = () => {
    URL.revokeObjectURL(exportUrl);
    modal.classList.remove('visible');
  };
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  exportCancelled = true;
  modal.classList.remove('visible');
});

// ─── HELP / INFO MODAL ────────────────────────────────────────────────────────
const HELP_STEPS = [
  {
    title: 'Draw',
    body: 'Select an image, text or shape from the toolbar and add or drag it onto the canvas. You can add or switch between objects through the bottom panel. ',
  },
  {
    title: 'Edit',
    body: 'When an object is selected from the bottom panel, highlighted with a blue outline, you can change the size and color of the shape, text or image from the top toolbar. ',
  },
  {
    title: 'Canvas',
    body: 'The button on the top left corner lets you change the canvas size and background color.',
  },
  {
    title: 'Animate',
    body: 'Press the animate button to switch to animate mode. To animate a shape hit the REC button (or press <strong>R</strong>), then move your cursor across the canvas; objects will move from their center point. You can edit the duration at anytime.',
  },
  {
    title: 'Axis-lock',
    body: 'While recording, hold Shift to lock movement to a single axis, horizontal or vertical, based on your initial direction.',
  },
  {
    title: 'Playback',
    body: 'Once recording stops, press <strong>SPACE</strong> or the <strong>▶ Play</strong> button to watch your shape animate along the recorded path. You can also scrub the timeline to jump to any moment.',
  },
  {
    title: 'Delete',
    body: 'With an object selected from the bottom panel, press <strong>Delete</strong> to remove its animation. Press <strong>Delete</strong> again to remove the object entirely.',
  },
  {
    title: 'Save & Export',
    body: 'Saving stores your draft in your browser locally, so it will not survive a hard refresh or incognito mode. Export any completed projects to make sure you do not lose any work, it will downlaod as a WebM file.',
  },
];


const helpModal   = document.getElementById('help-modal');
const helpStepNum = document.getElementById('help-step-num');
const helpTitle   = document.getElementById('help-title');
const helpBody    = document.getElementById('help-body');
const helpDots    = document.getElementById('help-dots');
const helpNext    = document.getElementById('help-next');
const helpBack    = document.getElementById('help-back');
let helpStep = 0;

// Build dot indicators
HELP_STEPS.forEach((_, i) => {
  const dot = document.createElement('div');
  dot.className = 'help-dot' + (i === 0 ? ' active' : '');
  dot.dataset.step = i;
  helpDots.appendChild(dot);
});

function showHelpStep(idx) {
  helpStep = idx;
  const step = HELP_STEPS[idx];
  helpStepNum.textContent = idx + 1;
  helpTitle.textContent = step.title;
  helpBody.innerHTML = step.body;

  // Update dots
  helpDots.querySelectorAll('.help-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });

  // Back disabled on first step
  helpBack.disabled = idx === 0;

  // Last step: change NEXT to DONE
  helpNext.textContent = idx === HELP_STEPS.length - 1 ? 'DONE ✓' : 'NEXT →';
}

function openHelp() {
  showHelpStep(0);
  helpModal.classList.add('visible');
}

function closeHelp() {
  helpModal.classList.remove('visible');
}

document.getElementById('info-btn').addEventListener('click', openHelp);
document.getElementById('help-close').addEventListener('click', closeHelp);

helpBack.addEventListener('click', () => {
  if (helpStep > 0) showHelpStep(helpStep - 1);
});

helpNext.addEventListener('click', () => {
  if (helpStep < HELP_STEPS.length - 1) {
    showHelpStep(helpStep + 1);
  } else {
    closeHelp();
  }
});

// Release Shift mid-draw → revert ghost to unconstrained
document.addEventListener('keyup', e => {
  if (e.key === 'Shift') redrawGhostIfDrawing(false);
});

// Close on backdrop click
helpModal.addEventListener('mousedown', e => {
  if (e.target === helpModal) closeHelp();
});

// Escape also closes
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && helpModal.classList.contains('visible')) {
    closeHelp();
  }
  if (e.key === 'Escape' && canvasModal.classList.contains('visible')) {
    closeCanvasModal();
  }
});

// ─── CANVAS SETTINGS MODAL ────────────────────────────────────────────────────
const canvasModal       = document.getElementById('canvas-modal');
const canvasBgInput     = document.getElementById('canvas-bg-input');
const canvasBgPreview   = document.getElementById('canvas-bg-preview');
const canvasBgHex       = document.getElementById('canvas-bg-hex');

// Pending (unsaved) values while modal is open
let pendingRatio   = canvasRatio;
let pendingBgColor = canvasBgColor;

function openCanvasModal() {
  // Sync UI to current saved values
  pendingRatio   = canvasRatio;
  pendingBgColor = canvasBgColor;

  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ratio === pendingRatio);
  });

  canvasBgInput.value = pendingBgColor;
  applyBgPreview(pendingBgColor);

  canvasModal.classList.add('visible');
}

function closeCanvasModal() {
  canvasModal.classList.remove('visible');
}

function applyBgPreview(color) {
  // The ::after pseudo-element carries the actual color over the checkerboard
  canvasBgPreview.style.setProperty('--bg-color', color);
  // Simpler: just set background directly (checkerboard only shows for transparency)
  canvasBgPreview.style.background = color;
  canvasBgHex.textContent = color;
}

// Ratio buttons
document.querySelectorAll('.ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    pendingRatio = btn.dataset.ratio;
    document.querySelectorAll('.ratio-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
  });
});

// Background colour picker
canvasBgInput.addEventListener('input', e => {
  pendingBgColor = e.target.value;
  applyBgPreview(pendingBgColor);
});

// Remap a shape's normalised coords so it keeps the same pixel size after a canvas resize.
// Animation paths use the same normalised space, so they need the same treatment.
// Scale a single normalised coordinate from the canvas centre.
function remapCoord(v, scale) { return 0.5 + (v - 0.5) * scale; }

function remapCoordsAfterResize(oldW, oldH, newW, newH) {
  const sx = oldW / newW, sy = oldH / newH;
  layers.forEach(layer => {
    const s = layer.shape;
    if (s) {
      if (s.type === 'rect' || s.type === 'line') {
        s.x1 = remapCoord(s.x1, sx); s.x2 = remapCoord(s.x2, sx);
        s.y1 = remapCoord(s.y1, sy); s.y2 = remapCoord(s.y2, sy);
      } else if (s.type === 'circle') {
        s.cx = remapCoord(s.cx, sx); s.cy = remapCoord(s.cy, sy);
        if (s.rx != null) { s.rx *= sx; s.ry *= sy; }
        else s.r *= Math.min(oldW, oldH) / Math.min(newW, newH);
      } else if (s.type === 'image') {
        s.cx = remapCoord(s.cx, sx); s.cy = remapCoord(s.cy, sy);
        s.w *= sx; s.h *= sy;
      } else if (s.type === 'text') {
        s.cx = remapCoord(s.cx, sx); s.cy = remapCoord(s.cy, sy);
      }
    }
    if (layer.animation) {
      layer.animation.forEach(pt => {
        pt.x = remapCoord(pt.x, sx);
        pt.y = remapCoord(pt.y, sy);
      });
    }
  });
}

// Save — apply both ratio and background
document.getElementById('canvas-modal-save').addEventListener('click', () => {
  const oldW = canvas.width, oldH = canvas.height;
  canvasRatio   = pendingRatio;
  canvasBgColor = pendingBgColor;
  resizeCanvas();   // recalculate canvas dimensions for new ratio
  if (canvas.width !== oldW || canvas.height !== oldH) {
    remapCoordsAfterResize(oldW, oldH, canvas.width, canvas.height);
    drawFrame(playheadPct);
  }
  closeCanvasModal();
  markUnsaved();
});

document.getElementById('canvas-modal-cancel').addEventListener('click', closeCanvasModal);
document.getElementById('canvas-settings-btn').addEventListener('click', openCanvasModal);
document.getElementById('canvas-modal-close').addEventListener('click', closeCanvasModal);

// Close on backdrop click
canvasModal.addEventListener('mousedown', e => {
  if (e.target === canvasModal) closeCanvasModal();
});

// Initialise preview swatch
applyBgPreview(canvasBgColor);

// ─── RESET ────────────────────────────────────────────────────────────────────
const resetModal = document.getElementById('reset-modal');

document.getElementById('reset-btn').addEventListener('click', () => {
  resetModal.classList.add('visible');
});

document.getElementById('reset-modal-cancel').addEventListener('click', () => {
  resetModal.classList.remove('visible');
});

resetModal.addEventListener('mousedown', e => {
  if (e.target === resetModal) resetModal.classList.remove('visible');
});

document.getElementById('reset-modal-confirm').addEventListener('click', () => {
  resetModal.classList.remove('visible');
  localStorage.removeItem(STORAGE_KEY);

  // Reset all state to defaults
  layers = [{ shape: null, animation: null }];
  activeLayer = 0;
  canvasRatio = '16:9';
  canvasBgColor = '#ffffff';
  recordDuration = 5;
  document.getElementById('duration-select').value = 5;
  hasUnsaved = false;
  saveBtn.classList.remove('unsaved', 'saved-flash');
  saveBtn.textContent = 'SAVE';

  // Rebuild layer tabs
  const row = document.getElementById('layer-row');
  const addBtn = document.getElementById('add-layer-btn');
  document.querySelectorAll('.layer-tab').forEach(t => t.remove());
  const tab = document.createElement('button');
  tab.className = 'layer-tab';
  tab.dataset.layer = 0;
  tab.textContent = layerLabel(0);
  attachTabListeners(tab);
  row.insertBefore(tab, addBtn);

  applyBgPreview(canvasBgColor);
  resizeCanvas();
  updateLayerTabs();
  checkExportReady();
  syncToolbarToLayer();
  setAppMode('draw');
  setStatus('Canvas reset.');
});

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  globalThis.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        console.log("SW registered:", registration.scope);
      })
      .catch((error) => {
        console.error("SW registration failed:", error);
      });

    // When a new SW takes over (after a deploy), reload once so the
    // page gets fresh HTML/JS/CSS instead of the stale cached version.
    let firstController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (firstController) {
        window.location.reload();
      }
      firstController = true;
    });
  });
}

registerServiceWorker();

// ─── LOCAL STORAGE PERSISTENCE ────────────────────────────────────────────────
const STORAGE_KEY = 'track-project-v1';
const saveBtn = document.getElementById('save-btn');
let hasUnsaved = false;

// Mark the project as having unsaved changes — called after every mutation
function markUnsaved() {
  hasUnsaved = true;
  saveBtn.classList.add('unsaved');
  saveBtn.textContent = 'SAVE';
}

// Persist the full project to localStorage — only called explicitly
function saveState() {
  try {
    const serialized = layers.map(layer => {
      const s = layer.shape;
      let shapeSer = null;
      if (s) {
        if (s.type === 'image') {
          // Store the data URL string — the Image element itself isn't serialisable
          shapeSer = { type: 'image', src: s.img.src, cx: s.cx, cy: s.cy, w: s.w, h: s.h, scale: s.scale };
        } else {
          shapeSer = { ...s };
        }
      }
      return { shape: shapeSer, animation: layer.animation };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      layers: serialized,
      activeLayer,
      canvasRatio,
      canvasBgColor,
      recordDuration,
    }));
    // Update button to show saved state
    hasUnsaved = false;
    saveBtn.classList.remove('unsaved');
    saveBtn.classList.add('saved-flash');
    saveBtn.textContent = '✓ SAVED';
    setTimeout(() => {
      saveBtn.classList.remove('saved-flash');
      saveBtn.textContent = 'SAVE';
    }, 1500);
  } catch (err) {
    console.warn('Could not save to localStorage:', err);
  }
}

saveBtn.addEventListener('click', saveState);

// Cmd+S / Ctrl+S
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveState();
  }
});

// ─── COPY / PASTE LAYER ───────────────────────────────────────────────────────
let copiedShape = null;

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!(e.metaKey || e.ctrlKey)) return;

  // ⌘C — copy active layer's shape (draw mode only, no animation)
  if (e.key === 'c' && appMode === 'draw') {
    const shape = layers[activeLayer].shape;
    if (!shape) return;
    // Shallow clone — image shapes share the img element reference (fine for drawing)
    copiedShape = { ...shape };
    setStatus(`${layerLabel(activeLayer)} copied. Press ⌘V to paste into a new layer.`);
  }

  // ⌘V — paste into a new layer if the current one is occupied
  if (e.key === 'v' && appMode === 'draw') {
    if (!copiedShape) return;
    e.preventDefault();
    ensureLayerForNewShape();
    layers[activeLayer].shape = { ...copiedShape };
    updateLayerTabs();
    drawFrame(playheadPct);
    checkExportReady();
    markUnsaved();
    setStatus(`Pasted onto ${layerLabel(activeLayer)}.`);
  }
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.layers) || state.layers.length === 0) return;

    // Restore settings
    if (state.canvasRatio && RATIOS[state.canvasRatio]) canvasRatio = state.canvasRatio;
    if (state.canvasBgColor) canvasBgColor = state.canvasBgColor;
    if (typeof state.recordDuration === 'number') {
      recordDuration = state.recordDuration;
      const sel = document.getElementById('duration-select');
      if (sel) sel.value = recordDuration;
    }
    activeLayer = (typeof state.activeLayer === 'number' && state.activeLayer < state.layers.length)
      ? state.activeLayer : 0;

    // Rebuild layer tabs DOM to match the saved layer count
    const row    = document.getElementById('layer-row');
    const addBtn = document.getElementById('add-layer-btn');
    document.querySelectorAll('.layer-tab').forEach(t => t.remove());

    layers = state.layers.map(() => ({ shape: null, animation: null }));

    state.layers.forEach((_, i) => {
      const tab = document.createElement('button');
      tab.className = 'layer-tab';
      tab.dataset.layer = i;
      tab.textContent = layerLabel(i);
      attachTabListeners(tab);
      row.insertBefore(tab, addBtn);
    });

    // Restore shapes — image shapes need an async Image load
    let pending = 0;
    function onAllReady() {
      if (--pending > 0) return;
      finish();
    }
    function finish() {
      updateLayerTabs();
      applyBgPreview(canvasBgColor);
      resizeCanvas();
      checkExportReady();
    }

    state.layers.forEach((layerData, i) => {
      layers[i].animation = layerData.animation || null;
      const s = layerData.shape;
      if (!s) return;
      if (s.type === 'image') {
        pending++;
        const img = new Image();
        img.onload  = () => { layers[i].shape = { type: 'image', img, cx: s.cx, cy: s.cy, w: s.w, h: s.h, scale: s.scale }; onAllReady(); };
        img.onerror = () => onAllReady();   // skip images that can't be restored
        img.src = s.src;
      } else {
        const shape = { ...s };
        // Migrate old saves: circle used a single `r`, now uses rx/ry
        if (shape.type === 'circle' && shape.r != null && shape.rx == null) {
          shape.rx = shape.r;
          shape.ry = shape.r;
          delete shape.r;
        }
        layers[i].shape = shape;
      }
    });

    if (pending === 0) finish();

  } catch (err) {
    console.warn('Could not restore from localStorage:', err);
  }
}

loadState();

// Ensure no tool button is highlighted on load
document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(b => b.classList.remove('active'));

// Always open the help modal on load
openHelp();
