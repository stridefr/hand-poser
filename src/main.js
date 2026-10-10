import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Hand, POSABLE, FINGERS, NICE, PARENT, PALM_BONES, BONE_NAMES, limitsFor, fingerOf, DEG, mirrorPos, mirrorQuat } from './rig.js';
import { solveFinger, autoGrip, CURL_PROFILE } from './ik.js';
import { loadModelFiles, SAMPLES, ACCEPT, MODEL_EXTS } from './loaders.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);
const other = s => (s === 'R' ? 'L' : 'R');
const SIDE_NAME = { R: 'right', L: 'left' };
const Side = s => (s === 'R' ? 'Right' : 'Left');
const FINGER_COL = { thumb: 0xf59e0b, index: 0x38bdf8, middle: 0xc084fc, palm: 0xa3a3a3 };
const FINGER_LT = { thumb: 'T', index: 'I', middle: 'M', palm: 'P' };
const hexCol = n => '#' + n.toString(16).padStart(6, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 2) => +(+v).toFixed(d);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, c = 's') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const ltHtml = f => `<span class="lt" style="background:${hexCol(FINGER_COL[f])}">${FINGER_LT[f]}</span>`;

// ═════════════════════════ scene ═════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('view').prepend(renderer.domElement);
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', '3D view of the hands');
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
scene.add(new THREE.HemisphereLight(0xdfe6f5, 0x2a2420, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(0.5, 1, 0.7); scene.add(sun);
const fill = new THREE.DirectionalLight(0xa9c4ff, 0.6); fill.position.set(-0.6, 0.3, -0.8); scene.add(fill);
const camera = new THREE.PerspectiveCamera(40, 1, 0.004, 50);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true; orbit.dampingFactor = 0.12; orbit.minDistance = 0.03; orbit.maxDistance = 5;
const grid = new THREE.GridHelper(1, 40, 0x2a3242, 0x1a2030); grid.position.y = -0.36; scene.add(grid);

// ───────── mouse navigation ─────────
// Blender style (default): middle-drag orbits, Shift+middle pans, Ctrl+middle zooms, wheel zooms; left click selects.
// Alt+left-drag stands in for the middle button (laptops / trackpads). Classic: left orbits, right pans, middle zooms.
const NAV_HINT = {
  blender: '<b>Middle-drag</b> orbit · <b>Shift</b> pan · <b>Ctrl</b> or <b>wheel</b> zoom · <b>Alt+left</b> = middle · <b>Click</b> select',
  classic: '<b>Drag</b> orbit · <b>Right-drag</b> pan · <b>Wheel</b> zoom · <b>Click</b> select',
};
const navMode = () => (prefs.mouse === 'classic' ? 'classic' : 'blender');
function applyMouseMode() {
  orbit.mouseButtons = navMode() === 'blender'
    ? { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  orbit.zoomToCursor = prefs.zoomCursor !== false;
  status();
}
// decide what a Blender-style drag does from its modifier keys, before OrbitControls sees the press
renderer.domElement.addEventListener('pointerdown', e => {
  if (navMode() !== 'blender' || e.pointerType !== 'mouse') return;
  const action = e.ctrlKey || e.metaKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
  orbit.mouseButtons.MIDDLE = action;
  orbit.mouseButtons.LEFT = e.button === 0 && e.altKey ? action : null;
}, { capture: true });
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
renderer.domElement.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

// ═════════════════════════ hands ═════════════════════════
const furImg = new Image();
const furTex = new THREE.Texture(furImg);
furImg.onload = () => furTex.needsUpdate = true;
furImg.src = window.FUR_PNG;
furTex.colorSpace = THREE.SRGBColorSpace; furTex.magFilter = THREE.NearestFilter;
const hands = { R: new Hand('R', furTex), L: new Hand('L', furTex) };
// The right hand's palm faces -X with the fingers up and the thumb towards +Z, i.e. you are looking along -Z at
// your own hands with the palms facing each other. The left hand sits at the mirror position.
const HAND_X = 0.13;
hands.R.root.position.x = HAND_X; hands.L.root.position.x = -HAND_X;
Object.values(hands).forEach(h => scene.add(h.root));
const CENTER = new THREE.Vector3(0, 0.03, 0);

// joint handles + fingertip IK rings (drawn on top of everything)
const markerGeo = new THREE.SphereGeometry(0.0042, 14, 10);
const ikGeo = new THREE.SphereGeometry(0.0068, 18, 12);
const onTop = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
Object.values(hands).forEach(h => {
  h.markers = {};
  POSABLE.forEach(b => {
    const m = new THREE.Mesh(markerGeo, onTop(FINGER_COL[fingerOf(b) || 'palm']));
    m.renderOrder = 10; m.userData = { pick: 'bone', side: h.side, b };
    h.bones[b].add(m); h.markers[b] = m;
  });
  h.ik = {};
  Object.keys(FINGERS).forEach(f => {
    const m = new THREE.Mesh(ikGeo, onTop(FINGER_COL[f]));
    m.material.opacity = 0.55; m.renderOrder = 11; m.userData = { pick: 'ik', side: h.side, finger: f };
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0085, 0.0011, 6, 24), onTop(FINGER_COL[f]));
    ring.renderOrder = 11; m.add(ring); m.userData.ring = ring;
    h.root.add(m); h.ik[f] = m;
  });
  h.ikLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.6 }));
  h.ikLine.renderOrder = 12; h.ikLine.visible = false; h.root.add(h.ikLine);
});

// ═════════════════════════ the held object ═════════════════════════
// hand.root → holder (the pose: position + rotation in hand-bone space) → norm (units/scale/pivot) → model
Object.values(hands).forEach(h => {
  h.holder = new THREE.Group(); h.norm = new THREE.Group();
  h.holder.add(h.norm); h.root.add(h.holder);
});
const item = { template: null, name: '', sample: 'bottle', units: 'fit', fit: 15, scale: 1, pivot: 'center', mirrorGeo: false, show: true, box: null };
const UNIT = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };
const DEFAULT_HOLD = { p: [-0.0558, 0.0717, 0.0332], q: [0.6624, 0, 0, 0.7492] };   // the original poser's bottle pose

function setTemplate(obj, name) {
  item.template = obj; item.name = name;
  obj.updateMatrixWorld(true);
  item.box = new THREE.Box3().setFromObject(obj, true);
  if (item.box.isEmpty()) item.box.set(new THREE.Vector3(-0.01, -0.01, -0.01), new THREE.Vector3(0.01, 0.01, 0.01));
  rebuildItem();
}
function itemScale() {
  const size = item.box.getSize(new THREE.Vector3());
  const u = item.units === 'fit' ? (item.fit / 100) / Math.max(size.x, size.y, size.z, 1e-6) : UNIT[item.units];
  return u * item.scale;
}
function rebuildItem() {
  if (!item.template) return;
  const s = itemScale(), c = item.box.getCenter(new THREE.Vector3());
  const off = item.pivot === 'origin' ? new THREE.Vector3() : item.pivot === 'bottom' ? new THREE.Vector3(-c.x, -item.box.min.y, -c.z) : c.clone().negate();
  Object.values(hands).forEach(h => {
    h.norm.clear();
    const m = SkeletonUtils.clone(item.template);
    m.position.add(off);                                   // the box was measured in this same (parent) space
    h.norm.add(m);
    h.norm.scale.set(s * (h.side === 'L' && item.mirrorGeo ? -1 : 1), s, s);
    h.holder.visible = item.show;
  });
  const size = item.box.getSize(new THREE.Vector3()).multiplyScalar(s * 100);
  $('dims').textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} cm`;
}
const objectMeshes = side => { const out = []; hands[side].holder.traverse(o => { if (o.isMesh && o.visible) out.push(o); }); return out; };

// Object pose in "canonical" form: the right-hand-equivalent transform, so mirrored poses show the same numbers.
function canonHold(side) {
  const h = hands[side].holder;
  return side === 'R' ? { p: h.position.clone(), q: h.quaternion.clone() } : { p: mirrorPos(h.position), q: mirrorQuat(h.quaternion) };
}
function setCanonHold(side, p, q) {
  const h = hands[side].holder;
  if (side === 'R') { h.position.copy(p); h.quaternion.copy(q).normalize(); }
  else { h.position.copy(mirrorPos(p)); h.quaternion.copy(mirrorQuat(q)).normalize(); }
}

// ═════════════════════════ state ═════════════════════════
let active = 'R';
let tool = 'move';
let sel = null;            // { kind: 'bone', b } | { kind: 'ik', finger } | { kind: 'object' } | { kind: 'hand' }
let live = false, limits = true, snap = false;
let models = {};           // id -> { id, name, kind: 'sample'|'import', sample, sig, size, created, used, thumb, work, poses, tex, missing }
let currentId = null;
const lib = () => models[currentId]?.poses || [];
const prefs = { showJoints: true, showIK: true, xray: false, grid: true, fur: '#a8243a', furTex: true, show: { R: true, L: true } };
const H = () => hands[active];

// ═════════════════════════ mirror / change / undo ═════════════════════════
function mirrorTo(dst) {
  const src = other(dst);
  hands[dst].setPose(hands[src].getPose());                  // same numbers = exact mirror (see rig.js)
  const c = canonHold(src); setCanonHold(dst, c.p, c.q);
}
function changed({ commitNow = false } = {}) {
  if (live) mirrorTo(other(active));
  Object.values(hands).forEach(h => h.root.updateMatrixWorld(true));
  refreshUI();
  scheduleSave();
  if (commitNow) commit();
}
const undoStack = [], redoStack = [];
const holdOf = s => ({ p: hands[s].holder.position.toArray().map(v => round(v, 6)), q: hands[s].holder.quaternion.toArray().map(v => round(v, 6)) });
function setHold(s, o) { if (!o) return; hands[s].holder.position.fromArray(o.p); hands[s].holder.quaternion.fromArray(o.q).normalize(); }
function snapshot() { return JSON.stringify({ R: hands.R.getPose(), L: hands.L.getPose(), hR: holdOf('R'), hL: holdOf('L') }); }
function commit() {
  const s = snapshot();
  if (undoStack[undoStack.length - 1] === s) return;
  undoStack.push(s); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; updateUndoButtons();
}
function restore(s) {
  const o = JSON.parse(s);
  hands.R.setPose(o.R); hands.L.setPose(o.L); setHold('R', o.hR); setHold('L', o.hL);
  Object.values(hands).forEach(h => h.root.updateMatrixWorld(true));
  refreshUI(); scheduleSave();
}
function undo() { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); restore(undoStack[undoStack.length - 1]); updateUndoButtons(); }
function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); restore(s); updateUndoButtons(); }
function updateUndoButtons() { $('undo').disabled = undoStack.length < 2; $('redo').disabled = !redoStack.length; }

// ═════════════════════════ persistence ═════════════════════════
let saveTimer = 0, resetting = false;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
function workState() {
  return { R: hands.R.getPose(), L: hands.L.getPose(), hR: holdOf('R'), hL: holdOf('L'),
    item: { units: item.units, fit: item.fit, scale: item.scale, pivot: item.pivot, mirrorGeo: item.mirrorGeo } };
}
function saveNow() {
  if (resetting) return;
  if (models[currentId]) models[currentId].work = workState();
  store.saveState({ version: 2, models, currentId, showObject: item.show, active, live, limits, snap, tool, prefs });
}

// ═════════════════════════ gizmo, tools, selection ═════════════════════════
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.7);
scene.add(gizmo.getHelper());
let dragging = false;
const dragTarget = new THREE.Vector3();
gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value; dragging = e.value;
  if (!e.value) { H().ikLine.visible = false; commit(); }
});
gizmo.addEventListener('objectChange', () => {
  if (!sel) return;
  const h = H();
  if (sel.kind === 'bone') {
    h.readBone(sel.b);
    if (limits) { clampBone(h, sel.b); h.applyBone(sel.b); }
  } else if (sel.kind === 'ik') {
    const t = h.ik[sel.finger];
    t.getWorldPosition(dragTarget);
    solveFinger(h, sel.finger, dragTarget, { limits, looseDir: camera.getWorldDirection(new THREE.Vector3()) });
    h.ikLine.geometry.setFromPoints([h.tipHand(sel.finger), t.position.clone()]); h.ikLine.visible = true;
  }
  changed();
});
function clampBone(h, b) { const L = limitsFor(b); h.pose[b] = h.pose[b].map((v, k) => clamp(v, L[k][0], L[k][1])); }

function select(s, { tab = true } = {}) {
  sel = s;
  if (s?.kind === 'bone') expandTo(active, fingerOf(s.b) || 'palm');
  if (s?.kind === 'ik') expandTo(active, s.finger);
  if (tab && s) showTab(s.kind === 'object' ? 'object' : s.kind === 'hand' ? 'hand' : 'bone');
  attachGizmo();
  refreshUI();
}
let space = 'local';
function attachGizmo() {
  const h = H();
  gizmo.detach();
  if (!sel) return;
  if (sel.kind === 'bone') {
    if (tool === 'select') return;
    gizmo.setMode('rotate'); gizmo.setSpace('local'); gizmo.attach(h.bones[sel.b]);
  } else if (sel.kind === 'ik') {
    if (!prefs.showIK) return;
    gizmo.setMode('translate'); gizmo.setSpace('world'); gizmo.attach(h.ik[sel.finger]);
  } else if (sel.kind === 'object') {
    if (tool === 'select' || !item.show) return;
    gizmo.setMode(tool === 'rotate' ? 'rotate' : 'translate'); gizmo.setSpace(space); gizmo.attach(h.holder);
  }
}
function setTool(t) {
  tool = t;
  ['Select', 'Move', 'Rotate'].forEach(n => { const b = $('tool' + n), on = t === n.toLowerCase(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  attachGizmo(); scheduleSave(); status();
}
function setSpace(s) { space = s; $('spaceLbl').textContent = s === 'local' ? 'Local' : 'World'; $('space').classList.toggle('on', s === 'world'); if (sel?.kind === 'object') gizmo.setSpace(s); }
function setSnap(on) {
  snap = on; $('snap').classList.toggle('on', on); $('snap').setAttribute('aria-pressed', on);
  gizmo.setRotationSnap(on ? 5 * DEG : null); gizmo.setTranslationSnap(on ? 0.0025 : null);
}
function setActive(s) {
  if (s === active) return;
  active = s;
  if (sel?.kind === 'bone' || sel?.kind === 'ik' || sel?.kind === 'object') attachGizmo();
  if (!prefs.show[s]) { prefs.show[s] = true; applyDisplay(); }
  refreshUI(); scheduleSave();
}

// ───────── picking ─────────
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null, gizmoHot = false;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY, e.button]; gizmoHot = gizmo.axis !== null; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || gizmoHot || dragging) { downAt = null; return; }
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]), btn = downAt[2]; downAt = null;
  if (moved > 5) return;
  if (btn === 2) { const t = pickAt(e); if (t) { applyPick(t); openContextMenu(e.clientX, e.clientY); } return; }
  if (btn !== 0 || (e.altKey && navMode() === 'blender')) return;
  const t = pickAt(e);
  if (t) applyPick(t); else select(null);
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('dblclick', () => { if (sel) frameSelection(); });
renderer.domElement.addEventListener('pointermove', e => {
  if (dragging || e.buttons) return;
  const hit = pickHandles(e);
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  status(hit ? (hit.object.userData.pick === 'ik' ? `Drag to bend the <b>${FINGERS[hit.object.userData.finger].label.toLowerCase()}</b> from its tip` : `Click to select <b>${NICE[hit.object.userData.b]}</b>`) : null);
});
function setRay(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pickHandles(e) {
  setRay(e);
  const h = H(), list = [];
  if (prefs.showIK && h.root.visible) Object.values(h.ik).forEach(m => list.push(m));
  if (prefs.showJoints && h.root.visible) Object.values(h.markers).forEach(m => list.push(m));
  return ray.intersectObjects(list, false)[0] || null;
}
// what is under the pointer, as { side, sel } (nothing is changed yet)
function pickAt(e) {
  const hh = pickHandles(e);
  if (hh) { const u = hh.object.userData; return { side: active, sel: u.pick === 'ik' ? { kind: 'ik', finger: u.finger } : { kind: 'bone', b: u.b } }; }
  const list = [];
  for (const s of ['R', 'L']) {
    if (!hands[s].root.visible) continue;                     // a hidden hand (and what it holds) can't be clicked
    hands[s].mesh.computeBoundingSphere(); hands[s].mesh.computeBoundingBox();
    list.push(hands[s].mesh, ...objectMeshes(s));
  }
  const hit = ray.intersectObjects(list, false)[0];
  if (!hit) return null;
  let o = hit.object, side = active;
  for (let p = o; p; p = p.parent) { if (p === hands.R.root) side = 'R'; if (p === hands.L.root) side = 'L'; }
  if (o.isSkinnedMesh && o.userData.hand) {
    const g = o.geometry, w = {};
    [hit.face.a, hit.face.b, hit.face.c].forEach(v => {
      for (let k = 0; k < 4; k++) { const b = g.attributes.skinIndex.getComponent(v, k), x = g.attributes.skinWeight.getComponent(v, k); w[b] = (w[b] || 0) + x; }
    });
    let b = +Object.keys(w).sort((a, c) => w[c] - w[a])[0];
    if (!POSABLE.includes(b)) b = POSABLE.includes(PARENT[b]) ? PARENT[b] : null;
    return { side, sel: b == null ? { kind: 'hand' } : { kind: 'bone', b } };
  }
  return { side, sel: { kind: 'object' } };
}
function applyPick(t) { if (t.side !== active) setActive(t.side); select(t.sel); }

// ═════════════════════════ poses: presets & macros ═════════════════════════
function fingerCurl(h, f) { const p = CURL_PROFILE[f]; return FINGERS[f].bones.reduce((a, b, i) => a + h.pose[b][0] / p[i], 0) / 3; }
function setFingerCurl(h, f, u) {
  FINGERS[f].bones.forEach((b, i) => { h.pose[b][0] = u * CURL_PROFILE[f][i]; if (limits) clampBone(h, b); });
  h.applyAll();
}
const P = (thumb, index, middle, extra = {}) => {
  const o = {};
  POSABLE.forEach(b => o[b] = [0, 0, 0]);
  [['thumb', thumb], ['index', index], ['middle', middle]].forEach(([f, c]) => FINGERS[f].bones.forEach((b, i) => o[b][0] = c[i]));
  Object.entries(extra).forEach(([b, v]) => o[b] = v);
  return o;
};
const PRESETS = {
  Open: P([0, 0, 0], [0, 0, 0], [0, 0, 0]),
  Relaxed: P([8, 12, 15], [18, 25, 15], [22, 30, 20]),
  Fist: P([30, 45, 55], [92, 105, 80], [92, 105, 80]),
  Grip: P([22, 30, 30], [62, 70, 50], [62, 70, 50]),
  Trigger: P([22, 30, 30], [30, 40, 25], [62, 70, 50]),
  Point: P([30, 45, 55], [0, 5, 0], [92, 105, 80]),
  Pinch: P([28, 25, 30], [40, 48, 30], [70, 80, 60]),
  'Thumb up': P([-30, -10, 0], [92, 105, 80], [92, 105, 80], { 3: [-30, -20, 0] }),
  Spread: P([-15, 0, 0], [0, 0, 0], [0, 0, 0], { 3: [-15, -25, 0], 7: [0, 20, 0], 11: [0, -20, 0] }),
};
function applyPreset(name) {
  const h = H();
  h.setPose(PRESETS[name]);
  if (limits) { POSABLE.forEach(b => clampBone(h, b)); h.applyAll(); }
  changed({ commitNow: true });
  toast(`${name} pose on the ${SIDE_NAME[active]} hand`, false, { undo: true });
}
function gripFingers(list) {
  const h = H(), meshes = objectMeshes(active);
  if (!meshes.length || !item.show) return toast('There is no object to grip', true);
  h.root.updateMatrixWorld(true);
  let n = 0;
  list.forEach(f => { if (autoGrip(h, f, meshes, { limits })) n++; });
  changed({ commitNow: true });
  if (!n) toast('The fingers closed without touching the object. Move it into the palm first.', true);
  else toast(`Gripped with ${n} finger${n > 1 ? 's' : ''}`, false, { undo: true });
}
function mirrorActive() { mirrorTo(other(active)); changed({ commitNow: true }); toast(`Mirrored onto the ${SIDE_NAME[other(active)]} hand`, false, { undo: true }); }
function resetHand() { H().setPose(null); changed({ commitNow: true }); toast(`${Side(active)} hand reset`, false, { undo: true }); }
function resetBone() { if (sel?.kind !== 'bone') return; H().pose[sel.b] = [0, 0, 0]; H().applyBone(sel.b); changed({ commitNow: true }); toast(`${NICE[sel.b]} reset`, false, { undo: true }); }
function straightenFinger(f) { const h = H(); FINGERS[f].bones.forEach(b => h.pose[b] = [0, 0, 0]); h.applyAll(); changed({ commitNow: true }); toast(`${FINGERS[f].label} straightened`, false, { undo: true }); }
function swapHands() {
  const pR = hands.R.getPose(), pL = hands.L.getPose(), cR = canonHold('R'), cL = canonHold('L');
  hands.R.setPose(pL); hands.L.setPose(pR); setCanonHold('R', cL.p, cL.q); setCanonHold('L', cR.p, cR.q);
  changed({ commitNow: true }); toast('Hands swapped', false, { undo: true });
}
function copyBoneToOther(b) {
  hands[other(active)].pose[b] = H().pose[b].slice(); hands[other(active)].applyBone(b);
  changed({ commitNow: true }); toast(`${NICE[b]} copied to the ${SIDE_NAME[other(active)]} hand`, false, { undo: true });
}
let boneClip = null;
function copyBoneValues() { if (sel?.kind !== 'bone') return; boneClip = H().pose[sel.b].slice(); toast(`Copied ${NICE[sel.b]}: ${boneClip.map(v => round(v, 1) + '°').join(' · ')}`); }
function pasteBoneValues() {
  if (sel?.kind !== 'bone' || !boneClip) return;
  const h = H(); h.pose[sel.b] = boneClip.slice(); if (limits) clampBone(h, sel.b); h.applyBone(sel.b);
  changed({ commitNow: true }); toast(`Pasted onto ${NICE[sel.b]}`, false, { undo: true });
}

// ═════════════════════════ status, label, toast ═════════════════════════
function selLabel() {
  if (!sel) return null;
  if (sel.kind === 'bone') return NICE[sel.b];
  if (sel.kind === 'ik') return FINGERS[sel.finger].label + ' fingertip';
  if (sel.kind === 'hand') return Side(active) + ' hand';
  return item.name || 'Held object';
}
function status(t) {
  const el = $('status'); if (!el) return;
  el.innerHTML = t || defaultStatus();
  $('sbHand').textContent = Side(active) + ' hand';
  const vl = $('vlabel');
  vl.hidden = !sel;
  if (sel) {
    const col = sel.kind === 'object' ? 0xfafafa : sel.kind === 'hand' ? 0xb9a6fc : FINGER_COL[sel.kind === 'ik' ? sel.finger : (fingerOf(sel.b) || 'palm')];
    $('vlDot').style.background = hexCol(col);
    $('vlText').innerHTML = (sel.kind === 'hand' || sel.kind === 'object') ? `<b>${esc(selLabel())}</b>` : `<span class="side">${Side(active)} hand ›</span> <b>${esc(selLabel())}</b>`;
  }
}
function defaultStatus() {
  if (!sel) return NAV_HINT[navMode()];
  if (sel.kind === 'bone') return `<b>${NICE[sel.b]}</b> · ${tool === 'select' ? 'set the values on the right' : 'drag a ring to bend it, or type a value on the right'}`;
  if (sel.kind === 'ik') return `<b>${FINGERS[sel.finger].label} fingertip</b> · drag the arrows and the whole finger follows`;
  if (sel.kind === 'hand') return `<b>${Side(active)} hand</b> · pick a joint, or use Fingers and Presets on the right`;
  return `<b>${esc(item.name || 'Object')}</b> · ${tool === 'select' ? 'set the placement on the right' : tool === 'rotate' ? 'drag a ring to turn it' : 'drag an arrow to move it'}`;
}
let toastTimer = 0;
function toast(t, err = false, { undo: canUndo = false, ms } = {}) {
  const el = $('toast'), life = ms || (err ? 4500 : canUndo ? 5000 : 2400);
  $('toastText').textContent = t; el.classList.toggle('err', err); $('toastUndo').hidden = !canUndo;
  el.style.setProperty('--life', life + 'ms');
  el.classList.remove('show', 'timed'); void el.offsetWidth; el.classList.add('show', 'timed');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), life);
}
$('toastUndo').onclick = () => { undo(); $('toast').classList.remove('show'); };
$('toast').onmouseenter = () => clearTimeout(toastTimer);
$('toast').onmouseleave = () => { toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1500); };

// ═════════════════════════ sliders: fill + value bubble ═════════════════════════
function paintRange(r) {
  const min = +r.min || 0, max = r.max === '' ? 100 : +r.max, p = max > min ? clamp((+r.value - min) / (max - min), 0, 1) : 0;
  r.style.setProperty('--p', p * 100 + '%');
  const w = r.parentElement; if (w?.classList.contains('slw')) w.style.setProperty('--bx', `calc(${p * 100}% + ${(0.5 - p) * 14}px)`);
}
function paintRanges() { document.querySelectorAll('input[type=range]').forEach(paintRange); }
function fmtSlider(r) { const v = +r.value, st = +r.step || 1; return (st >= 1 ? v.toFixed(0) : st >= 0.1 ? v.toFixed(1) : v.toFixed(2)) + (r.parentElement.dataset.unit || ''); }
function enhanceSlider(w) {
  if (w.dataset.ok) return; w.dataset.ok = 1;
  const r = w.querySelector('input[type=range]'), out = document.createElement('output');
  out.setAttribute('aria-hidden', 'true'); w.appendChild(out);
  const show = () => { out.textContent = fmtSlider(r); paintRange(r); };
  r.addEventListener('input', show);
  r.addEventListener('pointerdown', () => { show(); w.classList.add('active'); });
  r.addEventListener('focus', () => { if (r.matches(':focus-visible')) { show(); w.classList.add('active'); } });
  r.addEventListener('blur', () => w.classList.remove('active'));
  r.addEventListener('keydown', () => { show(); w.classList.add('active'); });
}
addEventListener('pointerup', () => document.querySelectorAll('.slw.active').forEach(w => { if (!w.contains(document.activeElement) || !document.activeElement.matches(':focus-visible')) w.classList.remove('active'); }));
document.addEventListener('input', e => { if (e.target.type === 'range') paintRange(e.target); });
document.querySelectorAll('.slw').forEach(enhanceSlider);

// ═════════════════════════ properties: tabs ═════════════════════════
let curTab = 'bone';
function showTab(name) {
  curTab = name;
  const tabs = [...document.querySelectorAll('.ptab')];
  tabs.forEach((b, i) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
    if (on) $('ptabInd').style.transform = `translateY(${i * 55}px)`;
  });
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
  paintRanges();
}
document.querySelectorAll('.ptab').forEach((b, i, all) => {
  b.onclick = () => showTab(b.dataset.tab);
  b.onkeydown = e => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (d) { e.preventDefault(); const n = all[(i + d + all.length) % all.length]; n.focus(); showTab(n.dataset.tab); }
  };
});
document.querySelectorAll('.sec.fold > h4').forEach(h => h.onclick = () => h.parentElement.classList.toggle('closed'));

// ───────── bone pane ─────────
function refreshBoneUI() {
  const h = H(), b = sel?.kind === 'bone' ? sel.b : null, f = sel?.kind === 'ik' ? sel.finger : b != null ? fingerOf(b) : null;
  const has = b != null || f != null;
  $('boneEmpty').hidden = has; $('boneBody').hidden = !has;
  if (!has) return;
  $('rotSec').hidden = b == null;
  $('boneCrumb').textContent = `${Side(active)} hand › ${f ? FINGERS[f].label : 'Palm'}`;
  $('boneTitle').textContent = b != null ? NICE[b] : FINGERS[f].label + ' fingertip';
  $('boneReset').hidden = b == null;
  if (b != null) {
    const L = limitsFor(b);
    for (let k = 0; k < 3; k++) {
      const r = $('b' + k), n = $('b' + k + 'n'), lo = limits ? L[k][0] : -180, hi = limits ? L[k][1] : 180;
      r.min = lo; r.max = hi; r.value = h.pose[b][k];
      $('b' + k + 'lo').textContent = lo; $('b' + k + 'hi').textContent = hi;
      if (document.activeElement !== n) n.value = round(h.pose[b][k], 1);
    }
  }
  $('wfSec').hidden = !f; $('ikSec').hidden = !f;
  if (f) {
    const L = limitsFor(FINGERS[f].bones[0]);
    $('wfLt').innerHTML = ltHtml(f); $('wfName').textContent = ' ' + FINGERS[f].label;
    $('wfCurl').value = fingerCurl(h, f); if (document.activeElement !== $('wfCurlN')) $('wfCurlN').value = round(fingerCurl(h, f), 2);
    $('wfSpread').min = limits ? L[1][0] : -90; $('wfSpread').max = limits ? L[1][1] : 90; $('wfSpread').value = h.pose[FINGERS[f].bones[0]][1];
    if (document.activeElement !== $('wfSpreadN')) $('wfSpreadN').value = round(h.pose[FINGERS[f].bones[0]][1], 1);
    $('wfCurl').style.setProperty('--fill', hexCol(FINGER_COL[f])); $('wfSpread').style.setProperty('--fill', hexCol(FINGER_COL[f]));
    $('ikSelect').hidden = sel.kind === 'ik';
  }
}
for (let k = 0; k < 3; k++) {
  const set = (v, end) => {
    if (sel?.kind !== 'bone') return;
    const h = H(); h.pose[sel.b][k] = +v; if (limits) clampBone(h, sel.b);
    h.applyBone(sel.b); changed({ commitNow: end });
  };
  $('b' + k).oninput = e => set(e.target.value, false);
  $('b' + k).onchange = () => commit();
  $('b' + k + 'n').onchange = e => set(e.target.value, true);
}
document.querySelectorAll('[data-bn]').forEach(btn => btn.onclick = () => {
  if (sel?.kind !== 'bone') return;
  const k = +btn.dataset.bn[0], sgn = btn.dataset.bn[1] === '+' ? 1 : -1, h = H();
  h.pose[sel.b][k] += sgn * +$('boneStep').value; if (limits) clampBone(h, sel.b);
  h.applyBone(sel.b); changed({ commitNow: true });
});
$('boneReset').onclick = resetBone;
const selFinger = () => (sel?.kind === 'ik' ? sel.finger : sel?.kind === 'bone' ? fingerOf(sel.b) : null);
$('wfCurl').oninput = e => { const f = selFinger(); if (f) { setFingerCurl(H(), f, +e.target.value); changed(); } };
$('wfCurl').onchange = () => commit();
$('wfCurlN').onchange = e => { const f = selFinger(); if (f) { setFingerCurl(H(), f, +e.target.value || 0); changed({ commitNow: true }); } };
const setSpread = (v, end) => { const f = selFinger(); if (!f) return; const h = H(), b = FINGERS[f].bones[0]; h.pose[b][1] = +v; if (limits) clampBone(h, b); h.applyBone(b); changed({ commitNow: end }); };
$('wfSpread').oninput = e => setSpread(e.target.value, false);
$('wfSpread').onchange = () => commit();
$('wfSpreadN').onchange = e => setSpread(e.target.value, true);
$('wfGrip').onclick = () => { const f = selFinger(); if (f) gripFingers([f]); };
$('wfStraight').onclick = () => { const f = selFinger(); if (f) straightenFinger(f); };
$('ikSelect').onclick = () => { const f = selFinger(); if (f) select({ kind: 'ik', finger: f }); };

// ───────── hand pane ─────────
const fingerUI = {};
Object.entries(FINGERS).forEach(([f, F]) => {
  const col = hexCol(FINGER_COL[f]);
  const curl = document.createElement('div'), spread = document.createElement('div');
  curl.className = spread.className = 'row';
  curl.innerHTML = `<div class="slw" data-unit=""><input type="range" min="-0.3" max="1.15" step="0.01" aria-label="${F.label} curl" style="--fill:${col}"></div><input type="number" step="0.05" aria-label="${F.label} curl value">`;
  spread.innerHTML = `<div class="slw" data-unit="°"><input type="range" step="0.5" aria-label="${F.label} spread" style="--fill:${col}"></div><input type="number" step="1" aria-label="${F.label} spread degrees">`;
  const lt = document.createElement('span'); lt.innerHTML = ltHtml(f); lt.title = F.label;
  $('fingers').append(lt, curl, document.createElement('span'), spread);
  const [cr, cn] = curl.querySelectorAll('input'), [sr, sn] = spread.querySelectorAll('input');
  fingerUI[f] = { cr, cn, sr, sn };
  const setC = (v, end) => { setFingerCurl(H(), f, +v || 0); changed({ commitNow: end }); };
  const setS = (v, end) => { const h = H(), b = F.bones[0]; h.pose[b][1] = +v || 0; if (limits) clampBone(h, b); h.applyBone(b); changed({ commitNow: end }); };
  cr.oninput = e => setC(e.target.value, false); cr.onchange = () => commit(); cn.onchange = e => setC(e.target.value, true);
  sr.oninput = e => setS(e.target.value, false); sr.onchange = () => commit(); sn.onchange = e => setS(e.target.value, true);
  curl.querySelectorAll('.slw').forEach(enhanceSlider); spread.querySelectorAll('.slw').forEach(enhanceSlider);
});
function refreshHandUI() {
  const h = H();
  $('handTitle').textContent = Side(active) + ' hand';
  $('presetFor').textContent = `for the ${SIDE_NAME[active]} hand`;
  Object.keys(FINGERS).forEach(f => {
    const u = fingerUI[f], b = FINGERS[f].bones[0], L = limitsFor(b), c = fingerCurl(h, f);
    u.cr.value = c; if (document.activeElement !== u.cn) u.cn.value = round(c, 2);
    u.sr.min = limits ? L[1][0] : -90; u.sr.max = limits ? L[1][1] : 90; u.sr.value = h.pose[b][1];
    if (document.activeElement !== u.sn) u.sn.value = round(h.pose[b][1], 1);
  });
  const all = (fingerCurl(h, 'index') + fingerCurl(h, 'middle')) / 2;
  $('gripAll').value = all; if (document.activeElement !== $('gripAllN')) $('gripAllN').value = round(all, 2);
}
const setAll = (v, end) => { const h = H(); Object.keys(FINGERS).forEach(f => setFingerCurl(h, f, +v || 0)); changed({ commitNow: end }); };
$('gripAll').oninput = e => setAll(e.target.value, false); $('gripAll').onchange = () => commit(); $('gripAllN').onchange = e => setAll(e.target.value, true);
$('gripAuto').onclick = () => gripFingers(['middle', 'index', 'thumb']);
$('handReset').onclick = resetHand;
Object.keys(PRESETS).forEach(n => {
  const b = document.createElement('button'); b.className = 'tile'; b.innerHTML = icon('hand') + esc(n);
  b.onclick = () => applyPreset(n); $('presets').appendChild(b);
});
$('copyRL').onclick = () => { mirrorTo('L'); changed({ commitNow: true }); toast('Right hand mirrored onto the left', false, { undo: true }); };
$('copyLR').onclick = () => { mirrorTo('R'); changed({ commitNow: true }); toast('Left hand mirrored onto the right', false, { undo: true }); };
$('swap').onclick = swapHands;

// ───────── object pane ─────────
// canonical values in hand space: X+ out of the palm, Y+ towards the fingertips, Z+ towards the thumb
const toDisp = p => [-p.x * 100, p.y * 100, p.z * 100];
const fromDisp = a => new THREE.Vector3(-a[0] / 100, a[1] / 100, a[2] / 100);
function refreshObjUI() {
  const c = canonHold(active), d = toDisp(c.p);
  const e = new THREE.Euler().setFromQuaternion(c.q, 'YXZ'), r = [e.x, e.y, e.z].map(v => v / DEG);
  for (let k = 0; k < 3; k++) {
    $('p' + k).value = d[k]; if (document.activeElement !== $('p' + k + 'n')) $('p' + k + 'n').value = round(d[k], 2);
    $('r' + k).value = r[k]; if (document.activeElement !== $('r' + k + 'n')) $('r' + k + 'n').value = round(r[k], 1);
  }
  $('objHand').textContent = SIDE_NAME[active];
}
function setObjFromUI(end) {
  const d = [0, 1, 2].map(k => +$('p' + k).value), r = [0, 1, 2].map(k => +$('r' + k).value * DEG);
  setCanonHold(active, fromDisp(d), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'YXZ')));
  changed({ commitNow: end });
}
for (let k = 0; k < 3; k++) for (const t of ['p', 'r']) {
  $(t + k).oninput = () => setObjFromUI(false);
  $(t + k).onchange = () => commit();
  $(t + k + 'n').onchange = e => { $(t + k).value = e.target.value; setObjFromUI(true); };
}
document.querySelectorAll('[data-nudge]').forEach(btn => btn.onclick = () => {
  const [t, k, s] = [btn.dataset.nudge[0], +btn.dataset.nudge[1], btn.dataset.nudge[2] === '+' ? 1 : -1];
  const c = canonHold(active);
  if (t === 'p') { const d = toDisp(c.p); d[k] += s * +$('moveStep').value; c.p = fromDisp(d); }
  else c.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0), s * +$('rotStep').value * DEG));
  setCanonHold(active, c.p, c.q); changed({ commitNow: true });
});
function resetPlacement() { setCanonHold(active, new THREE.Vector3(...DEFAULT_HOLD.p), new THREE.Quaternion(...DEFAULT_HOLD.q)); changed({ commitNow: true }); toast('Placement reset', false, { undo: true }); }
$('objReset').onclick = resetPlacement;
$('objSelect').onclick = () => { if (tool === 'select') setTool('move'); select({ kind: 'object' }); };
function setObjShow(on) { item.show = on; $('objShow').checked = on; Object.values(hands).forEach(h => h.holder.visible = on); if (sel?.kind === 'object') attachGizmo(); refreshTree(); scheduleSave(); }
$('objShow').onchange = e => setObjShow(e.target.checked);
$('mirrorGeo').onchange = e => { item.mirrorGeo = e.target.checked; rebuildItem(); scheduleSave(); };
function refreshItemUI() {
  $('units').value = item.units; $('fitRow').hidden = item.units !== 'fit';
  $('fitSize').value = item.fit; $('fitSizeN').value = item.fit;
  $('scale').value = item.scale; $('scaleN').value = item.scale;
  $('pivot').value = item.pivot; $('mirrorGeo').checked = item.mirrorGeo; $('objShow').checked = item.show;
  paintRanges();
}
$('units').onchange = e => { item.units = e.target.value; refreshItemUI(); rebuildItem(); scheduleSave(); };
$('fitSize').oninput = e => { item.fit = +e.target.value; $('fitSizeN').value = item.fit; rebuildItem(); scheduleSave(); };
$('fitSizeN').onchange = e => { item.fit = clamp(+e.target.value || 15, 0.5, 500); refreshItemUI(); rebuildItem(); scheduleSave(); };
$('scale').oninput = e => { item.scale = +e.target.value; $('scaleN').value = item.scale; rebuildItem(); scheduleSave(); };
$('scaleN').onchange = e => { item.scale = clamp(+e.target.value || 1, 0.001, 1000); refreshItemUI(); rebuildItem(); scheduleSave(); };
$('pivot').onchange = e => { item.pivot = e.target.value; rebuildItem(); scheduleSave(); };

// ═════════════════════════ outliner ═════════════════════════
const expanded = new Set(['hand:R', 'f:R:index']);
let treeKey = '';
function expandTo(side, f) { expanded.add('hand:' + side); if (f) expanded.add(`f:${side}:${f}`); }
const selId = () => !sel ? null : sel.kind === 'object' ? 'obj' : sel.kind === 'hand' ? 'hand:' + active : sel.kind === 'ik' ? `f:${active}:${sel.finger}` : `b:${active}:${sel.b}`;
const FINGER_ORDER = ['thumb', 'index', 'middle', 'palm'];
const groupBones = f => (f === 'palm' ? PALM_BONES : FINGERS[f].bones);
const groupLabel = f => (f === 'palm' ? 'Palm' : FINGERS[f].label);
function treeNodes() {
  // flat description, with parent ids, before filtering
  const N = [{ id: 'obj', depth: 0, label: item.name || 'Object', kind: 'obj' }];
  for (const s of ['R', 'L']) {
    N.push({ id: 'hand:' + s, depth: 0, label: Side(s) + ' hand', kind: 'hand', side: s, kids: true });
    for (const f of FINGER_ORDER) {
      N.push({ id: `f:${s}:${f}`, parent: 'hand:' + s, depth: 1, label: groupLabel(f), kind: 'finger', side: s, f, kids: true });
      groupBones(f).forEach(b => N.push({ id: `b:${s}:${b}`, parent: `f:${s}:${f}`, depth: 2, label: NICE[b], kind: 'bone', side: s, b }));
    }
  }
  return N;
}
function nodeValue(n) {
  if (n.kind === 'bone') return round(hands[n.side].pose[n.b][0], 0) + '°';
  if (n.kind === 'finger' && n.f !== 'palm') return fingerCurl(hands[n.side], n.f).toFixed(2);
  return '';
}
function buildTree() {
  const q = $('olFilter').value.trim().toLowerCase();
  const all = treeNodes(), byId = Object.fromEntries(all.map(n => [n.id, n]));
  let show = null;
  if (q) {                                          // matching rows plus everything above them, opened
    show = new Set();
    all.forEach(n => { if (n.label.toLowerCase().includes(q)) for (let p = n; p; p = byId[p.parent]) show.add(p.id); });
  }
  const isOpen = id => (q ? true : expanded.has(id));
  const root = $('tree'); root.innerHTML = '';
  const containers = { '': root };
  all.forEach(n => {
    if (show && !show.has(n.id)) return;
    const host = n.parent ? containers[n.parent] : root; if (!host) return;
    const el = document.createElement('div');
    el.className = 'node'; el.dataset.id = n.id; el.setAttribute('role', 'treeitem'); el.tabIndex = -1;
    el.style.paddingLeft = 6 + n.depth * 18 + 'px';
    if (n.kids) el.setAttribute('aria-expanded', isOpen(n.id));
    const hid = n.kind === 'hand' ? !prefs.show[n.side] : n.kind === 'obj' ? !item.show : false;
    if (hid) el.classList.add('hid');
    let h = n.kids ? `<button class="tw${isOpen(n.id) ? ' open' : ''}" tabindex="-1" aria-label="${isOpen(n.id) ? 'Collapse' : 'Expand'}">${icon('chevr', 'xs')}</button>` : '<span class="tws"></span>';
    if (n.kind === 'obj') h += icon('box') + `<span class="nm" style="color:#86efac">${esc(n.label)}</span><span class="bdg">held</span>`;
    else if (n.kind === 'hand') h += icon('hand') + `<span class="nm" style="font-weight:600">${n.label}</span>` + (live && n.side !== active ? '<span class="bdg">mirrored</span>' : '');
    else if (n.kind === 'finger') h += ltHtml(n.f) + `<span class="nm">${n.label}</span><span class="val"></span>`;
    else h += icon('bone', 'xs') + `<span class="nm">${n.label}</span><span class="val"></span>`;
    if (n.kind === 'hand' || n.kind === 'obj') h += `<button class="eye" tabindex="-1" aria-label="${hid ? 'Show' : 'Hide'} ${esc(n.label)}" title="${hid ? 'Show' : 'Hide'}">${icon(hid ? 'eyeoff' : 'eye', 'xs')}</button>`;
    el.innerHTML = h;
    host.appendChild(el);
    if (n.kids) {
      const k = document.createElement('div'); k.className = 'kids' + (isOpen(n.id) ? '' : ' closed'); k.setAttribute('role', 'group');
      const inner = document.createElement('div'); k.appendChild(inner); host.appendChild(k); containers[n.id] = inner;
      k.addEventListener('transitionend', placeTreeHl);
    }
  });
  if (!root.children.length) root.innerHTML = '<p class="empty-s">No joints match.</p>';
}
function refreshTree() {
  const key = [...expanded].sort().join() + '|' + $('olFilter').value + '|' + item.name + '|' + prefs.show.R + prefs.show.L + item.show + live + active;
  if (key !== treeKey) { treeKey = key; buildTree(); }
  const nodes = Object.fromEntries(treeNodes().map(n => [n.id, n])), sid = selId();
  let focusable = null;
  $('tree').querySelectorAll('.node').forEach(el => {
    const n = nodes[el.dataset.id], v = el.querySelector('.val');
    if (v) v.textContent = nodeValue(n);
    const on = el.dataset.id === sid;
    el.classList.toggle('sel', on); el.setAttribute('aria-selected', on);
    if (on) focusable = el;
  });
  const cur = $('tree').querySelector('.node[tabindex="0"]');
  if (!cur || (focusable && cur !== focusable && !$('tree').contains(document.activeElement))) {
    $('tree').querySelectorAll('.node').forEach(el => el.tabIndex = -1);
    (focusable || $('tree').querySelector('.node')) && ((focusable || $('tree').querySelector('.node')).tabIndex = 0);
  }
  placeTreeHl();
}
function placeTreeHl() {
  const hl = $('treeHl'), row = $('tree').querySelector('.node.sel'), wrap = $('treeWrap');
  const hiddenRow = !row || row.closest('.kids.closed');
  if (hiddenRow) { hl.style.opacity = 0; return; }
  const top = row.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
  hl.style.opacity = 1; hl.style.transform = `translateY(${top}px)`;
}
function activateNode(id) {
  const [t, s, x] = id.split(':');
  if (id === 'obj') return select({ kind: 'object' });
  if (s && s !== active) setActive(s);
  if (t === 'hand') return select({ kind: 'hand' });
  if (t === 'f') return x === 'palm' ? select({ kind: 'bone', b: PALM_BONES[0] }) : select({ kind: 'ik', finger: x });
  if (t === 'b') return select({ kind: 'bone', b: +x });
}
function toggleNode(id, open) {
  if (open ?? !expanded.has(id)) expanded.add(id); else expanded.delete(id);
  const el = $('tree').querySelector(`.node[data-id="${id}"]`);
  // animate in place, then rebuild quietly
  if (el && !$('olFilter').value) {
    const k = el.nextElementSibling, on = expanded.has(id);
    el.setAttribute('aria-expanded', on); el.querySelector('.tw')?.classList.toggle('open', on); k?.classList.toggle('closed', !on);
    treeKey = [...expanded].sort().join() + '|' + $('olFilter').value + '|' + item.name + '|' + prefs.show.R + prefs.show.L + item.show + live + active;
    setTimeout(placeTreeHl, 300);
  } else refreshTree();
}
$('tree').addEventListener('click', e => {
  const el = e.target.closest('.node'); if (!el) return;
  const id = el.dataset.id;
  if (e.target.closest('.tw')) return toggleNode(id);
  if (e.target.closest('.eye')) { if (id === 'obj') setObjShow(!item.show); else { const s = id.split(':')[1]; prefs.show[s] = !prefs.show[s]; applyDisplay(); refreshTree(); scheduleSave(); } return; }
  activateNode(id); el.focus({ preventScroll: true });
});
$('tree').addEventListener('dblclick', e => { const el = e.target.closest('.node'); if (el && !e.target.closest('.tw, .eye')) frameSelection(); });
$('tree').addEventListener('contextmenu', e => {
  const el = e.target.closest('.node'); if (!el) return;
  e.preventDefault(); activateNode(el.dataset.id); openContextMenu(e.clientX, e.clientY);
});
$('tree').addEventListener('keydown', e => {
  const rows = [...$('tree').querySelectorAll('.node')].filter(r => !r.closest('.kids.closed'));
  const el = document.activeElement.closest?.('.node'); if (!el) return;
  const i = rows.indexOf(el), id = el.dataset.id, focus = r => { if (!r) return; rows.forEach(x => x.tabIndex = -1); r.tabIndex = 0; r.focus(); };
  if (e.key === 'ArrowDown') { e.preventDefault(); focus(rows[i + 1]); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focus(rows[i - 1]); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); if (el.hasAttribute('aria-expanded') && el.getAttribute('aria-expanded') === 'false') toggleNode(id, true); else focus(rows[i + 1]); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); if (el.getAttribute('aria-expanded') === 'true') toggleNode(id, false); else focus(el.parentElement.closest('.kids')?.previousElementSibling); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateNode(id); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); activateNode(id); const r = el.getBoundingClientRect(); openContextMenu(r.left + 40, r.bottom); }
});
$('olFilter').oninput = () => refreshTree();
$('olCollapse').onclick = () => { expanded.clear(); expanded.add('hand:' + active); refreshTree(); };
$('treeWrap').addEventListener('scroll', placeTreeHl);
// outliner ↔ saved poses divider
$('split').onpointerdown = e => {
  const start = e.clientY, h0 = $('posesBox').getBoundingClientRect().height, max = $('outliner').getBoundingClientRect().height * 0.7;
  const mv = ev => { const h = clamp(h0 - (ev.clientY - start), 70, max); $('posesBox').style.setProperty('--poses-h', h + 'px'); prefs.posesH = h; placeTreeHl(); };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); scheduleSave(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
};
// narrow windows: the outliner is a rail that opens as an overlay
const openOutliner = (on = true) => { $('outliner').classList.toggle('open', on); $('olClose').hidden = !on; if (on) setTimeout(() => { refreshTree(); $('tree').querySelector('.node[tabindex="0"]')?.focus(); }, 0); };
$('olOpen').onclick = () => openOutliner(true); $('olPoses').onclick = () => openOutliner(true); $('olClose').onclick = () => openOutliner(false);

// ═════════════════════════ menus & right-click menus ═════════════════════════
let menuEl = null, menuOwner = null;
function closeMenu() { menuEl?.remove(); menuEl = null; document.querySelectorAll('[data-menu].open').forEach(b => b.classList.remove('open')); const o = menuOwner; menuOwner = null; return o; }
function openMenu(items, x, y, owner = null) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
  items.filter(Boolean).forEach(it => {
    if (it === '-') return m.appendChild(document.createElement('hr'));
    if (it.header) { const h = document.createElement('div'); h.className = 'mh'; h.textContent = it.header; return m.appendChild(h); }
    const b = document.createElement('button'); b.className = 'mi'; b.setAttribute('role', it.check !== undefined ? 'menuitemcheckbox' : 'menuitem');
    if (it.check !== undefined) b.setAttribute('aria-checked', !!it.check);
    b.innerHTML = (it.check !== undefined ? `<span class="ck">${it.check ? icon('check', 'xs') : ''}</span>` : icon(it.icon || 'chevr')) + `<span>${esc(it.label)}</span>` + (it.sc ? `<span class="sc">${esc(it.sc)}</span>` : '');
    b.disabled = !!it.disabled;
    b.onclick = () => { closeMenu(); it.run?.(); };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = clamp(x, 6, innerWidth - r.width - 6) + 'px'; m.style.top = clamp(y, 6, innerHeight - r.height - 6) + 'px';
  menuEl = m; menuOwner = owner; if (owner) owner.classList.add('open');
  m.addEventListener('keydown', e => {
    const its = [...m.querySelectorAll('.mi:not(:disabled)')], i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); its[(i + 1) % its.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); its[(i - 1 + its.length) % its.length]?.focus(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && menuOwner?.closest('.menus')) {
      e.preventDefault(); const bs = [...document.querySelectorAll('.menus > button')], j = bs.indexOf(menuOwner);
      openBarMenu(bs[(j + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length], true);
    } else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu()?.focus(); }
    else return;
    e.stopPropagation();
  });
  return m;
}
addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); }, true);
addEventListener('blur', closeMenu);
const presetItems = () => Object.keys(PRESETS).map(n => ({ label: n, icon: 'hand', run: () => applyPreset(n) }));
const MENUS = {
  file: () => [
    { label: 'Import model…', icon: 'upload', sc: 'Ctrl O', run: () => openImport() },
    { label: 'Model library', icon: 'layers', sc: 'H', run: showModels },
    '-',
    { label: 'Save pose', icon: 'save', sc: 'Ctrl S', run: quickSavePose },
    { label: 'Export pose JSON…', icon: 'download', sc: 'Ctrl E', run: exportJson },
    { label: 'Load pose JSON…', icon: 'upload', run: () => $('jsonFile').click() },
    { label: 'Copy Unity text', icon: 'copy', run: copyUnity },
    { label: 'Save screenshot', icon: 'camera', run: screenshot },
    '-',
    { label: 'Settings', icon: 'gear', sc: 'Ctrl ,', run: () => openSettings() },
    window.desktop && '-', window.desktop && { label: 'Quit', icon: 'x', sc: 'Ctrl Q', run: () => window.close() },
  ],
  edit: () => [
    { label: 'Undo', icon: 'undo', sc: 'Ctrl Z', run: undo, disabled: undoStack.length < 2 },
    { label: 'Redo', icon: 'redo', sc: 'Ctrl Y', run: redo, disabled: !redoStack.length },
    '-',
    { label: 'Copy joint values', icon: 'copy', sc: 'Ctrl C', run: copyBoneValues, disabled: sel?.kind !== 'bone' },
    { label: 'Paste joint values', icon: 'paste', sc: 'Ctrl V', run: pasteBoneValues, disabled: sel?.kind !== 'bone' || !boneClip },
    '-',
    { label: 'Deselect', icon: 'x', sc: 'Esc', run: () => select(null), disabled: !sel },
    { label: 'Search actions…', icon: 'search', sc: 'Ctrl K', run: openPalette },
  ],
  pose: () => [
    { label: `Mirror onto the ${SIDE_NAME[other(active)]} hand`, icon: 'flip', sc: 'M', run: mirrorActive },
    { label: 'Copy right → left', icon: 'flip', run: () => $('copyRL').click() },
    { label: 'Copy left → right', icon: 'flip', run: () => $('copyLR').click() },
    { label: 'Swap hands', icon: 'swap', run: swapHands },
    { label: 'Live mirror', check: live, run: () => $('live').click() },
    '-',
    { label: 'Auto-grip the object', icon: 'spark', run: () => gripFingers(['middle', 'index', 'thumb']) },
    { label: `Reset the ${SIDE_NAME[active]} hand`, icon: 'refresh', run: resetHand },
    { label: 'Joint limits', check: limits, run: () => $('limits').click() },
    '-', { header: 'Presets' }, ...presetItems(),
  ],
  view: () => [
    ...CAM_VIEWS.map(([v, n, sc]) => ({ label: n, icon: 'camera', sc, run: () => view(v) })),
    { label: 'Frame the selection', icon: 'focus', sc: 'F', run: frameSelection },
    '-', ...overlayItems(),
  ],
  help: () => [
    { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => openSettings('controls') },
    { label: 'Check for updates', icon: 'refresh', run: () => openSettings('updates') },
    { label: 'Release notes', icon: 'link', run: () => openLink('https://github.com/stridefr/hand-poser/releases') },
    '-', { label: 'About Hand Poser', icon: 'info', run: () => openSettings('about') },
  ],
  camera: () => CAM_VIEWS.map(([v, n, sc]) => ({ label: n, icon: 'camera', sc, run: () => view(v) })),
  overlays: () => overlayItems(),
};
const CAM_VIEWS = [['pov', 'First person', 'Num 0'], ['front', 'Front', 'Num 1'], ['back', 'Back', 'Ctrl Num 1'], ['thumb', 'Thumb side', 'Num 3'], ['top', 'Top', 'Num 7'], ['palm', 'Palm of the active hand', '']];
function overlayItems() {
  const T = (label, key, apply) => ({ label, check: !!prefs[key], run: () => { prefs[key] = !prefs[key]; apply?.(); applyDisplay(); scheduleSave(); } });
  return [
    T('Joint dots', 'showJoints'), T('Fingertip rings', 'showIK', () => { if (!prefs.showIK && sel?.kind === 'ik') select(null); }), T('See-through hands', 'xray'), T('Floor grid', 'grid'),
    { label: 'Held object', check: item.show, run: () => setObjShow(!item.show) },
    { label: 'Right hand', check: prefs.show.R, run: () => { prefs.show.R = !prefs.show.R; applyDisplay(); refreshTree(); scheduleSave(); } },
    { label: 'Left hand', check: prefs.show.L, run: () => { prefs.show.L = !prefs.show.L; applyDisplay(); refreshTree(); scheduleSave(); } },
  ];
}
function openBarMenu(btn, focusFirst = false) {
  const r = btn.getBoundingClientRect(), m = openMenu(MENUS[btn.dataset.menu](), r.left, r.bottom + 4, btn);
  if (focusFirst) m.querySelector('.mi:not(:disabled)')?.focus();
}
document.querySelectorAll('[data-menu]').forEach(btn => {
  btn.onclick = () => (menuOwner === btn ? closeMenu() : openBarMenu(btn, false));
  btn.onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBarMenu(btn, true); } };
  btn.onmouseenter = () => { if (menuOwner && menuOwner !== btn && menuOwner.closest('.menus') && btn.closest('.menus')) openBarMenu(btn); };
});
function contextItems() {
  if (!sel) return [];
  if (sel.kind === 'bone') return [{ header: NICE[sel.b] },
    { label: 'Reset joint', icon: 'refresh', run: resetBone },
    { label: `Copy to the ${SIDE_NAME[other(active)]} hand`, icon: 'flip', run: () => copyBoneToOther(sel.b) },
    fingerOf(sel.b) && { label: 'Select the fingertip', icon: 'move', run: () => select({ kind: 'ik', finger: fingerOf(sel.b) }) },
    { label: 'Frame in view', icon: 'focus', sc: 'F', run: frameSelection },
    '-',
    { label: 'Copy values', icon: 'copy', sc: 'Ctrl C', run: copyBoneValues },
    { label: 'Paste values', icon: 'paste', sc: 'Ctrl V', run: pasteBoneValues, disabled: !boneClip }];
  if (sel.kind === 'ik') return [{ header: FINGERS[sel.finger].label },
    { label: 'Grip the object', icon: 'spark', run: () => gripFingers([sel.finger]) },
    { label: 'Straighten', icon: 'refresh', run: () => straightenFinger(sel.finger) },
    { label: 'Frame in view', icon: 'focus', sc: 'F', run: frameSelection }];
  if (sel.kind === 'hand') return [{ header: Side(active) + ' hand' },
    { label: `Mirror onto the ${SIDE_NAME[other(active)]} hand`, icon: 'flip', sc: 'M', run: mirrorActive },
    { label: 'Auto-grip the object', icon: 'spark', run: () => gripFingers(['middle', 'index', 'thumb']) },
    { label: 'Reset hand', icon: 'refresh', run: resetHand },
    { label: prefs.show[active] ? 'Hide' : 'Show', icon: prefs.show[active] ? 'eyeoff' : 'eye', run: () => { prefs.show[active] = !prefs.show[active]; applyDisplay(); refreshTree(); scheduleSave(); } },
    { label: 'Frame in view', icon: 'focus', sc: 'F', run: frameSelection }];
  return [{ header: item.name || 'Object' },
    { label: 'Put the gizmo on it', icon: 'move', run: () => { if (tool === 'select') setTool('move'); attachGizmo(); } },
    { label: 'Reset placement', icon: 'refresh', run: resetPlacement },
    { label: 'Materials & textures', icon: 'image', run: () => showTab('material') },
    { label: item.show ? 'Hide' : 'Show', icon: item.show ? 'eyeoff' : 'eye', run: () => setObjShow(!item.show) },
    { label: 'Frame in view', icon: 'focus', sc: 'F', run: frameSelection }];
}
function openContextMenu(x, y) { const its = contextItems(); if (its.length) openMenu(its, x, y).querySelector('.mi:not(:disabled)')?.focus({ preventScroll: true }); }

// ═════════════════════════ model library ═════════════════════════
const SAMPLE_ID = k => 'sample:' + k;
function ensureSamples() {
  Object.entries(SAMPLES).forEach(([k, smp]) => {
    const id = SAMPLE_ID(k);
    if (!models[id]) models[id] = { id, name: smp.label, kind: 'sample', sample: k, created: 0, used: 0, thumb: null, work: null, poses: [] };
  });
}
const defaultItem = kind => ({ units: kind === 'sample' ? 'm' : 'fit', fit: 15, scale: 1, pivot: 'center', mirrorGeo: false });
function startingPose(m) {                        // a model opened for the first time: relaxed hand closed onto it, mirrored
  setHold('R', DEFAULT_HOLD);
  hands.R.setPose(PRESETS.Relaxed); hands.R.root.updateMatrixWorld(true);
  const meshes = objectMeshes('R');
  if (meshes.length && prefs.autoGripNew !== false && m?.initGrip !== false) ['middle', 'index', 'thumb'].forEach(f => autoGrip(hands.R, f, meshes, { limits }));
  mirrorTo('L');
}
function applyLibPose(p) { hands.R.setPose(p.R); hands.L.setPose(p.L); setHold('R', p.hR); setHold('L', p.hL); }
function stashCurrent() { const m = models[currentId]; if (!m) return; m.work = workState(); m.thumb = captureThumb() || m.thumb; }
const furReady = () => furImg.complete && furImg.naturalWidth > 0 && furTex.version > 0;   // decoded and handed to three.js
function captureThumb(w = 320, h = 200) {
  if (!furReady()) return null;                 // the hand would come out black
  try {
    const hidden = [];
    scene.traverse(o => { if ((o.userData.pick || o === gizmo.getHelper() || o === grid || o.isLine) && o.visible) { hidden.push(o); o.visible = false; } });
    renderer.render(scene, camera);
    const src = renderer.domElement, W = src.width, Hh = src.height, ar = w / h;
    const sw = Math.min(W * 0.8, Hh * ar), sh = sw / ar;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), bg = g.createRadialGradient(w / 2, h * .2, 10, w / 2, h / 2, w * .7);
    bg.addColorStop(0, '#1d1a2c'); bg.addColorStop(1, '#0b0b0e'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.drawImage(src, (W - sw) / 2, (Hh - sh) / 2, sw, sh, 0, 0, w, h);
    hidden.forEach(o => o.visible = true);
    return c.toDataURL('image/jpeg', 0.72);
  } catch (e) { return null; }
}
let opening = 0;
// Open a model exactly as it was left (optionally straight into one of its saved poses).
// `loaded` is a model that was just parsed by an import, so it isn't parsed twice.
async function openModel(id, { pose = null, quiet = false, loaded = null } = {}) {
  const m = models[id]; if (!m) return false;
  const ticket = ++opening;
  let obj, missing = [];
  if (m.kind === 'sample') obj = SAMPLES[m.sample].make();
  else if (loaded) { obj = loaded.object; missing = loaded.missing; }
  else {
    $('vloadText').textContent = `Opening ${m.name}…`; $('vload').hidden = false;
    const files = await store.getFiles(id);
    if (!files) { $('vload').hidden = true; toast(`The files for "${m.name}" aren't stored on this computer any more. Import it again.`, true); return false; }
    try { const res = await loadModelFiles(files); obj = res.object; missing = res.missing; }
    catch (err) { console.error(err); $('vload').hidden = true; toast('Could not open ' + m.name + ': ' + (err.message || err), true); return false; }
    finally { if (ticket === opening) $('vload').hidden = true; }
  }
  if (ticket !== opening) return false;                       // another model was picked meanwhile
  if (currentId && currentId !== id && models[currentId]) stashCurrent();
  currentId = id; m.used = Date.now();
  Object.assign(item, defaultItem(m.kind), m.initItem || {}, m.work?.item || {});
  item.sample = m.kind === 'sample' ? m.sample : null;
  setTemplate(obj, m.name);
  if (m.work) { hands.R.setPose(m.work.R); hands.L.setPose(m.work.L); setHold('R', m.work.hR); setHold('L', m.work.hL); }
  else startingPose(m);
  if (pose) applyLibPose(pose);
  Object.values(hands).forEach(h => h.root.updateMatrixWorld(true));
  sel = null; attachGizmo();
  undoStack.length = 0; redoStack.length = 0;                 // undo history is per model
  refreshItemUI(); refreshLib(); refreshUI(); commit(); saveNow();
  if (!quiet) toast('Opened ' + m.name + (pose ? ' · ' + pose.name : ''));
  const firstThumb = (tries = 0) => setTimeout(() => {
    if (currentId !== id || (m.thumb && !m.thumbIsObject)) return;
    const t = captureThumb();
    if (t) { m.thumb = t; delete m.thumbIsObject; refreshModelChrome(); saveNow(); if (!$('library').hidden) renderLibrary(); } else if (tries < 10) firstThumb(tries + 1);
  }, 400);
  if (!m.thumb || m.thumbIsObject) firstThumb();
  m.missing = m.missing || [];
  renderMaterials();
  applyTexOverrides(m).then(() => { if (currentId === id) renderMaterials(); });
  setTimeout(() => {                                          // textures fail to load asynchronously
    if (currentId !== id) return;
    const before = m.missing.length;
    m.missing = [...new Set(missing)]; renderMaterials(); saveNow();
    const imgs = m.missing.filter(n => IMAGE_EXT.test(n));
    if (imgs.length && (!quiet || m.missing.length !== before)) toast(`${imgs.length} texture${imgs.length > 1 ? 's' : ''} missing. Add ${imgs.length > 1 ? 'them' : 'it'} in the Material tab`, true);
  }, 2000);
  setTimeout(() => { if (currentId === id) renderMaterials(); }, 3500);   // thumbnails once images have decoded
  if (!$('library').hidden) renderLibrary();
  return true;
}
async function deleteModel(id) {
  const m = models[id]; if (!m || m.kind !== 'import') return;
  if (!confirm(`Delete "${m.name}" and its ${m.poses.length} saved pose${m.poses.length === 1 ? '' : 's'}? This can't be undone.`)) return;
  delete models[id]; store.deleteFiles(id); store.deleteImages(id);
  if (libSel === id) libSel = null;
  if (id === currentId) {
    currentId = null;
    const next = Object.values(models).filter(x => x.kind === 'import').sort((a, b) => b.used - a.used)[0];
    if (!next || !(await openModel(next.id, { quiet: true }))) await openModel(SAMPLE_ID('bottle'), { quiet: true });
  }
  saveNow(); renderLibrary(); toast('Deleted ' + m.name);
}
function renameModel(id) {
  const m = models[id], n = prompt('Rename model', m.name);
  if (!n || !n.trim()) return;
  m.name = n.trim();
  if (id === currentId) { item.name = m.name; refreshLib(); refreshTree(); }
  saveNow(); renderLibrary();
}
const ago = t => { const x = (Date.now() - t) / 1000; return x < 60 ? 'just now' : x < 3600 ? Math.round(x / 60) + ' min ago' : x < 86400 ? Math.round(x / 3600) + ' h ago' : Math.round(x / 86400) + ' d ago'; };
const fmtBytes = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
let libFilter = 'all', libSort = 'used', libSel = null;
function libModels() {
  const q = $('libSearch').value.trim().toLowerCase();
  return Object.values(models)
    .filter(m => (libFilter === 'all' || m.kind === libFilter) && (!q || m.name.toLowerCase().includes(q)))
    .sort((a, b) => libSort === 'name' ? a.name.localeCompare(b.name) : (b.used - a.used) || (a.kind === 'sample' ? 1 : -1) - (b.kind === 'sample' ? 1 : -1));
}
let thumbQueue = [];
function renderLibrary() {
  const all = Object.values(models);
  $('lcAll').textContent = all.length; $('lcImp').textContent = all.filter(m => m.kind === 'import').length; $('lcSam').textContent = all.filter(m => m.kind === 'sample').length;
  $('libTitle').innerHTML = { all: 'All models', import: 'Imported', sample: 'Built-in' }[libFilter];
  document.querySelectorAll('[data-lf]').forEach(b => b.classList.toggle('on', b.dataset.lf === libFilter));
  document.querySelectorAll('[data-ls]').forEach(b => b.classList.toggle('on', b.dataset.ls === libSort));
  const list = libModels(), grid = $('libGrid'); grid.innerHTML = '';
  if (!list.length) grid.innerHTML = `<p class="hint" style="grid-column:1/-1;padding:20px 0">${libFilter === 'import' && !$('libSearch').value ? 'No imported models yet. Import an FBX, OBJ, glTF… and it is kept here with its own poses.' : 'No models match.'}</p>`;
  thumbQueue = [];
  list.forEach(m => {
    const c = document.createElement('button'); c.className = 'mcard' + (m.id === libSel ? ' sel' : ''); c.dataset.id = m.id;
    c.setAttribute('role', 'option'); c.setAttribute('aria-selected', m.id === libSel);
    const needs = !m.thumb && m.sample !== 'none';
    c.innerHTML = `<span class="th${needs ? ' shim' : ''}"><span class="img" style="${m.thumb ? `background-image:url('${m.thumb}')` : ''}"></span>${m.id === currentId ? '<span class="tg">OPEN</span>' : ''}</span>
      <span class="bd"><b>${esc(m.name)}</b><small>${m.kind === 'sample' ? 'Built-in' : (m.format || 'Imported').toUpperCase() + ' · ' + fmtBytes(m.size || 0)}${m.poses.length ? ` · ${m.poses.length} pose${m.poses.length > 1 ? 's' : ''}` : ''}</small></span>`;
    c.onclick = () => { libSel = m.id; grid.querySelectorAll('.mcard').forEach(x => { x.classList.toggle('sel', x === c); x.setAttribute('aria-selected', x === c); }); renderDetail(); };
    c.ondblclick = () => pickModel(m.id);
    c.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); pickModel(m.id); } else if (e.key === 'Delete') deleteModel(m.id); else if (e.key === 'F2') renameModel(m.id); };
    grid.appendChild(c);
    if (needs) thumbQueue.push([m, c]);
  });
  // built-in previews render one by one so the page shows straight away (skeletons until then)
  const next = () => { const job = thumbQueue.shift(); if (!job) return; const [m, c] = job;
    if (!m.thumb && m.kind === 'sample') { m.thumb = objectThumb(SAMPLES[m.sample].make()); m.thumbIsObject = true; }
    const th = c.querySelector('.th'); th.classList.remove('shim'); if (m.thumb) th.querySelector('.img').style.backgroundImage = `url('${m.thumb}')`;
    renderHeroCards(); if (m.id === libSel) renderDetail(); setTimeout(next, 30); };
  setTimeout(next, 60);
  renderHeroCards(); renderDetail();
}
function renderHeroCards() {
  const withThumbs = Object.values(models).filter(m => m.thumb).sort((a, b) => b.used - a.used).slice(0, 3);
  document.querySelectorAll('#heroCards .fc').forEach((c, i) => { c.style.backgroundImage = withThumbs[i] ? `url('${withThumbs[i].thumb}')` : ''; });
}
function renderDetail() {
  const d = $('libDetail'), m = models[libSel];
  if (!m) { d.innerHTML = `<div class="empty" style="margin-top:40px">${icon('layers', 'xl')}<b>Pick a model</b><span>Its details and saved poses show here. Double-click to open it.</span></div>`; return; }
  const kv = [['Type', m.kind === 'sample' ? 'Built-in object' : (m.format || '').toUpperCase() + ' model'], m.kind === 'import' && ['Size', fmtBytes(m.size || 0)], ['Saved poses', m.poses.length], ['Last used', m.used ? ago(m.used) : 'never'],
    m.missing?.length ? ['Textures', `${m.missing.length} missing`] : null].filter(Boolean);
  d.innerHTML = `<div class="prev" style="${m.thumb ? `background-image:url('${m.thumb}')` : ''}"></div>
    <div class="nm"><b>${esc(m.name)}</b><span>${m.id === currentId ? 'Open in the editor now' : m.kind === 'sample' ? 'Built-in object' : 'Imported ' + (m.created ? ago(m.created) : '')}</span></div>
    <div class="kv">${kv.map(([k, v]) => `<span>${k}</span><b>${esc(v)}</b>`).join('')}</div>
    <div class="poses"><div class="ph">Saved poses<span class="g"></span><span class="cnt">${m.poses.length}</span></div><div id="detPoses">${m.poses.length ? '' : '<p class="empty-s">No poses saved yet.</p>'}</div></div>
    <div class="acts"><button class="btn pri lg" style="flex:1" id="detOpen">${m.id === currentId ? 'Back to it' : 'Open'}</button>${m.kind === 'import' ? `<button class="btn lg" id="detRename">Rename</button><button class="btn danger lg icon" id="detDelete" aria-label="Delete ${esc(m.name)}" title="Delete">${icon('trash')}</button>` : ''}</div>`;
  m.poses.forEach(p => {
    const r = document.createElement('div'); r.className = 'pose'; r.tabIndex = 0; r.title = `Open ${m.name} in this pose`;
    r.innerHTML = `<span class="pt" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"></span><span class="tx"><b>${esc(p.name)}</b><small>Both hands · object</small></span>`;
    r.onclick = () => pickModel(m.id, p); r.onkeydown = e => { if (e.key === 'Enter') pickModel(m.id, p); };
    $('detPoses').appendChild(r);
  });
  $('detOpen').onclick = () => pickModel(m.id);
  if ($('detRename')) $('detRename').onclick = () => renameModel(m.id);
  if ($('detDelete')) $('detDelete').onclick = () => deleteModel(m.id);
}
async function pickModel(id, pose = null) {
  closeModels();
  if (id === currentId) { if (pose) { applyLibPose(pose); changed({ commitNow: true }); toast('Loaded ' + pose.name, false, { undo: true }); } return; }
  await openModel(id, { pose });
}
function showModels() {
  closeMenu(); closePalette();
  if (models[currentId]) { models[currentId].thumb = captureThumb() || models[currentId].thumb; saveNow(); }
  libSel = libSel && models[libSel] ? libSel : currentId;
  renderLibrary(); $('library').hidden = false;
  setTimeout(() => $('libGrid').querySelector('.mcard.sel, .mcard')?.focus({ preventScroll: true }), 0);
}
function closeModels() { $('library').hidden = true; }
$('modelsBtn').onclick = () => ($('library').hidden ? showModels() : closeModels());
$('homeBtn').onclick = () => ($('library').hidden ? showModels() : closeModels());
$('openModels').onclick = showModels;
$('mClose').onclick = closeModels; $('libBack').onclick = closeModels;
document.querySelectorAll('[data-lf]').forEach(b => b.onclick = () => { libFilter = b.dataset.lf; renderLibrary(); });
document.querySelectorAll('[data-ls]').forEach(b => b.onclick = () => { libSort = b.dataset.ls; renderLibrary(); });
$('libSearch').oninput = () => renderLibrary();

// ═════════════════════════ materials & textures ═════════════════════════
// Textures the user adds are stored per model (images in IndexedDB, assignments in models[id].tex) and re-applied
// every time the model opens. Files the model itself asked for but didn't get (missing textures) are instead added
// to the model's own files and the model is re-read, so the original loader puts them where they belong.
const SLOTS = [['map', 'Base colour'], ['normalMap', 'Normal'], ['roughnessMap', 'Roughness'], ['metalnessMap', 'Metalness'], ['emissiveMap', 'Emissive']];
const SLOT_HINT = { map: 'Surface colour', normalMap: 'Bumps and detail', roughnessMap: 'Shiny or matte', metalnessMap: 'Metal or not', emissiveMap: 'Glowing parts' };
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|avif)$/i;
let openMatKey = null, slotTarget = null;
function itemMaterials() {
  const out = [], seen = new Map();
  item.template?.traverse(o => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => {
      if (!mt) return;
      const uv = !!o.geometry?.attributes?.uv;
      if (seen.has(mt)) { if (uv) seen.get(mt).hasUV = true; return; }
      const e = { mat: mt, key: out.length + ':' + (mt.name || ''), name: mt.name || 'Material ' + (out.length + 1), hasUV: uv };
      seen.set(mt, e); out.push(e);
    });
  });
  return out;
}
const modelFormat = m => m.format || (m.sig?.match(/\.(glb|gltf|fbx|obj|dae|stl|ply|3mf|3ds):/i)?.[1] || '').toLowerCase();
function makeTexture(img, slot, mat, m) {
  const t = new THREE.Texture(img), ref = mat.map || mat.normalMap || mat.emissiveMap || mat.roughnessMap || mat.metalnessMap;
  t.flipY = ref ? ref.flipY : !['gltf', 'glb'].includes(modelFormat(m));   // glTF textures are stored the other way up
  t.colorSpace = slot === 'map' || slot === 'emissiveMap' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
function setSlot(mat, slot, tex, o) {
  mat[slot] = tex;
  if (tex) {                                     // maps multiply these values, so open them up
    if (slot === 'map' && !o?.color) mat.color?.set(0xffffff);
    if (slot === 'emissiveMap' && mat.emissive && mat.emissive.getHex() === 0) mat.emissive.set(0xffffff);
    if (slot === 'roughnessMap') mat.roughness = 1;
    if (slot === 'metalnessMap') mat.metalness = 1;
  }
  mat.needsUpdate = true;
}
const imgCache = new Map();
function loadStoredImage(modelId, imgId) {
  const k = modelId + ':' + imgId;
  if (!imgCache.has(k)) imgCache.set(k, (async () => {
    const rec = await store.getImage(modelId, imgId); if (!rec) return null;
    const img = new Image(); img.src = URL.createObjectURL(new Blob([rec.data], { type: rec.type || '' }));
    await img.decode(); return img;
  })().catch(() => null));
  return imgCache.get(k);
}
async function applyTexOverrides(m) {
  if (!m.tex) return;
  const id = m.id;
  for (const e of itemMaterials()) {
    const o = m.tex[e.key]; if (!o) continue;
    if (o.color && e.mat.color) e.mat.color.set(o.color);
    for (const [slot] of SLOTS) {
      if (!(slot in o) || !(slot in e.mat)) continue;
      if (o[slot] === null) { setSlot(e.mat, slot, null, o); continue; }
      const img = await loadStoredImage(id, o[slot]);
      if (currentId !== id) return;                       // switched model meanwhile
      if (img) setSlot(e.mat, slot, makeTexture(img, slot, e.mat, m), o);
    }
  }
}
async function addImageTo(keys, slot, file) {
  const m = models[currentId]; if (!m) return;
  if (/\.tga$/i.test(file.name)) return toast('TGA images can only be linked as missing textures. Save it as PNG to place it by hand.', true);
  const imgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { name: file.name, type: file.type, data: await file.arrayBuffer() };
  const ok = await store.putImage(m.id, imgId, rec);
  const img = await loadStoredImage(m.id, imgId).catch(() => null);
  if (!img) return toast(`Couldn't read ${file.name} as an image`, true);
  m.tex = m.tex || {};
  const mats = itemMaterials();
  keys.forEach(k => {
    const e = mats.find(x => x.key === k); if (!e || !(slot in e.mat)) return;
    const o = m.tex[k] = m.tex[k] || {};
    o[slot] = imgId; (o.names = o.names || {})[slot] = file.name; setSlot(e.mat, slot, makeTexture(img, slot, e.mat, m), o);
  });
  saveNow(); renderMaterials();
  const noUV = mats.filter(e => keys.includes(e.key) && !e.hasUV).length;
  if (noUV) toast(`${file.name} added, but this model has no UV coordinates, so the image can't show on it`, true);
  else toast(`${file.name} → ${SLOTS.find(s => s[0] === slot)[1].toLowerCase()}${keys.length > 1 ? ` on ${keys.length} materials` : ''}${ok ? '' : ' (not stored: no space)'}`, !ok);
}
function clearSlot(key, slot) {
  const m = models[currentId], e = itemMaterials().find(x => x.key === key); if (!m || !e) return;
  m.tex = m.tex || {}; const o = m.tex[key] = m.tex[key] || {};
  o[slot] = null; if (o.names) delete o.names[slot]; setSlot(e.mat, slot, null, o); saveNow(); renderMaterials();
}
async function resetMaterial(key) {
  const m = models[currentId]; if (!m?.tex?.[key]) return;
  delete m.tex[key]; saveNow();
  await openModel(m.id, { quiet: true });                // re-read the model to get its own textures back
  toast('Material reset');
}
const sigOf = files => files.map(f => f.name + ':' + f.data.byteLength).sort().join('|');
async function addTextureFiles(files) {
  const m = models[currentId]; if (!m || !files.length) return;
  const missing = new Set((m.missing || []).map(n => n.toLowerCase()));
  const linked = files.filter(f => missing.has(f.name.toLowerCase())), rest = files.filter(f => !missing.has(f.name.toLowerCase()));
  if (linked.length && m.kind === 'import') {
    const stored = (await store.getFiles(m.id)) || [];
    const add = await Promise.all(linked.map(async f => ({ name: f.name, data: await f.arrayBuffer() })));
    const names = new Set(add.map(f => f.name.toLowerCase()));
    const merged = stored.filter(f => !names.has(f.name.toLowerCase())).concat(add);
    if (await store.putFiles(m.id, merged)) { m.sig = sigOf(merged); m.size = merged.reduce((a, f) => a + f.data.byteLength, 0); }
    saveNow();
    await openModel(m.id, { quiet: true });
    toast(`Linked ${linked.length} missing texture${linked.length > 1 ? 's' : ''}: ${linked.map(f => f.name).join(', ')}`);
  }
  if (!rest.length) return;
  const mats = itemMaterials();
  if (!mats.length) return toast('This object has no materials to put a texture on', true);
  const keys = openMatKey && mats.some(e => e.key === openMatKey) ? [openMatKey] : mats.map(e => e.key);
  await addImageTo(keys, 'map', rest[0]);
  if (rest.length > 1) setTimeout(() => toast(`Used ${rest[0].name} as base colour. Click a texture slot to place the other ${rest.length - 1}.`), 2100);
}
const thumbCache = new WeakMap();
function texThumb(t) {
  const im = t?.image; if (!im) return null;
  if (thumbCache.has(t)) return thumbCache.get(t);
  if (im instanceof HTMLImageElement && !im.complete) return null;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    c.getContext('2d').drawImage(im, 0, 0, 64, 64);
    const u = c.toDataURL('image/jpeg', 0.8); thumbCache.set(t, u); return u;
  } catch (e) { return null; }
}
const hex = c => '#' + c.getHexString();
function renderMaterials() {
  const m = models[currentId], list = $('mats'); if (!list) return;
  const mats = itemMaterials();
  $('matCount').textContent = mats.length + (mats.length === 1 ? ' material' : ' materials');
  $('matModel').textContent = m?.name || '—';
  const miss = (m?.missing || []).filter(n => IMAGE_EXT.test(n));
  $('missingBox').hidden = !miss.length || m?.kind !== 'import';
  $('missingText').innerHTML = `<b>${miss.length} texture${miss.length > 1 ? 's' : ''} missing.</b> The model asks for ${miss.slice(0, 5).map(n => `<span class="mono">${esc(n)}</span>`).join(', ')}${miss.length > 5 ? '…' : ''}. Add ${miss.length > 1 ? 'them' : 'it'} and ${miss.length > 1 ? 'they\'re' : 'it\'s'} linked automatically.`;
  $('noUV').hidden = !mats.length || mats.some(e => e.hasUV);
  list.innerHTML = '';
  if (!mats.length) { list.innerHTML = '<p class="hint">This object has no materials.</p>'; return; }
  mats.forEach(e => {
    const mt = e.mat, o = m?.tex?.[e.key], open = openMatKey === e.key || mats.length <= 2;
    const row = document.createElement('div'); row.className = 'mat' + (open ? ' open' : '');
    const hd = document.createElement('div'); hd.className = 'mhd'; hd.tabIndex = 0; hd.setAttribute('role', 'button'); hd.setAttribute('aria-expanded', open);
    const th = texThumb(mt.map);
    const n = SLOTS.filter(([s]) => mt[s]).length;
    hd.innerHTML = `<span class="swc" style="${th ? `background-image:url('${th}')` : mt.color ? `background:${hex(mt.color)}` : ''}"></span><span class="mn">${esc(e.name)}</span><small>${o ? 'edited · ' : ''}${n ? `${n} map${n > 1 ? 's' : ''}` : 'no maps'}</small>${icon('chev', 'xs chev')}`;
    const toggle = () => { openMatKey = openMatKey === e.key ? null : e.key; renderMaterials(); };
    hd.onclick = toggle; hd.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
    row.appendChild(hd);
    if (open) {
      const body = document.createElement('div'); body.className = 'mbody';
      if (mt.color) {
        const cr = document.createElement('div'); cr.className = 'slot';
        const ci = document.createElement('input'); ci.type = 'color'; ci.value = hex(mt.color); ci.setAttribute('aria-label', e.name + ' colour'); ci.style.margin = '0 2px';
        ci.oninput = () => { mt.color.set(ci.value); const mm = models[currentId]; mm.tex = mm.tex || {}; (mm.tex[e.key] = mm.tex[e.key] || {}).color = ci.value; scheduleSave(); };
        ci.onchange = () => renderMaterials();
        const tx = document.createElement('div'); tx.className = 'tx'; tx.innerHTML = `<b>Colour</b><span>${hex(mt.color).toUpperCase()} · tints the base map</span>`;
        cr.append(ci, tx);
        if (o) { const rb = document.createElement('button'); rb.className = 'btn ghost sm'; rb.textContent = 'Reset'; rb.title = 'Back to the model\'s own material'; rb.onclick = () => resetMaterial(e.key); cr.appendChild(rb); }
        body.appendChild(cr);
      }
      SLOTS.filter(([s]) => s in mt).forEach(([s, label]) => {
        const t = mt[s], tt = texThumb(t);
        const r = document.createElement('div'); r.className = 'slot';
        const pick = () => { slotTarget = { keys: [e.key], slot: s }; $('slotFile').click(); };
        const tile = document.createElement('button'); tile.className = 'tile2' + (t ? ' full' : ''); tile.setAttribute('aria-label', `Choose an image for ${label.toLowerCase()}`);
        if (tt) tile.style.backgroundImage = `url("${tt}")`; else tile.innerHTML = t ? 'map' : icon('plus', 'xs');
        tile.onclick = pick;
        const tx = document.createElement('div'); tx.className = 'tx';
        tx.innerHTML = `<b>${label}</b><span>${esc(t ? (o?.names?.[s] || (o?.[s] ? 'Your image' : 'From the model')) : SLOT_HINT[s])}</span>`;
        const ch = document.createElement('button'); ch.className = 'btn sm'; ch.textContent = t ? 'Replace' : 'Choose…'; ch.onclick = pick;
        r.append(tile, tx, ch);
        if (t) { const x = document.createElement('button'); x.className = 'nud'; x.title = 'Remove'; x.setAttribute('aria-label', `Remove the ${label.toLowerCase()} texture`); x.innerHTML = icon('x', 'xs'); x.onclick = () => clearSlot(e.key, s); r.appendChild(x); }
        r.ondragover = ev => { ev.preventDefault(); ev.stopPropagation(); r.classList.add('hot'); };
        r.ondragleave = () => r.classList.remove('hot');
        r.ondrop = ev => { ev.preventDefault(); ev.stopPropagation(); r.classList.remove('hot'); dragDepth = 0; $('drop').classList.remove('on'); const f = ev.dataTransfer?.files?.[0]; if (f) addImageTo([e.key], s, f); };
        body.appendChild(r);
      });
      if (!e.hasUV) body.insertAdjacentHTML('beforeend', '<p class="hint" style="padding:4px 5px">This part has no UV coordinates: image textures won\'t show, the colour will.</p>');
      row.appendChild(body);
    }
    list.appendChild(row);
  });
}
$('texAdd').onclick = () => { slotTarget = null; $('texFile').click(); };
$('texAdd2').onclick = () => { slotTarget = null; $('texFile').click(); };
$('texAll').onclick = () => { slotTarget = { keys: itemMaterials().map(e => e.key), slot: 'map' }; $('slotFile').click(); };
$('texFile').onchange = e => { addTextureFiles([...e.target.files]); e.target.value = ''; };
$('slotFile').onchange = e => { const f = e.target.files[0]; if (f && slotTarget) addImageTo(slotTarget.keys, slotTarget.slot, f); e.target.value = ''; };

// ═════════════════════════ import window ═════════════════════════
// Files are staged and read straight away, so you see a live preview, which file is the model, which textures it
// found and which ones it is still missing, before anything is added to the library.
$('file').accept = ACCEPT;
$('import').onclick = () => openImport();
$('file').onchange = e => { openImport([...e.target.files]); e.target.value = ''; };
const extOf = n => (n.split('.').pop() || '').toLowerCase();
const mainOf = files => MODEL_EXTS.map(e => files.find(f => extOf(f.name) === e)).find(Boolean);
let staged = [], stagedRes = null, stagedMissing = [], stagedErr = null, parseTicket = 0;
let impR = null, impScene, impCam, impPivot, impRaf = 0, impReturn = null;
function openImport(files) {
  closePalette(); closeMenu();
  impReturn = document.activeElement;
  $('importDlg').hidden = false;
  if (!staged.length) { $('impUnits').value = prefs.importUnits || 'fit'; $('impPivot').value = 'center'; $('impGrip').checked = prefs.autoGripNew !== false; }
  if (files?.length) addStaged(files); else renderStaged();
  setTimeout(() => (staged.length ? $('impName') : $('impDrop')).focus(), 0);
}
function closeImport() {
  $('importDlg').hidden = true; cancelAnimationFrame(impRaf);
  parseTicket++; staged = []; stagedRes = null; stagedMissing = []; stagedErr = null;
  clearPreview(); $('impName').value = ''; $('impName').dataset.auto = '1'; renderStaged();
  impReturn?.focus?.();
}
async function addStaged(fileList) {
  const add = await Promise.all([...fileList].map(async f => ({ name: f.name, data: await f.arrayBuffer() })));
  add.forEach(f => { const i = staged.findIndex(x => x.name.toLowerCase() === f.name.toLowerCase()); if (i >= 0) staged[i] = f; else staged.push(f); });
  parseStaged();
}
async function parseStaged() {
  const ticket = ++parseTicket;
  stagedRes = null; stagedMissing = []; stagedErr = null; clearPreview();
  const main = mainOf(staged);
  if (main && (!$('impName').value || $('impName').dataset.auto !== '0')) { $('impName').value = main.name.replace(/\.[^.]+$/, ''); $('impName').dataset.auto = '1'; }
  if (main) { $('impPh').textContent = 'Reading the model…'; $('impPreview').classList.add('shim'); }
  renderStaged(!!main);
  if (!main) return;
  try {
    const res = await loadModelFiles(staged.slice());
    if (ticket !== parseTicket) return;
    stagedRes = res; showPreview(res.object); renderStaged();
    setTimeout(() => { if (ticket === parseTicket) { stagedMissing = [...new Set(res.missing)]; renderStaged(); } }, 1600);
  } catch (err) {
    if (ticket !== parseTicket) return;
    console.error(err); stagedErr = err.message || String(err); $('impPreview').classList.remove('shim'); $('impPh').textContent = 'This file could not be read.'; renderStaged();
  }
}
function renderStaged(loading = false) {
  const list = $('impFiles'), main = mainOf(staged);
  $('impCount').textContent = staged.length ? `${staged.length} file${staged.length > 1 ? 's' : ''} · ${fmtBytes(staged.reduce((a, f) => a + f.data.byteLength, 0))}` : '';
  list.innerHTML = '';
  if (!staged.length) list.innerHTML = '<p class="hint">No files yet. Add the model file and, if it has them, its textures (.png / .jpg), .mtl or .bin files.</p>';
  staged.forEach(f => {
    const e = extOf(f.name);
    const [label, cls] = f === main ? ['Model', 't-model'] : MODEL_EXTS.includes(e) ? ['Not used', 't-off'] : IMAGE_EXT.test(f.name) ? ['Texture', 't-tex'] : ['mtl', 'bin'].includes(e) ? ['Companion', 't-comp'] : ['Extra', 't-off'];
    const row = document.createElement('div'); row.className = 'file';
    row.innerHTML = `${icon(IMAGE_EXT.test(f.name) ? 'image' : f === main ? 'box' : 'file')}<span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span class="tag ${cls}">${label}</span><span class="s">${fmtBytes(f.data.byteLength)}</span>`;
    const x = document.createElement('button'); x.className = 'nud'; x.setAttribute('aria-label', 'Remove ' + f.name); x.innerHTML = icon('x', 'xs');
    x.onclick = () => { staged = staged.filter(s => s !== f); parseStaged(); };
    row.appendChild(x); list.appendChild(row);
  });
  const missImgs = stagedMissing.filter(n => !staged.some(f => f.name.toLowerCase() === n));
  missImgs.forEach(n => {
    const row = document.createElement('div'); row.className = 'file miss';
    row.innerHTML = `${icon('alert')}<span class="n">${esc(n)}</span><span class="tag t-miss">Missing</span>`;
    list.appendChild(row);
  });
  const st = $('impStats'); st.innerHTML = '';
  const badge = (t, c = 't-comp') => { const b = document.createElement('span'); b.className = 'tag ' + c; b.textContent = t; st.appendChild(b); };
  if (stagedRes) {
    let meshes = 0, mats = new Set(), uv = false;
    stagedRes.object.traverse(o => { if (o.isMesh) { meshes++; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && mats.add(m)); if (o.geometry?.attributes?.uv) uv = true; } });
    const maps = [...mats].filter(m => m.map).length;
    badge(`${meshes} mesh${meshes === 1 ? '' : 'es'}`); badge(`${mats.size} material${mats.size === 1 ? '' : 's'}`);
    badge(maps ? `${maps} with textures` : 'no textures', maps ? 't-tex' : 't-comp');
    badge(uv ? 'has UVs' : 'no UVs', uv ? 't-tex' : 't-miss');
    if (missImgs.length) badge(`${missImgs.length} missing`, 't-miss');
  }
  const msg = $('impMsg');
  if (!staged.length) msg.textContent = '';
  else if (!main) msg.textContent = 'Add a model file (FBX, OBJ, glTF, GLB, DAE, STL, PLY, 3MF or 3DS).';
  else if (stagedErr) { msg.innerHTML = ''; msg.append(Object.assign(document.createElement('span'), { style: 'color:var(--err)', textContent: `Couldn't read ${main.name}: ${stagedErr}` })); }
  else if (loading || !stagedRes) msg.innerHTML = '<span class="spin"></span>&nbsp; Reading the model…';
  else if (missImgs.length) msg.innerHTML = `<span style="color:#fcd34d">${missImgs.length} texture${missImgs.length > 1 ? 's are' : ' is'} missing. Drop ${missImgs.length > 1 ? 'them' : 'it'} in now, or add ${missImgs.length > 1 ? 'them' : 'it'} later in Material.</span>`;
  else msg.textContent = 'Looks good. Ready to add.';
  $('impSteps').innerHTML = stagedRes ? '1 Files · <b>2 Check</b> · 3 Add' : '<b>1 Files</b> · 2 Check · 3 Add';
  $('impOk').disabled = !stagedRes;
}
function ensurePreview() {
  if (impR) return;
  impR = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  impR.setPixelRatio(Math.min(devicePixelRatio, 2));
  impScene = new THREE.Scene();
  impScene.environment = new THREE.PMREMGenerator(impR).fromScene(new RoomEnvironment(), 0.04).texture;
  impScene.environmentIntensity = 0.6;
  impScene.add(new THREE.HemisphereLight(0xdfe6f5, 0x2a2420, 1.4));
  const d = new THREE.DirectionalLight(0xffffff, 1.8); d.position.set(1, 2, 1.5); impScene.add(d);
  impCam = new THREE.PerspectiveCamera(32, 16 / 10, 0.01, 100); impCam.position.set(0, 0.45, 2.3); impCam.lookAt(0, 0, 0);
  impPivot = new THREE.Group(); impScene.add(impPivot);
  $('impPreview').appendChild(impR.domElement);
  // drag to turn the preview
  let drag = null;
  impR.domElement.addEventListener('pointerdown', e => { drag = [e.clientX, impPivot.rotation.y]; impR.domElement.setPointerCapture(e.pointerId); });
  impR.domElement.addEventListener('pointermove', e => { if (drag) impPivot.rotation.y = drag[1] + (e.clientX - drag[0]) * 0.01; });
  impR.domElement.addEventListener('pointerup', () => drag = null);
  impPivot.userData.drag = () => drag;
}
function showPreview(obj) {
  ensurePreview(); clearPreview();
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const wrap = new THREE.Group(); wrap.scale.setScalar(s); wrap.position.copy(c).multiplyScalar(-s); wrap.add(obj);   // the model's own transform stays untouched
  impPivot.add(wrap); impPivot.rotation.set(0, -0.6, 0);
  $('impPh').hidden = true; $('impPreview').classList.remove('shim');
  const loop = () => {
    impRaf = requestAnimationFrame(loop);
    const r = $('impPreview').getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (w && h && (impR.domElement.width !== Math.round(w * impR.getPixelRatio()) || impR.domElement.height !== Math.round(h * impR.getPixelRatio()))) { impR.setSize(w, h, false); impCam.aspect = w / h; impCam.updateProjectionMatrix(); }
    if (!impPivot.userData.drag() && !reduceMotion()) impPivot.rotation.y += 0.005;
    impR.render(impScene, impCam);
  };
  cancelAnimationFrame(impRaf); loop();
}
// a small picture of an object on its own (built-in cards before they've been opened)
function objectThumb(obj) {
  try {
    ensurePreview();
    const was = impPivot.visible; impPivot.visible = false;
    const box = new THREE.Box3().setFromObject(obj, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
    const wrap = new THREE.Group(); wrap.scale.setScalar(s); wrap.position.copy(c).multiplyScalar(-s); wrap.add(obj);
    const turn = new THREE.Group(); turn.rotation.set(0.15, -0.7, 0.2); turn.add(wrap); impScene.add(turn);
    const pr = impR.getPixelRatio(); impR.setPixelRatio(1); impR.setSize(320, 200, false);
    impCam.aspect = 1.6; impCam.updateProjectionMatrix();
    impR.setClearColor(0x15141c, 1); impR.render(impScene, impCam); impR.setClearColor(0x000000, 0);
    const url = impR.domElement.toDataURL('image/jpeg', 0.8);
    impScene.remove(turn); impPivot.visible = was; impR.setPixelRatio(pr);
    impR.setSize(1, 1, false);
    return url;
  } catch (e) { return null; }
}
function clearPreview() {
  cancelAnimationFrame(impRaf);
  if (impPivot) { impPivot.clear(); impR.render(impScene, impCam); }
  const ph = $('impPh'); ph.hidden = false; ph.textContent = 'A preview appears here.';
  $('impPreview').classList.remove('shim');
}
async function confirmImport() {
  if (!stagedRes) return;
  const files = staged.slice(), res = stagedRes, units = $('impUnits').value, pivot = $('impPivot').value, grip = $('impGrip').checked;
  const name = $('impName').value.trim() || res.name.replace(/\.[^.]+$/, '');
  res.object.removeFromParent();                         // out of the preview, back to its own transform
  impReturn = null; closeImport(); closeModels();
  await finishImport(files, res, { name, units, pivot, grip });
}
async function finishImport(files, res, { name, units = 'fit', pivot = 'center', grip = true } = {}) {
  try {
    const sig = sigOf(files);
    const dup = Object.values(models).find(m => m.sig === sig);
    if (dup) {
      if (dup.id === currentId || await openModel(dup.id, { quiet: true })) return toast(`"${dup.name}" is already in your library, so it was opened`);
      delete models[dup.id];                              // its stored files are gone: add it fresh below
    }
    const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    models[id] = { id, name, kind: 'import', format: extOf(res.name), sig, size: files.reduce((a, f) => a + f.data.byteLength, 0), created: Date.now(), used: Date.now(), thumb: null, work: null, poses: [], initItem: { units, pivot }, initGrip: grip };
    const stored = await store.putFiles(id, files);
    await openModel(id, { loaded: res, quiet: true });
    showTab('object');
    toast(stored ? `Added ${name} to your library` : `Loaded ${name}, but it couldn't be stored, so it won't be remembered`, !stored);
  } catch (err) {
    console.error(err);
    toast('Could not add the model: ' + (err.message || err), true);
  }
}
$('impDrop').onclick = () => $('impFile').click();
$('impDrop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('impFile').click(); } };
$('impFile').onchange = e => { addStaged([...e.target.files]); e.target.value = ''; };
$('impName').oninput = () => { $('impName').dataset.auto = '0'; };
$('impOk').onclick = confirmImport;
$('impCancel').onclick = closeImport; $('impClose').onclick = closeImport;
$('importDlg').onclick = e => { if (e.target === $('importDlg')) closeImport(); };
$('mImport').onclick = () => openImport();

// ═════════════════════════ settings & accessibility ═════════════════════════
let appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
let upd = { status: window.desktop ? 'idle' : 'web' }, setReturn = null;
const sysReduce = matchMedia('(prefers-reduced-motion: reduce)');
const reduceMotion = () => (prefs.reduce ?? sysReduce.matches);
function applyAccess() {
  document.body.classList.toggle('large', !!prefs.large);
  document.body.classList.toggle('hc', !!prefs.contrast);
  document.body.classList.toggle('reduce', reduceMotion());
  if (prefs.posesH) $('posesBox').style.setProperty('--poses-h', prefs.posesH + 'px');
  setTimeout(placeTreeHl, 50);
}
sysReduce.addEventListener?.('change', applyAccess);
function openSettings(pane = 'general') {
  closePalette(); closeMenu(); setReturn = document.activeElement;
  $('settingsDlg').hidden = false; showSPane(pane); syncSettings();
  setTimeout(() => document.querySelector(`.snav [data-spane="${pane}"]`)?.focus(), 0);
}
function closeSettings() { $('settingsDlg').hidden = true; setReturn?.focus?.(); }
function showSPane(p) {
  document.querySelectorAll('.snav [data-spane]').forEach(b => { b.classList.toggle('on', b.dataset.spane === p); b.setAttribute('aria-current', b.dataset.spane === p ? 'page' : 'false'); });
  document.querySelectorAll('.spane').forEach(s => s.classList.toggle('on', s.dataset.spane === p));
}
function syncSettings() {
  $('setHome').checked = prefs.homeOnStart !== false; $('setGrip').checked = prefs.autoGripNew !== false;
  $('setUnits').value = prefs.importUnits || 'fit';
  document.querySelectorAll('#setMouse .optc').forEach(b => { const on = b.dataset.m === navMode(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('setZoomCursor').checked = prefs.zoomCursor !== false;
  document.querySelectorAll('#setZoom button').forEach(b => { b.classList.toggle('on', +b.dataset.z === (prefs.uiScale || 1)); b.disabled = !window.desktop; });
  $('zoomHint').textContent = window.desktop ? 'Makes all text and controls bigger or smaller.' : 'In a browser, use Ctrl + / Ctrl − to zoom instead.';
  $('setLarge').checked = !!prefs.large; $('setContrast').checked = !!prefs.contrast; $('setReduce').checked = reduceMotion();
  renderUpdate();
}
document.querySelectorAll('.snav [data-spane]').forEach(b => b.onclick = () => showSPane(b.dataset.spane));
$('sbVersion').onclick = () => openSettings(upd.status === 'ready' ? 'updates' : 'about');
$('setClose').onclick = closeSettings;
$('settingsDlg').onclick = e => { if (e.target === $('settingsDlg')) closeSettings(); };
$('setHome').onchange = e => { prefs.homeOnStart = e.target.checked; scheduleSave(); };
$('setGrip').onchange = e => { prefs.autoGripNew = e.target.checked; scheduleSave(); };
$('setUnits').onchange = e => { prefs.importUnits = e.target.value; scheduleSave(); };
document.querySelectorAll('#setMouse .optc').forEach(b => b.onclick = () => { prefs.mouse = b.dataset.m; applyMouseMode(); syncSettings(); scheduleSave(); });
$('setZoomCursor').onchange = e => { prefs.zoomCursor = e.target.checked; applyMouseMode(); scheduleSave(); };
document.querySelectorAll('#setZoom button').forEach(b => b.onclick = async () => { prefs.uiScale = +b.dataset.z; scheduleSave(); syncSettings(); if (window.desktop) await window.desktop.setZoom(prefs.uiScale); });
$('setLarge').onchange = e => { prefs.large = e.target.checked; applyAccess(); scheduleSave(); };
$('setContrast').onchange = e => { prefs.contrast = e.target.checked; applyAccess(); scheduleSave(); };
$('setReduce').onchange = e => { prefs.reduce = e.target.checked; applyAccess(); scheduleSave(); };
$('resetAll').onclick = () => {
  if (!confirm('Delete every imported model, texture, saved pose and setting? This cannot be undone.')) return;
  resetting = true; clearTimeout(saveTimer);
  try { localStorage.removeItem('handposer.v1'); } catch (e) { }
  const req = indexedDB.deleteDatabase('handposer');
  req.onsuccess = req.onerror = req.onblocked = () => location.reload();
};
function openLink(url) { if (window.desktop) window.desktop.openExternal(url); else window.open(url, '_blank', 'noopener'); }
document.querySelectorAll('a[target=_blank]').forEach(a => a.onclick = e => { if (window.desktop) { e.preventDefault(); window.desktop.openExternal(a.href); } });

// ───────── updates (desktop app) ─────────
function renderUpdate() {
  const s = upd.status, pill = $('updatePill');
  pill.hidden = !(s === 'ready' || s === 'downloading');
  pill.classList.toggle('ready', s === 'ready');
  $('updFill').style.width = s === 'downloading' ? (upd.percent || 0) + '%' : '0';
  $('updateText').textContent = s === 'ready' ? `Update ${upd.version} ready · Restart` : `Downloading update · ${upd.percent || 0}%`;
  pill.title = s === 'ready' ? 'Restart Hand Poser to install the update' : 'Downloading in the background';
  const T = {
    web: 'This is the web version. It doesn\'t update itself; the installed desktop app does.',
    dev: 'Development build: update checks only run in the installed app.',
    idle: 'Checking for updates shortly…', checking: 'Checking for updates…',
    latest: `You're on the latest version${appVersion ? ' (v' + appVersion + ')' : ''}.`,
    downloading: `Downloading version ${upd.version || ''}… ${upd.percent || 0}%`,
    ready: `Version ${upd.version} has been downloaded. Restart to install it (or it installs when you close the app).`,
    error: /\b404\b/.test(upd.message || '') ? 'No published releases were found on GitHub yet.' : `Couldn't check for updates${upd.message ? ': ' + upd.message : ''}. Check your internet connection.`,
  };
  $('updText').textContent = T[s] || '—';
  $('updSpin').hidden = !(s === 'checking' || s === 'downloading' || s === 'idle');
  $('updCheck').disabled = s === 'web' || s === 'dev' || s === 'checking' || s === 'downloading';
  $('updInstall').hidden = s !== 'ready';
  $('sbVersion').textContent = appVersion ? 'v' + appVersion : 'About';
  $('aboutVer').textContent = appVersion ? `Version ${appVersion}` : '';
  $('splashVer').textContent = (appVersion ? `v${appVersion} · ` : '') + 'loading your models';
}
const installUpdate = () => window.desktop?.installUpdate();
$('updatePill').onclick = () => { if (upd.status === 'ready') installUpdate(); else openSettings('updates'); };
$('updInstall').onclick = installUpdate;
$('updCheck').onclick = async () => { if (!window.desktop) return; upd = { ...upd, status: 'checking' }; renderUpdate(); upd = await window.desktop.checkForUpdates(); renderUpdate(); };
if (window.desktop) {
  document.body.classList.add('desktop');
  window.desktop.info().then(i => { appVersion = i.version; upd = i.update || upd; if (i.platform === 'darwin') document.body.classList.add('mac'); renderUpdate(); });
  window.desktop.onUpdate(s => {
    const was = upd.status; upd = s; renderUpdate();
    if (s.status === 'ready' && was !== 'ready') toast(`Version ${s.version} is ready. Click the green pill below to restart, or it installs when you close the app.`, false, { ms: 7000 });
  });
}
renderUpdate();

// ═════════════════════════ drag & drop ═════════════════════════
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('drop').classList.add('on'); e.preventDefault(); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (files.length === 1 && /\.json$/i.test(files[0].name)) return importJsonFile(files[0]);
  if (!$('importDlg').hidden) return addStaged(files);                                   // the import window takes everything
  if (files.every(f => IMAGE_EXT.test(f.name))) { closeModels(); showTab('material'); return addTextureFiles(files); }   // just images: textures for the current model
  openImport(files);
});

// ═════════════════════════ hands: active, live, display ═════════════════════════
$('handR').onclick = () => setActive('R'); $('handL').onclick = () => setActive('L');
$('live').onchange = e => { live = e.target.checked; if (live) { mirrorTo(other(active)); changed({ commitNow: true }); } else refreshUI(); scheduleSave(); };
$('limits').onchange = e => {
  limits = e.target.checked;
  if (limits) Object.values(hands).forEach(h => { POSABLE.forEach(b => clampBone(h, b)); h.applyAll(); });
  changed({ commitNow: true });
};
function applyDisplay() {
  Object.values(hands).forEach(h => {
    h.root.visible = prefs.show[h.side];
    const act = h.side === active && prefs.show[h.side];
    Object.values(h.markers).forEach(m => m.visible = act && prefs.showJoints);
    Object.values(h.ik).forEach(m => m.visible = act && prefs.showIK);
    h.material.transparent = prefs.xray; h.material.opacity = prefs.xray ? 0.45 : 1; h.material.depthWrite = !prefs.xray;
    h.material.map = prefs.furTex ? furTex : null;
    h.material.color.set(prefs.fur); h.material.needsUpdate = true;
  });
  grid.visible = prefs.grid;
  $('showR').checked = prefs.show.R; $('showL').checked = prefs.show.L; $('showIK').checked = prefs.showIK;
  $('fur').value = prefs.fur; $('furTex').checked = prefs.furTex;
}
$('showR').onchange = e => { prefs.show.R = e.target.checked; if (!e.target.checked && active === 'R' && prefs.show.L) setActive('L'); applyDisplay(); refreshTree(); scheduleSave(); };
$('showL').onchange = e => { prefs.show.L = e.target.checked; if (!e.target.checked && active === 'L' && prefs.show.R) setActive('R'); applyDisplay(); refreshTree(); scheduleSave(); };
$('showIK').onchange = e => { prefs.showIK = e.target.checked; if (!prefs.showIK && sel?.kind === 'ik') select(null); applyDisplay(); attachGizmo(); scheduleSave(); };
$('fur').oninput = e => { prefs.fur = e.target.value; applyDisplay(); scheduleSave(); };
$('furTex').onchange = e => { prefs.furTex = e.target.checked; applyDisplay(); scheduleSave(); };

// toolbar
$('toolSelect').onclick = () => setTool('select'); $('toolMove').onclick = () => setTool('move'); $('toolRotate').onclick = () => setTool('rotate');
$('space').onclick = () => setSpace(space === 'local' ? 'world' : 'local');
$('snap').onclick = () => setSnap(!snap);
$('undo').onclick = undo; $('redo').onclick = redo;
$('frameBtn').onclick = () => frameSelection();
$('selClear').onclick = () => select(null);
$('paletteBtn').onclick = () => openPalette();
$('exportTop').onclick = () => exportJson();
$('tRight').onclick = () => $('props').classList.toggle('open');
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(b.dataset.view));

// ═════════════════════════ saved poses ═════════════════════════
function refreshLib() {
  const el = $('lib'); el.innerHTML = '';
  const library = lib();
  refreshModelChrome();
  if (!library.length) { el.innerHTML = '<p class="empty-s">No poses saved for this model yet. Use <b>+ Save</b> or Ctrl+S.</p>'; return; }
  library.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'pose'; row.setAttribute('role', 'listitem'); row.tabIndex = 0;
    row.title = 'Load this pose (both hands and the object)';
    row.innerHTML = `<span class="pt" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"></span><span class="tx"><b>${esc(p.name)}</b><small>Both hands · object</small></span>`;
    const more = document.createElement('button'); more.className = 'ib more'; more.setAttribute('aria-label', `More for ${p.name}`); more.innerHTML = icon('more');
    row.appendChild(more);
    const load = () => { applyLibPose(p); changed({ commitNow: true }); toast(`Loaded "${p.name}"`, false, { undo: true }); };
    const menu = (x, y) => openMenu([{ header: p.name },
      { label: 'Load', icon: 'check', run: load },
      { label: `Load fingers onto the ${SIDE_NAME[active]} hand`, icon: 'hand', run: () => { H().setPose(p[active]); changed({ commitNow: true }); toast(`Fingers from "${p.name}"`, false, { undo: true }); } },
      { label: 'Update with the current pose', icon: 'save', run: () => { const s = JSON.parse(snapshot()); Object.assign(p, { R: s.R, L: s.L, hR: s.hR, hL: s.hL, thumb: captureThumb(96, 64) || p.thumb }); refreshLib(); scheduleSave(); toast(`Updated "${p.name}"`); } },
      { label: 'Rename…', icon: 'file', run: () => { const n = prompt('Rename pose', p.name); if (n?.trim()) { p.name = n.trim(); refreshLib(); scheduleSave(); } } },
      '-', { label: 'Delete', icon: 'trash', run: () => { library.splice(i, 1); refreshLib(); scheduleSave(); toast(`Deleted "${p.name}"`); } }], x, y);
    row.onclick = e => { if (!e.target.closest('.more')) load(); };
    row.onkeydown = e => { if (e.key === 'Enter') load(); else if (e.key === 'Delete') { library.splice(i, 1); refreshLib(); scheduleSave(); } };
    row.oncontextmenu = e => { e.preventDefault(); menu(e.clientX, e.clientY); };
    more.onclick = e => { e.stopPropagation(); const r = more.getBoundingClientRect(); menu(r.left, r.bottom + 4); };
    el.appendChild(row);
  });
}
function savePose(name) {
  if (!models[currentId]) return;
  const library = lib();
  name = name || `Pose ${library.length + 1}`;
  const s = JSON.parse(snapshot()), ex = library.findIndex(p => p.name === name);
  const entry = { name, R: s.R, L: s.L, hR: s.hR, hL: s.hL, thumb: captureThumb(96, 64) };
  if (ex >= 0) library[ex] = entry; else library.push(entry);
  models[currentId].thumb = captureThumb() || models[currentId].thumb;
  refreshLib(); scheduleSave(); toast(`Saved "${name}" with ${models[currentId].name}`);
}
function quickSavePose() { savePose($('poseName').value.trim()); $('poseName').value = ''; }
$('poseSave').onclick = quickSavePose;
$('poseName').onkeydown = e => { if (e.key === 'Enter') quickSavePose(); };
$('poseQuick').onclick = () => { showTab('export'); setTimeout(() => $('poseName').focus(), 50); };

// ═════════════════════════ export / import ═════════════════════════
const shortName = b => BONE_NAMES[b].replace(/\.R_nhd$/, '').replace(/\.R_end$/, '_end');
function exportData() {
  const side = s => {
    const h = hands[s], e = new THREE.Euler().setFromQuaternion(h.holder.quaternion, 'YXZ');
    const bones = {};
    POSABLE.forEach(b => bones[shortName(b)] = { curl: round(h.pose[b][0], 2), spread: round(h.pose[b][1], 2), twist: round(h.pose[b][2], 2), localQuaternion: h.bones[b].quaternion.toArray().map(v => round(v, 6)) });
    return { object: { position: h.holder.position.toArray().map(v => round(v, 6)), quaternion: h.holder.quaternion.toArray().map(v => round(v, 6)), eulerYXZdeg: [e.x, e.y, e.z].map(v => round(v / DEG, 2)) }, bones };
  };
  const unityR = { object: unityHold(), bones: {} };
  POSABLE.forEach(b => { const q = hands.R.bones[b].quaternion; unityR.bones[shortName(b)] = [q.x, -q.y, -q.z, q.w].map(v => round(v, 6)); });
  return {
    app: 'Hand Poser', version: 1, exported: new Date().toISOString(),
    notes: 'Positions in metres. "right"/"left" are in each hand\'s own hand-bone space, three.js axes (right-handed, Y up). ' +
      'Bone curl/spread/twist are degrees about anatomical axes relative to the rest pose (identical numbers on both hands = exact mirror). ' +
      'localQuaternion is the bone\'s full local rotation [x,y,z,w]. "unityRight" is the right hand in Unity hand-bone space (left-handed).',
    object: { name: item.name, sample: item.sample, units: item.units, fitSizeCm: item.fit, scale: item.scale, pivot: item.pivot, mirrorModelInLeftHand: item.mirrorGeo, appliedScale: round(itemScale(), 8) },
    right: side('R'), left: side('L'), unityRight: unityR,
  };
}
function unityHold() { const h = hands.R.holder; return { position: [-h.position.x, h.position.y, h.position.z].map(v => round(v, 6)), quaternion: [h.quaternion.x, -h.quaternion.y, -h.quaternion.z, h.quaternion.w].map(v => round(v, 6)) }; }
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function exportJson() {
  download(`hand-pose-${(item.name || 'pose').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')}.json`, new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' }));
  toast('Pose exported as JSON');
}
$('exportJson').onclick = exportJson;
$('importJson').onclick = () => $('jsonFile').click();
$('jsonFile').onchange = e => { if (e.target.files[0]) importJsonFile(e.target.files[0]); e.target.value = ''; };
async function importJsonFile(f) {
  try {
    const d = JSON.parse(await f.text());
    const byName = {}; POSABLE.forEach(b => byName[shortName(b)] = b);
    for (const [s, key] of [['R', 'right'], ['L', 'left']]) {
      const src = d[key]; if (!src) continue;
      const pose = {};
      Object.entries(src.bones || {}).forEach(([n, v]) => { if (byName[n] != null) pose[byName[n]] = [v.curl || 0, v.spread || 0, v.twist || 0]; });
      hands[s].setPose(pose);
      if (src.object) setHold(s, { p: src.object.position, q: src.object.quaternion });
    }
    if (d.object) {
      Object.assign(item, { units: d.object.units || item.units, fit: d.object.fitSizeCm || item.fit, scale: d.object.scale || item.scale, pivot: d.object.pivot || item.pivot, mirrorGeo: !!d.object.mirrorModelInLeftHand });
      refreshItemUI(); rebuildItem();
    }
    changed({ commitNow: true }); toast('Loaded ' + f.name, false, { undo: true });
  } catch (err) { console.error(err); toast('Not a Hand Poser JSON file', true); }
}
async function copyUnity() {
  const u = unityHold();
  const lines = [`# Hand Poser - right hand, Unity hand-bone space (metres | quaternion x, y, z, w)`, `object = ${u.position.join(', ')} | ${u.quaternion.join(', ')}`];
  POSABLE.forEach(b => { const q = hands.R.bones[b].quaternion; lines.push(`${shortName(b)} = ${[q.x, -q.y, -q.z, q.w].map(v => v.toFixed(5)).join(', ')}`); });
  const txt = lines.join('\n');
  try { await navigator.clipboard.writeText(txt); toast('Copied Unity text'); }
  catch (e) { download('hand-pose-unity.txt', new Blob([txt], { type: 'text/plain' })); toast('The clipboard was blocked, so it was saved as a file'); }
}
$('copyUnity').onclick = copyUnity;
function screenshot() {
  const vis = []; scene.traverse(o => { if ((o.userData.pick || o === gizmo.getHelper()) && o.visible) { vis.push(o); o.visible = false; } });
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => { download('hand-pose.png', b); vis.forEach(o => o.visible = true); toast('Screenshot saved'); });
}
$('shot').onclick = screenshot;

// ═════════════════════════ camera ═════════════════════════
let tween = null;
function flyTo(pos, target) {
  if (reduceMotion()) { camera.position.copy(pos); orbit.target.copy(target); return; }
  tween = { p0: camera.position.clone(), t0: orbit.target.clone(), p1: pos, t1: target, start: performance.now() };
}
function view(v) {
  const hp = H().root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.06, 0));
  const palm = new THREE.Vector3(active === 'R' ? -1 : 1, 0, 0);
  const V = {
    front: [new THREE.Vector3(0.1, 0.12, -0.62), CENTER],
    back: [new THREE.Vector3(-0.1, 0.12, 0.62), CENTER],
    top: [new THREE.Vector3(0, 0.75, 0.02), CENTER],
    pov: [new THREE.Vector3(-0.26, 0.3, 0.58), new THREE.Vector3(0.02, 0.05, 0)],
    thumb: [hp.clone().add(new THREE.Vector3(0, 0.02, 0.35)), hp],
    palm: [hp.clone().addScaledVector(palm, 0.17).add(new THREE.Vector3(0, 0.06, -0.24)), hp],
  };
  if (v === 'fit') return frameSelection();
  const [p, t] = V[v]; flyTo(p.clone(), t.clone());
  $('camLbl').textContent = { front: 'Front', back: 'Back', top: 'Top', pov: 'Perspective', thumb: 'Thumb side', palm: 'Palm' }[v];
}
function frameSelection() {
  const h = H(), box = new THREE.Box3();
  if (sel?.kind === 'object') box.setFromObject(h.holder);
  else if (sel?.kind === 'bone' || sel?.kind === 'ik') {
    const fk = sel.kind === 'ik' ? sel.finger : fingerOf(sel.b), F = FINGERS[fk];
    (F ? F.bones : [sel.b]).forEach(b => box.expandByPoint(h.bonePosWorld(b)));
    if (F) box.expandByPoint(h.tipWorld(fk));
    box.expandByScalar(0.03);
  } else { [1, 6, 10, 14].forEach(b => box.expandByPoint(h.bonePosWorld(b))); box.expandByObject(h.holder); }
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.03);
  const dir = camera.position.clone().sub(orbit.target).normalize();
  flyTo(c.clone().addScaledVector(dir, r / Math.sin(camera.fov * DEG / 2) * 1.1), c);
}
// the little axes in the corner follow the camera
const AX = [['X', 0xf87171, new THREE.Vector3(1, 0, 0)], ['Y', 0x4ade80, new THREE.Vector3(0, 1, 0)], ['Z', 0x60a5fa, new THREE.Vector3(0, 0, 1)]];
$('axesG').innerHTML = AX.map(([n, c]) => `<g data-ax="${n}"><line stroke="${hexCol(c)}" stroke-width="2.5" stroke-linecap="round" x1="0" y1="0"/><circle r="8" fill="${hexCol(c)}"/><text text-anchor="middle" dy="3.5" font-size="9" font-weight="700" font-family="JetBrains Mono, monospace" fill="#111">${n}</text></g>
  <circle data-neg="${n}" r="5" fill="none" stroke="${hexCol(c)}" stroke-width="1.5" opacity=".7"/>`).join('');
const axQ = new THREE.Quaternion(), axLast = new THREE.Quaternion(1, 1, 1, 1), axV = new THREE.Vector3();
function updateAxes() {
  if (axLast.equals(camera.quaternion)) return; axLast.copy(camera.quaternion);
  axQ.copy(camera.quaternion).invert();
  const g = $('axesG'), order = [];
  AX.forEach(([n, , v]) => {
    axV.copy(v).applyQuaternion(axQ);
    const x = axV.x * 24, y = -axV.y * 24, el = g.querySelector(`[data-ax="${n}"]`), neg = g.querySelector(`[data-neg="${n}"]`);
    el.querySelector('line').setAttribute('x2', x * 0.7); el.querySelector('line').setAttribute('y2', y * 0.7);
    el.querySelector('circle').setAttribute('cx', x); el.querySelector('circle').setAttribute('cy', y);
    el.querySelector('text').setAttribute('x', x); el.querySelector('text').setAttribute('y', y);
    neg.setAttribute('cx', -x); neg.setAttribute('cy', -y);
    order.push([axV.z, el], [-axV.z, neg]);
  });
  order.sort((a, b) => a[0] - b[0]).forEach(([, el]) => g.appendChild(el));
}

// ═════════════════════════ keyboard ═════════════════════════
const REGIONS = () => [$('titlebar'), $('outliner'), $('stage'), $('props'), $('statusbar')];
function cycleRegion(dir) {
  const regs = REGIONS().filter(r => r.offsetParent !== null || r === $('outliner'));
  const i = regs.findIndex(r => r.contains(document.activeElement));
  const r = regs[(i + dir + regs.length) % regs.length];
  const target = r === $('outliner') ? ($('tree').querySelector('.node[tabindex="0"]') || $('olFilter')) : r === $('stage') ? renderer.domElement : r === $('props') ? document.querySelector('.ptab.on') : [...r.querySelectorAll('button:not([disabled]), input')].find(el => el.offsetParent !== null);
  target?.focus();
}
addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && !['range', 'checkbox', 'radio'].includes(document.activeElement.type);
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (menuEl) { if (e.key === 'Escape') { e.preventDefault(); closeMenu()?.focus(); } return; }   // menus handle their own keys
  if (e.key === 'Escape') {
    if (!$('importDlg').hidden) return closeImport();
    if (!$('settingsDlg').hidden) return closeSettings();
    if (!$('palette').hidden) return closePalette();
    if (!$('library').hidden) return closeModels();
    if ($('outliner').classList.contains('open')) return openOutliner(false);
    if (typing) return document.activeElement.blur();
    return select(null);
  }
  if (e.key === 'F6') { e.preventDefault(); return cycleRegion(e.shiftKey ? -1 : 1); }
  if (mod && k === 'o') { e.preventDefault(); return openImport(); }
  if (mod && k === ',') { e.preventDefault(); return openSettings(); }
  if (!$('importDlg').hidden || !$('settingsDlg').hidden) return;
  if (mod && k === 'k') { e.preventDefault(); return $('palette').hidden ? openPalette() : closePalette(); }
  if (!$('palette').hidden) return;
  if (!$('library').hidden) { if (!typing && k === 'h') closeModels(); return; }
  const NUMVIEW = { Numpad1: mod ? 'back' : 'front', Numpad3: 'thumb', Numpad7: 'top', Numpad0: 'pov' };
  if (!typing && NUMVIEW[e.code]) { e.preventDefault(); return view(NUMVIEW[e.code]); }
  if (!typing && e.code === 'NumpadDecimal') { e.preventDefault(); return frameSelection(); }
  if (mod && !typing) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); return redo(); }
    if (k === 's') { e.preventDefault(); return quickSavePose(); }
    if (k === 'e') { e.preventDefault(); return exportJson(); }
    if (k === 'c' && sel?.kind === 'bone' && !getSelection()?.toString()) { e.preventDefault(); return copyBoneValues(); }
    if (k === 'v' && sel?.kind === 'bone' && boneClip) { e.preventDefault(); return pasteBoneValues(); }
    return;
  }
  if (typing || e.altKey) return;
  if (document.activeElement?.closest?.('#tree') && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'enter', ' '].includes(k)) return;
  if (e.key === '/') { e.preventDefault(); return openPalette(); }
  if (k === 'h') return showModels();
  if (k === 'w' || k === 'g') setTool('move');            // G / R as in Blender
  else if (k === 'e' || k === 'r') setTool('rotate');
  else if (k === 's') setTool('select');
  else if (k === 'q') setSpace(space === 'local' ? 'world' : 'local');
  else if (k === 'x') setSnap(!snap);
  else if (k === 'f') frameSelection();
  else if (k === 'm') mirrorActive();
  else if (e.key === 'Tab' && document.activeElement === renderer.domElement || e.key === 'Tab' && document.activeElement === document.body) { e.preventDefault(); setActive(other(active)); }
});

// ═════════════════════════ refresh ═════════════════════════
function refreshUI() {
  refreshBoneUI(); refreshHandUI(); refreshObjUI(); applyDisplay(); refreshTree();
  ['R', 'L'].forEach(s => { const b = $('hand' + s), on = active === s; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('live').checked = live; $('limits').checked = limits;
  document.querySelector('.ptab[data-tab="bone"]').classList.toggle('na', !(sel?.kind === 'bone' || sel?.kind === 'ik'));
  Object.values(hands).forEach(h => Object.entries(h.markers).forEach(([b, m]) => {
    const on = h.side === active && sel?.kind === 'bone' && +b === sel.b;
    m.scale.setScalar(on ? 1.7 : 1); m.material.color.set(on ? 0xffffff : FINGER_COL[fingerOf(+b) || 'palm']);
  }));
  Object.values(hands).forEach(h => Object.entries(h.ik).forEach(([f, m]) => { m.material.opacity = h.side === active && sel?.kind === 'ik' && sel.finger === f ? 0.9 : 0.55; }));
  status(); paintRanges();
}
function refreshModelChrome() {
  const m = models[currentId], name = m?.name || '—', thumb = m?.thumb ? `url("${m.thumb}")` : '';
  $('modelsBtnName').textContent = m?.name || 'Model';
  $('modelsBtnPoses').textContent = m?.poses.length ? `${m.poses.length} pose${m.poses.length > 1 ? 's' : ''}` : '';
  $('libModel').textContent = name; $('heroName').textContent = name; $('sbModel').textContent = name;
  $('modelsBtnThumb').style.backgroundImage = thumb; $('modelsBtnThumb').firstElementChild.style.display = thumb ? 'none' : '';
  $('heroThumb').style.backgroundImage = thumb;
  $('libCount').textContent = lib().length;
}

// ═════════════════════════ command palette (Ctrl+K) ═════════════════════════
function commands() {
  const C = [], add = (group, label, ic, run, key = '') => C.push({ group, label, icon: ic, run, key });
  add('Tools', 'Select tool', 'cursor', () => setTool('select'), 'S');
  add('Tools', 'Move tool', 'move', () => setTool('move'), 'W');
  add('Tools', 'Rotate tool', 'rotate', () => setTool('rotate'), 'E');
  add('Tools', `Gizmo space: switch to ${space === 'local' ? 'world' : 'local'}`, 'axis', () => setSpace(space === 'local' ? 'world' : 'local'), 'Q');
  add('Tools', `Snap: turn ${snap ? 'off' : 'on'}`, 'magnet', () => setSnap(!snap), 'X');
  add('Tools', 'Frame the selection', 'focus', frameSelection, 'F');
  add('Hands', `Edit the ${SIDE_NAME[other(active)]} hand`, 'hand', () => setActive(other(active)), 'Tab');
  add('Hands', `Mirror the ${SIDE_NAME[active]} hand onto the ${SIDE_NAME[other(active)]}`, 'flip', mirrorActive, 'M');
  add('Hands', 'Copy right → left', 'flip', () => $('copyRL').click());
  add('Hands', 'Copy left → right', 'flip', () => $('copyLR').click());
  add('Hands', 'Swap hands', 'swap', swapHands);
  add('Hands', `Live mirror: turn ${live ? 'off' : 'on'}`, 'flip', () => $('live').click());
  add('Hands', 'Auto-grip the object', 'spark', () => gripFingers(['middle', 'index', 'thumb']));
  add('Hands', 'Reset hand', 'refresh', resetHand);
  add('Hands', `Joint limits: turn ${limits ? 'off' : 'on'}`, 'bone', () => $('limits').click());
  Object.keys(PRESETS).forEach(n => add('Presets', 'Pose preset: ' + n, 'hand', () => applyPreset(n)));
  lib().forEach(p => add('Saved poses', 'Load pose: ' + p.name, 'save', () => { applyLibPose(p); changed({ commitNow: true }); toast('Loaded ' + p.name, false, { undo: true }); }));
  add('Saved poses', 'Save the current pose', 'save', quickSavePose, 'Ctrl S');
  Object.values(models).sort((a, b) => b.used - a.used).forEach(m => { if (m.id !== currentId) add('Models', 'Open model: ' + m.name, 'box', () => pickModel(m.id)); });
  add('Models', 'Import a model…', 'upload', () => openImport(), 'Ctrl O');
  add('Models', 'Model library', 'layers', showModels, 'H');
  add('Panels', 'Bone properties', 'bone', () => showTab('bone'));
  add('Panels', 'Hand properties', 'hand', () => showTab('hand'));
  add('Panels', 'Object placement', 'box', () => showTab('object'));
  add('Panels', 'Materials & textures', 'image', () => showTab('material'));
  add('Panels', 'Poses & export', 'download', () => showTab('export'));
  CAM_VIEWS.forEach(([v, n, sc]) => add('Camera', 'View: ' + n, 'camera', () => view(v), sc));
  add('Export', 'Export pose JSON', 'download', exportJson, 'Ctrl E');
  add('Export', 'Load a pose JSON…', 'upload', () => $('jsonFile').click());
  add('Export', 'Copy Unity text', 'copy', copyUnity);
  add('Export', 'Save a screenshot', 'camera', screenshot);
  overlayItems().forEach(it => add('Viewport', `${it.label}: turn ${it.check ? 'off' : 'on'}`, 'eye', it.run));
  add('App', 'Settings', 'gear', () => openSettings(), 'Ctrl ,');
  add('App', 'Accessibility settings', 'access', () => openSettings('access'));
  add('App', 'Check for updates', 'refresh', () => openSettings('updates'));
  return C;
}
let palItems = [], palIdx = 0, palReturn = null;
function openPalette() { closeModels(); closeMenu(); palReturn = document.activeElement; $('palette').hidden = false; $('palInput').value = ''; palIdx = 0; renderPalette(); setTimeout(() => $('palInput').focus(), 0); }
function closePalette() { if ($('palette').hidden) return; $('palette').hidden = true; palReturn?.focus?.(); }
function renderPalette() {
  const q = $('palInput').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  palItems = commands().filter(c => q.every(w => (c.label + ' ' + c.group).toLowerCase().includes(w)));
  palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1));
  const list = $('palList'); list.innerHTML = '';
  if (!palItems.length) { list.innerHTML = '<div class="none">No matching actions</div>'; return; }
  let group = null;
  palItems.forEach((c, i) => {
    if (c.group !== group) { group = c.group; const g = document.createElement('div'); g.className = 'grp'; g.textContent = group; list.appendChild(g); }
    const it = document.createElement('div'); it.className = 'it' + (i === palIdx ? ' on' : ''); it.setAttribute('role', 'option'); it.setAttribute('aria-selected', i === palIdx);
    it.innerHTML = icon(c.icon) + `<span>${esc(c.label)}</span>` + (c.key ? `<span class="kbd k">${esc(c.key)}</span>` : '');
    it.onmousemove = () => { if (palIdx !== i) { palIdx = i; list.querySelectorAll('.it').forEach((x, j) => x.classList.toggle('on', j === i)); } };
    it.onclick = () => runPalette(i);
    list.appendChild(it);
  });
  list.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) { const c = palItems[i]; if (!c) return; palReturn = null; closePalette(); c.run(); }
$('palInput').oninput = () => { palIdx = 0; renderPalette(); };
$('palInput').onkeydown = e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = (palIdx + 1) % Math.max(1, palItems.length); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = (palIdx - 1 + palItems.length) % Math.max(1, palItems.length); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palIdx); }
};
$('palette').onclick = e => { if (e.target === $('palette')) closePalette(); };

// ═════════════════════════ start ═════════════════════════
function resize() {
  const r = $('view').getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('view')); resize();
// the page itself never scrolls (it has no scrollable content); if anything nudges it, put it back
addEventListener('scroll', () => { if (document.scrollingElement.scrollTop || document.scrollingElement.scrollLeft) document.scrollingElement.scrollTo(0, 0); }, true);

const bootT = performance.now();
$('splashBar').style.width = '35%';
const saved = store.loadState();
if (saved) {
  Object.assign(prefs, saved.prefs || {});
  prefs.show = Object.assign({ R: true, L: true }, (saved.prefs || {}).show);
  active = saved.active || 'R'; live = !!saved.live; limits = saved.limits !== false;
  tool = saved.tool || 'move'; setSnap(!!saved.snap);
  models = saved.models || {};
  item.show = saved.showObject ?? saved.item?.show ?? true;
}
applyAccess();
ensureSamples();
setTool(tool);
expandTo(active);
camera.position.set(-0.26, 0.3, 0.58); orbit.target.set(0.02, 0.05, 0);
showTab('hand');
refreshItemUI(); refreshUI(); applyMouseMode(); updateUndoButtons();
if (window.desktop && prefs.uiScale && prefs.uiScale !== 1) window.desktop.setZoom(prefs.uiScale);

(async function start() {
  let want = saved?.currentId;
  if (saved && !saved.models) {                 // data from the first version: one pose, one pose list, one stored model
    const work = { R: saved.R, L: saved.L, hR: saved.hR, hL: saved.hL, item: saved.item };
    if (saved.item?.sample && SAMPLES[saved.item.sample]) want = SAMPLE_ID(saved.item.sample);
    else {
      const files = await store.getModel();
      if (files) {
        const main = files.find(f => /\.(glb|gltf|fbx|obj|dae|stl|ply|3mf|3ds)$/i.test(f.name)) || files[0];
        want = 'm' + Date.now().toString(36);
        models[want] = { id: want, name: main.name.replace(/\.[^.]+$/, ''), kind: 'import', sig: sigOf(files), size: files.reduce((a, f) => a + f.data.byteLength, 0), created: Date.now(), used: Date.now(), thumb: null, work: null, poses: [] };
        if (await store.putFiles(want, files)) store.clearModel(); else { delete models[want]; want = null; }
      }
    }
    if (want && models[want]) { models[want].work = work; models[want].poses = saved.library || []; }
  }
  $('splashBar').style.width = '70%';
  if (!(want && models[want] && await openModel(want, { quiet: true }))) await openModel(SAMPLE_ID('bottle'), { quiet: true });
  $('splashBar').style.width = '100%';
  if (prefs.homeOnStart !== false) showModels();
  const wait = Math.max(0, (reduceMotion() ? 300 : 1500) - (performance.now() - bootT));
  setTimeout(() => $('splash').classList.add('out'), wait);
})();

const tipTmp = new THREE.Vector3(), rq = new THREE.Quaternion();
(function frame() {
  requestAnimationFrame(frame);
  if (tween) {
    const t = Math.min(1, (performance.now() - tween.start) / 350), k = t * t * (3 - 2 * t);
    camera.position.lerpVectors(tween.p0, tween.p1, k); orbit.target.lerpVectors(tween.t0, tween.t1, k);
    if (t >= 1) tween = null;
  }
  orbit.update();
  Object.values(hands).forEach(h => Object.entries(h.ik).forEach(([f, m]) => {
    if (dragging && sel?.kind === 'ik' && sel.finger === f && h === H()) return;   // the dragged ring stays under the cursor
    m.position.copy(h.tipHand(f, tipTmp));
  }));
  Object.values(hands).forEach(h => { h.root.getWorldQuaternion(rq).invert(); Object.values(h.ik).forEach(m => m.userData.ring.quaternion.copy(camera.quaternion).premultiply(rq)); });
  updateAxes();
  renderer.render(scene, camera);
})();

// for debugging / automation
window.handPoser = { hands, importJsonFile, select, setActive, mirrorTo, exportData, applyPreset, view, gripFingers, solveFinger, FINGERS, THREE, camera, orbit, changed, setTool, openModel, showModels, showTab, get models() { return models; }, get currentId() { return currentId; } };
