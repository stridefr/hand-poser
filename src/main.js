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
const FINGER_COL = { thumb: 0xff7a59, index: 0x46c2ff, middle: 0xb98cff, palm: 0xffd166 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 2) => +(+v).toFixed(d);

// ───────── scene ─────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('view').appendChild(renderer.domElement);
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
orbit.zoomToCursor = true;                                      // wheel zooms towards what's under the mouse, like Blender

// ───────── mouse navigation ─────────
// Blender style (default): middle-drag orbits, Shift+middle pans, Ctrl+middle zooms, wheel zooms; left click selects.
// Alt+left-drag stands in for the middle button (laptops / trackpads). Classic: left orbits, right pans, middle zooms.
const NAV_HINT = {
  blender: '<span><b>Middle-drag</b> orbit</span><span><b>Shift</b> pan</span><span><b>Ctrl</b> / <b>wheel</b> zoom</span><span><b>Alt+left</b> = middle</span>',
  classic: '<span><b>Drag</b> orbit</span><span><b>Right-drag</b> pan</span><span><b>Wheel</b> zoom</span>',
};
const navMode = () => (prefs.mouse === 'classic' ? 'classic' : 'blender');
function applyMouseMode() {
  orbit.mouseButtons = navMode() === 'blender'
    ? { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  $('hint').innerHTML = NAV_HINT[navMode()];
}
// decide what a Blender-style drag does from its modifier keys, before OrbitControls sees the press
// (OrbitControls itself turns Shift + ROTATE into a pan)
renderer.domElement.addEventListener('pointerdown', e => {
  if (navMode() !== 'blender' || e.pointerType !== 'mouse') return;
  const action = e.ctrlKey || e.metaKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
  orbit.mouseButtons.MIDDLE = action;
  orbit.mouseButtons.LEFT = e.button === 0 && e.altKey ? action : null;
}, { capture: true });
// no browser auto-scroll / paste on middle click over the viewport
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
renderer.domElement.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
const grid = new THREE.GridHelper(1, 40, 0x2a3242, 0x1a2030); grid.position.y = -0.36; scene.add(grid);

// ───────── hands ─────────
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

// joint handles + fingertip IK handles (drawn on top of everything)
const markerGeo = new THREE.SphereGeometry(0.0042, 14, 10);
const ikGeo = new THREE.SphereGeometry(0.0068, 18, 12);
const onTop = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
Object.values(hands).forEach(h => {
  h.markers = {};
  POSABLE.forEach(b => {
    const f = fingerOf(b) || 'palm';
    const m = new THREE.Mesh(markerGeo, onTop(FINGER_COL[f]));
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

// ───────── the held object ─────────
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
  $('dims').textContent = `Held size: ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} cm`;
  $('objName').textContent = item.name ? 'Holding: ' + item.name : '';
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

// ───────── state ─────────
let active = 'R';
let tool = 'move';
let sel = null;            // { kind: 'bone', b } | { kind: 'object' } | { kind: 'ik', finger }
let live = false, limits = true, snap = false;
// model library: every model keeps its own working pose, size settings and saved poses
let models = {};           // id -> { id, name, kind: 'sample'|'import', sample, sig, size, created, used, thumb, work, poses }
let currentId = null;
const lib = () => models[currentId]?.poses || [];
const prefs = { showJoints: true, showIK: true, xray: false, grid: true, fur: '#a8243a', furTex: true, show: { R: true, L: true } };
const H = () => hands[active];

// ───────── mirror / copy ─────────
function mirrorTo(dst) {
  const src = other(dst);
  hands[dst].setPose(hands[src].getPose());                  // same numbers = exact mirror (see rig.js)
  const c = canonHold(src); setCanonHold(dst, c.p, c.q);
}
function changed({ commitNow = false, all = false } = {}) {
  if (live) mirrorTo(other(active));
  Object.values(hands).forEach(h => h.root.updateMatrixWorld(true));
  refreshUI(all);
  scheduleSave();
  if (commitNow) commit();
}

// ───────── undo ─────────
const undoStack = [], redoStack = [];
function snapshot() {
  return JSON.stringify({ R: hands.R.getPose(), L: hands.L.getPose(), hR: holdOf('R'), hL: holdOf('L') });
}
const holdOf = s => ({ p: hands[s].holder.position.toArray().map(v => round(v, 6)), q: hands[s].holder.quaternion.toArray().map(v => round(v, 6)) });
function setHold(s, o) { if (!o) return; hands[s].holder.position.fromArray(o.p); hands[s].holder.quaternion.fromArray(o.q).normalize(); }
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
  refreshUI(true); scheduleSave();
}
function undo() { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); restore(undoStack[undoStack.length - 1]); updateUndoButtons(); }
function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); restore(s); updateUndoButtons(); }
function updateUndoButtons() { $('undo').disabled = undoStack.length < 2; $('redo').disabled = !redoStack.length; }

// ───────── persistence ─────────
let saveTimer = 0;
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

// ───────── gizmo + selection ─────────
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.7);
scene.add(gizmo.getHelper());
let dragging = false, dragTarget = new THREE.Vector3();
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
    const tip = h.tipHand(sel.finger);
    h.ikLine.geometry.setFromPoints([tip, t.position.clone()]); h.ikLine.visible = true;
  }
  changed();
});

function clampBone(h, b) { const L = limitsFor(b); h.pose[b] = h.pose[b].map((v, k) => clamp(v, L[k][0], L[k][1])); }

function select(s) {
  sel = s;
  if (s?.kind === 'object') showTab('object'); else if (s) showTab('pose');
  attachGizmo();
  refreshUI(true);
}
function attachGizmo() {
  const h = H();
  gizmo.detach();
  if (!sel) return;
  if (sel.kind === 'bone') {
    if (tool === 'select') return;
    gizmo.setMode('rotate'); gizmo.setSpace('local'); gizmo.attach(h.bones[sel.b]);
  } else if (sel.kind === 'ik') {
    gizmo.setMode('translate'); gizmo.setSpace('world'); gizmo.attach(h.ik[sel.finger]);
  } else if (sel.kind === 'object') {
    if (tool === 'select' || !item.show) return;
    gizmo.setMode(tool === 'rotate' ? 'rotate' : 'translate'); gizmo.setSpace(space); gizmo.attach(h.holder);
  }
}
let space = 'local';
function setTool(t) {
  tool = t;
  ['Select', 'Move', 'Rotate'].forEach(n => $('tool' + n).classList.toggle('on', t === n.toLowerCase()));
  attachGizmo(); scheduleSave();
}
function setSpace(s) { space = s; $('spaceLbl').textContent = s === 'local' ? 'Local' : 'World'; $('space').classList.toggle('on', s === 'world'); if (sel?.kind === 'object') gizmo.setSpace(s); }
function setSnap(on) {
  snap = on; $('snap').classList.toggle('on', on);
  gizmo.setRotationSnap(on ? 5 * DEG : null); gizmo.setTranslationSnap(on ? 0.0025 : null);
}
function setActive(s) {
  if (s === active) return;
  active = s;
  if (sel?.kind === 'bone' || sel?.kind === 'ik' || sel?.kind === 'object') attachGizmo();
  $('handR').classList.toggle('on', s === 'R'); $('handL').classList.toggle('on', s === 'L');
  if (!prefs.show[s]) { prefs.show[s] = true; applyDisplay(); }
  refreshUI(true); scheduleSave();
}

// picking
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null, gizmoHot = false;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; gizmoHot = gizmo.axis !== null; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || gizmoHot || dragging) { downAt = null; return; }
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]); downAt = null;
  if (moved > 5 || e.button !== 0 || (e.altKey && navMode() === 'blender')) return;
  pick(e);
});
renderer.domElement.addEventListener('pointermove', e => {
  if (dragging || e.buttons) return;
  const hit = pickHandles(e);
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
  status(hit ? (hit.object.userData.pick === 'ik' ? `Drag to pose the ${FINGERS[hit.object.userData.finger].label.toLowerCase()} with IK` : `Select ${NICE[hit.object.userData.b]}`) : null);
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
function pick(e) {
  const hh = pickHandles(e);
  if (hh) {
    const u = hh.object.userData;
    return select(u.pick === 'ik' ? { kind: 'ik', finger: u.finger } : { kind: 'bone', b: u.b });
  }
  const list = [];
  for (const s of ['R', 'L']) {
    if (!hands[s].root.visible) continue;                     // a hidden hand (and what it holds) can't be clicked
    hands[s].mesh.computeBoundingSphere(); hands[s].mesh.computeBoundingBox();
    list.push(hands[s].mesh, ...objectMeshes(s));
  }
  const hit = ray.intersectObjects(list, false)[0];
  if (!hit) return select(null);
  let o = hit.object, side = null;
  for (let p = o; p; p = p.parent) { if (p === hands.R.root) side = 'R'; if (p === hands.L.root) side = 'L'; }
  if (side) setActive(side);
  if (o.isSkinnedMesh && o.userData.hand) {
    const g = o.geometry, w = {};
    [hit.face.a, hit.face.b, hit.face.c].forEach(v => {
      for (let k = 0; k < 4; k++) { const b = g.attributes.skinIndex.getComponent(v, k), x = g.attributes.skinWeight.getComponent(v, k); w[b] = (w[b] || 0) + x; }
    });
    let b = +Object.keys(w).sort((a, c) => w[c] - w[a])[0];
    if (!POSABLE.includes(b)) b = POSABLE.includes(PARENT[b]) ? PARENT[b] : null;
    return select(b == null ? null : { kind: 'bone', b });
  }
  return select({ kind: 'object' });
}

// ───────── poses: presets & macros ─────────
// CURL_PROFILE (natural joint proportions) is shared with the IK solver
function fingerCurl(h, f) {
  const p = CURL_PROFILE[f];
  return FINGERS[f].bones.reduce((a, b, i) => a + h.pose[b][0] / p[i], 0) / 3;
}
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
  changed({ commitNow: true, all: true });
}

// ───────── UI ─────────
function status(t) {
  $('status').textContent = t || defaultStatus();
  $('sbHand').textContent = SIDE_NAME[active][0].toUpperCase() + SIDE_NAME[active].slice(1) + ' hand';
  const chip = $('selChip');
  chip.hidden = !sel;
  if (sel) {
    const col = sel.kind === 'object' ? 0xfafafa : FINGER_COL[sel.kind === 'ik' ? sel.finger : (fingerOf(sel.b) || 'palm')];
    chip.querySelector('.d').style.background = '#' + col.toString(16).padStart(6, '0');
    $('selText').innerHTML = '';
    const what = sel.kind === 'bone' ? NICE[sel.b] : sel.kind === 'ik' ? FINGERS[sel.finger].label + ' IK target' : 'Held object';
    const side = document.createElement('span'); side.className = 'side'; side.textContent = SIDE_NAME[active] + ' hand  ›  ';
    $('selText').append(side, what);
  }
}
function defaultStatus() {
  if (!sel) return `Editing the ${SIDE_NAME[active]} hand · click a joint, fingertip, finger or the object`;
  if (sel.kind === 'bone') return `${NICE[sel.b]} (${SIDE_NAME[active]}) · ${tool === 'select' ? 'use the sliders' : 'drag the rings to rotate'}`;
  if (sel.kind === 'ik') return `${FINGERS[sel.finger].label} IK (${SIDE_NAME[active]}) · drag the arrows, the finger follows`;
  return `Object (${SIDE_NAME[active]} hand) · ${tool === 'select' ? 'use the sliders' : tool}`;
}
let toastTimer = 0;
function toast(t, err = false) {
  const el = $('toast'); $('toastText').textContent = t; el.classList.toggle('err', err); el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), err ? 4200 : 2000);
}

// bone picker grid
const PICK_ORDER = [3, 4, 5, 7, 8, 9, 11, 12, 13, 1, 2];
PICK_ORDER.forEach(b => {
  const btn = document.createElement('button');
  btn.textContent = NICE[b].replace('Palm (index)', 'Palm idx').replace('Palm (middle)', 'Palm mid');
  btn.dataset.b = b; btn.onclick = () => select({ kind: 'bone', b });
  btn.style.setProperty('--c', '#' + FINGER_COL[fingerOf(b) || 'palm'].toString(16).padStart(6, '0'));
  $('bonePick').appendChild(btn);
});

function refreshBoneUI() {
  const h = H(), b = sel?.kind === 'bone' ? sel.b : null;
  $('boneTitle').textContent = b == null ? 'Nothing selected' : `${NICE[b]} · ${SIDE_NAME[active]} hand`;
  document.querySelectorAll('#bonePick button').forEach(x => x.classList.toggle('on', +x.dataset.b === b));
  const L = b == null ? null : limitsFor(b);
  for (let k = 0; k < 3; k++) {
    const r = $('b' + k), n = $('b' + k + 'n');
    r.disabled = n.disabled = b == null;
    r.min = L && limits ? L[k][0] : -180; r.max = L && limits ? L[k][1] : 180;
    const v = b == null ? 0 : h.pose[b][k];
    r.value = v; if (document.activeElement !== n) n.value = round(v, 1);
  }
  document.querySelectorAll('[data-bn]').forEach(x => x.disabled = b == null);
  $('boneReset').disabled = b == null;
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
$('boneReset').onclick = () => { if (sel?.kind !== 'bone') return; H().pose[sel.b] = [0, 0, 0]; H().applyBone(sel.b); changed({ commitNow: true }); };

// finger rows
const fingerUI = {};
Object.entries(FINGERS).forEach(([f, F]) => {
  const wrap = document.createElement('div');
  const col = '#' + FINGER_COL[f].toString(16).padStart(6, '0');
  wrap.className = 'finger';
  wrap.innerHTML = `
    <div class="fingerhead"><span class="name"><span class="dot" style="background:${col};color:${col}"></span>${F.label}</span>
      <button class="btn" data-a="ik" title="Select the fingertip IK handle">IK</button>
      <button class="btn" data-a="grip" title="Close this finger onto the object">Grip</button>
      <button class="btn" data-a="reset" title="Straighten">Reset</button></div>
    <div class="ctl"><span class="lbl">Curl</span><input type="range" min="-0.3" max="1.15" step="0.01" data-a="curl" style="--fill:${col}"></div>
    <div class="ctl"><span class="lbl">Spread</span><input type="range" step="0.5" data-a="spread" style="--fill:${col}"></div>`;
  $('fingers').appendChild(wrap);
  const q = a => wrap.querySelector(`[data-a="${a}"]`);
  fingerUI[f] = { curl: q('curl'), spread: q('spread') };
  q('curl').oninput = e => { setFingerCurl(H(), f, +e.target.value); changed(); };
  q('curl').onchange = () => commit();
  q('spread').oninput = e => { const h = H(), b = F.bones[0]; h.pose[b][1] = +e.target.value; if (limits) clampBone(h, b); h.applyBone(b); changed(); };
  q('spread').onchange = () => commit();
  q('reset').onclick = () => { const h = H(); F.bones.forEach(b => h.pose[b] = [0, 0, 0]); h.applyAll(); changed({ commitNow: true }); };
  q('grip').onclick = () => gripFingers([f]);
  q('ik').onclick = () => select({ kind: 'ik', finger: f });
});
function refreshFingerUI() {
  const h = H();
  Object.keys(FINGERS).forEach(f => {
    const b = FINGERS[f].bones[0], L = limitsFor(b);
    fingerUI[f].curl.value = fingerCurl(h, f);
    fingerUI[f].spread.min = limits ? L[1][0] : -90; fingerUI[f].spread.max = limits ? L[1][1] : 90;
    fingerUI[f].spread.value = h.pose[b][1];
  });
  $('gripAll').value = (fingerCurl(h, 'index') + fingerCurl(h, 'middle')) / 2;
}
$('gripAll').oninput = e => { const h = H(); Object.keys(FINGERS).forEach(f => setFingerCurl(h, f, +e.target.value)); changed(); };
$('gripAll').onchange = () => commit();
function gripFingers(list) {
  const h = H(), meshes = objectMeshes(active);
  if (!meshes.length || !item.show) return toast('No object to grip', true);
  h.root.updateMatrixWorld(true);
  let n = 0;
  list.forEach(f => { if (autoGrip(h, f, meshes, { limits })) n++; });
  changed({ commitNow: true });
  if (!n) toast('The fingers closed without touching the object. Move it into the palm first.', true);
  else toast(`Gripped with ${n} finger${n > 1 ? 's' : ''}`);
}
$('gripAuto').onclick = () => gripFingers(['middle', 'index', 'thumb']);
$('handReset').onclick = () => { H().setPose(null); changed({ commitNow: true }); };
$('relax').onclick = () => applyPreset('Relaxed');
const PRESET_ICON = { Open: '🖐', Relaxed: '🤚', Fist: '✊', Grip: '🫳', Trigger: '🔫', Point: '☝', Pinch: '🤏', 'Thumb up': '👍', Spread: '✋' };
Object.keys(PRESETS).forEach(n => {
  const b = document.createElement('button'); const ic = document.createElement('span'); ic.textContent = PRESET_ICON[n] || '•';
  b.append(ic, n); b.onclick = () => applyPreset(n); $('presets').appendChild(b);
});

// object transform UI (canonical values, hand space: X+ out of the palm, Y+ towards the fingertips, Z+ towards the thumb)
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
for (let k = 0; k < 3; k++) {
  for (const t of ['p', 'r']) {
    $(t + k).oninput = () => setObjFromUI(false);
    $(t + k).onchange = () => commit();
    $(t + k + 'n').onchange = e => { $(t + k).value = e.target.value; setObjFromUI(true); };
  }
}
document.querySelectorAll('[data-nudge]').forEach(btn => btn.onclick = () => {
  const [t, k, s] = [btn.dataset.nudge[0], +btn.dataset.nudge[1], btn.dataset.nudge[2] === '+' ? 1 : -1];
  const c = canonHold(active);
  if (t === 'p') {
    const d = toDisp(c.p); d[k] += s * +$('moveStep').value; c.p = fromDisp(d);
  } else {
    const ax = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
    c.q.multiply(new THREE.Quaternion().setFromAxisAngle(ax, s * +$('rotStep').value * DEG));   // about the object's own axis
  }
  setCanonHold(active, c.p, c.q); changed({ commitNow: true });
});
$('objReset').onclick = () => { setCanonHold(active, new THREE.Vector3(...DEFAULT_HOLD.p), new THREE.Quaternion(...DEFAULT_HOLD.q)); changed({ commitNow: true }); };
$('objSelect').onclick = () => { if (tool === 'select') setTool('move'); select({ kind: 'object' }); };
$('objShow').onchange = e => { item.show = e.target.checked; Object.values(hands).forEach(h => h.holder.visible = item.show); if (sel?.kind === 'object') attachGizmo(); scheduleSave(); };
$('mirrorGeo').onchange = e => { item.mirrorGeo = e.target.checked; rebuildItem(); scheduleSave(); };

// size / units
function refreshItemUI() {
  $('units').value = item.units; $('fitRow').style.display = item.units === 'fit' ? '' : 'none';
  $('fitSize').value = item.fit; $('fitSizeN').value = item.fit;
  $('scale').value = item.scale; $('scaleN').value = item.scale;
  $('pivot').value = item.pivot; $('mirrorGeo').checked = item.mirrorGeo; $('objShow').checked = item.show;
}
$('units').onchange = e => { item.units = e.target.value; refreshItemUI(); rebuildItem(); scheduleSave(); };
$('fitSize').oninput = e => { item.fit = +e.target.value; $('fitSizeN').value = item.fit; rebuildItem(); scheduleSave(); };
$('fitSizeN').onchange = e => { item.fit = clamp(+e.target.value || 15, 0.5, 500); refreshItemUI(); rebuildItem(); scheduleSave(); };
$('scale').oninput = e => { item.scale = +e.target.value; $('scaleN').value = item.scale; rebuildItem(); scheduleSave(); };
$('scaleN').onchange = e => { item.scale = clamp(+e.target.value || 1, 0.001, 1000); refreshItemUI(); rebuildItem(); scheduleSave(); };
$('pivot').onchange = e => { item.pivot = e.target.value; rebuildItem(); scheduleSave(); };

// ───────── model library ─────────
const SAMPLE_ID = k => 'sample:' + k;
function ensureSamples() {
  Object.entries(SAMPLES).forEach(([k, smp]) => {
    const id = SAMPLE_ID(k);
    if (!models[id]) models[id] = { id, name: smp.label, kind: 'sample', sample: k, created: 0, used: 0, thumb: null, work: null, poses: [] };
  });
}
const defaultItem = kind => ({ units: kind === 'sample' ? 'm' : 'fit', fit: 15, scale: 1, pivot: 'center', mirrorGeo: false });
function startingPose() {                        // a model opened for the first time: relaxed hand closed onto it, mirrored
  setHold('R', DEFAULT_HOLD);
  hands.R.setPose(PRESETS.Relaxed); hands.R.root.updateMatrixWorld(true);
  const meshes = objectMeshes('R');
  if (meshes.length && prefs.autoGripNew !== false) ['middle', 'index', 'thumb'].forEach(f => autoGrip(hands.R, f, meshes, { limits }));
  mirrorTo('L');
}
function applyLibPose(p) { hands.R.setPose(p.R); hands.L.setPose(p.L); setHold('R', p.hR); setHold('L', p.hL); }
function stashCurrent() {
  const m = models[currentId]; if (!m) return;
  m.work = workState(); m.thumb = captureThumb() || m.thumb;
}
// a small preview of the middle of the viewport (handles, gizmo and grid hidden)
const furReady = () => furImg.complete && furImg.naturalWidth > 0 && furTex.version > 0;   // decoded and handed to three.js
function captureThumb() {
  if (!furReady()) return null;                 // the hand would come out black
  try {
    const hidden = [];
    scene.traverse(o => { if ((o.userData.pick || o === gizmo.getHelper() || o === grid || o.isLine) && o.visible) { hidden.push(o); o.visible = false; } });
    renderer.render(scene, camera);
    const src = renderer.domElement, W = src.width, Hh = src.height;
    const sw = Math.min(W * 0.8, Hh * 1.6), sh = sw / 1.6;
    const c = document.createElement('canvas'); c.width = 320; c.height = 200;
    const g = c.getContext('2d'), bg = g.createRadialGradient(160, 40, 10, 160, 100, 220);
    bg.addColorStop(0, '#1d1a2c'); bg.addColorStop(1, '#0b0b0e'); g.fillStyle = bg; g.fillRect(0, 0, 320, 200);
    g.drawImage(src, (W - sw) / 2, (Hh - sh) / 2, sw, sh, 0, 0, 320, 200);
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
    if (!quiet) toast('Opening ' + m.name + '…');
    const files = await store.getFiles(id);
    if (!files) { toast(`The files for "${m.name}" aren't stored in this browser any more. Import it again.`, true); return false; }
    try { const res = await loadModelFiles(files); obj = res.object; missing = res.missing; }
    catch (err) { console.error(err); toast('Could not load ' + m.name + ': ' + (err.message || err), true); return false; }
  }
  if (ticket !== opening) return false;                       // another model was picked meanwhile
  if (currentId && currentId !== id && models[currentId]) stashCurrent();
  currentId = id; m.used = Date.now();
  Object.assign(item, defaultItem(m.kind), m.initItem || {}, m.work?.item || {});
  item.sample = m.kind === 'sample' ? m.sample : null;
  setTemplate(obj, m.name);
  if (m.work) { hands.R.setPose(m.work.R); hands.L.setPose(m.work.L); setHold('R', m.work.hR); setHold('L', m.work.hL); }
  else startingPose();
  if (pose) applyLibPose(pose);
  Object.values(hands).forEach(h => h.root.updateMatrixWorld(true));
  sel = null; attachGizmo();
  undoStack.length = 0; redoStack.length = 0;                 // undo history is per model
  refreshItemUI(); refreshLib(); refreshUI(); commit(); saveNow();
  if (!quiet) toast('Opened ' + m.name + (pose ? ' · ' + pose.name : ''));
  const firstThumb = (tries = 0) => setTimeout(() => {
    if (currentId !== id || (m.thumb && !m.thumbIsObject)) return;
    const t = captureThumb();
    if (t) { m.thumb = t; delete m.thumbIsObject; refreshModelChrome(); saveNow(); if (!$('models').hidden) renderModels(); } else if (tries < 10) firstThumb(tries + 1);
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
    if (imgs.length && (!quiet || m.missing.length !== before)) toast(`${imgs.length} texture${imgs.length > 1 ? 's' : ''} missing. Add ${imgs.length > 1 ? 'them' : 'it'} in the Materials tab`, true);
  }, 2000);
  setTimeout(() => { if (currentId === id) renderMaterials(); }, 3500);   // thumbnails once images have decoded
  if (!$('models').hidden) renderModels();
  return true;
}
async function deleteModel(id) {
  const m = models[id]; if (!m || m.kind !== 'import') return;
  if (!confirm(`Delete "${m.name}" and its ${m.poses.length} saved pose${m.poses.length === 1 ? '' : 's'}? This can't be undone.`)) return;
  delete models[id]; store.deleteFiles(id); store.deleteImages(id);
  if (id === currentId) {
    currentId = null;
    const next = Object.values(models).filter(x => x.kind === 'import').sort((a, b) => b.used - a.used)[0];
    if (!next || !(await openModel(next.id, { quiet: true }))) await openModel(SAMPLE_ID('bottle'), { quiet: true });
  }
  saveNow(); renderModels(); toast('Deleted ' + m.name);
}
function renameModel(id) {
  const m = models[id], n = prompt('Rename model', m.name);
  if (!n || !n.trim()) return;
  m.name = n.trim();
  if (id === currentId) { item.name = m.name; rebuildItem(); refreshLib(); }
  saveNow(); renderModels();
}
const ago = t => { const x = (Date.now() - t) / 1000; return x < 60 ? 'just now' : x < 3600 ? Math.round(x / 60) + ' min ago' : x < 86400 ? Math.round(x / 3600) + ' h ago' : Math.round(x / 86400) + ' d ago'; };
const fmtSize = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
function modelCard(m) {
  const el = document.createElement('div'); el.className = 'card' + (m.id === currentId ? ' cur' : '');
  const th = document.createElement('div'); th.className = 'thumb'; th.title = 'Open ' + m.name;
  if (m.thumb) th.style.backgroundImage = `url("${m.thumb}")`; else th.textContent = 'No preview yet';
  if (m.id === currentId) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'OPEN NOW'; th.appendChild(b); }
  th.onclick = () => pickModel(m.id);
  const body = document.createElement('div'); body.className = 'body';
  const name = document.createElement('div'); name.className = 'name'; name.textContent = m.name; name.title = m.name; name.onclick = () => pickModel(m.id);
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = `${m.poses.length} saved pose${m.poses.length === 1 ? '' : 's'}` + (m.kind === 'import' ? ' · ' + fmtSize(m.size || 0) : '') + ' · ' + (m.used ? 'used ' + ago(m.used) : 'not opened yet');
  body.append(name, meta);
  if (m.poses.length) {
    const chips = document.createElement('div'); chips.className = 'chips';
    m.poses.forEach(p => {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = p.name;
      c.title = `Open ${m.name} in the "${p.name}" pose`; c.onclick = () => pickModel(m.id, p); chips.appendChild(c);
    });
    body.appendChild(chips);
  }
  const acts = document.createElement('div'); acts.className = 'acts';
  const open = document.createElement('button'); open.textContent = m.id === currentId ? 'Back to it' : 'Open'; open.onclick = () => pickModel(m.id);
  acts.appendChild(open);
  if (m.kind === 'import') {
    const rn = document.createElement('button'); rn.textContent = 'Rename'; rn.onclick = () => renameModel(m.id);
    const del = document.createElement('button'); del.textContent = 'Delete'; del.onclick = () => deleteModel(m.id);
    acts.append(rn, del);
  }
  body.appendChild(acts); el.append(th, body);
  return el;
}
function renderModels() {
  const imp = Object.values(models).filter(m => m.kind === 'import').sort((a, b) => b.used - a.used);
  $('mImpCount').textContent = imp.length; refreshModelChrome();
  $('mImported').innerHTML = '';
  if (!imp.length) $('mImported').innerHTML = '<div class="empty">No imported models yet. Import an FBX, OBJ, glTF… and it is kept here with its own poses.</div>';
  imp.forEach(m => $('mImported').appendChild(modelCard(m)));
  $('mBuiltin').innerHTML = '';
  Object.keys(SAMPLES).forEach(k => {
    const m = models[SAMPLE_ID(k)];
    if (!m.thumb && k !== 'none') { m.thumb = objectThumb(SAMPLES[k].make()); m.thumbIsObject = true; }
    $('mBuiltin').appendChild(modelCard(m));
  });
}
async function pickModel(id, pose = null) {
  closeModels();
  if (id === currentId) { if (pose) { applyLibPose(pose); changed({ commitNow: true, all: true }); toast('Loaded ' + pose.name); } return; }
  await openModel(id, { pose });
}
function showModels() {
  if (models[currentId]) { models[currentId].thumb = captureThumb() || models[currentId].thumb; saveNow(); }
  renderModels(); $('models').hidden = false;
}
function closeModels() { $('models').hidden = true; }
$('modelsBtn').onclick = () => ($('models').hidden ? showModels() : closeModels());
$('homeBtn').onclick = () => ($('models').hidden ? showModels() : closeModels());
$('openModels').onclick = showModels;
$('mClose').onclick = closeModels;

// ───────── materials & textures ─────────
// Textures the user adds are stored per model (images in IndexedDB, assignments in models[id].tex) and re-applied
// every time the model opens. Files the model itself asked for but didn't get (missing textures) are instead added
// to the model's own files and the model is re-read, so the original loader puts them where they belong.
const SLOTS = [['map', 'Base colour'], ['normalMap', 'Normal'], ['roughnessMap', 'Roughness'], ['metalnessMap', 'Metalness'], ['emissiveMap', 'Emissive']];
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
// put one image file into a slot of one or more materials
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
  else toast(`${file.name} → ${SLOTS.find(s => s[0] === slot)[1].toLowerCase()}${keys.length > 1 ? ` on ${keys.length} materials` : ''}${ok ? '' : ' (not stored: this browser refused)'}`, !ok);
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
// "Add texture files…" / dropping images: link the ones the model was missing, place the rest by hand
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
const SLOT_HINT = { map: 'Surface colour', normalMap: 'Bumps and detail', roughnessMap: 'Shiny or matte', metalnessMap: 'Metal or not', emissiveMap: 'Glowing parts' };
function renderMaterials() {
  const m = models[currentId], list = $('mats'); if (!list) return;
  const mats = itemMaterials();
  $('matCount').textContent = mats.length;
  $('matModel').textContent = m?.name || 'this model';
  const miss = (m?.missing || []).filter(n => IMAGE_EXT.test(n));
  $('missingBox').hidden = !miss.length || m?.kind !== 'import';
  $('missingText').textContent = `${miss.length} texture${miss.length > 1 ? 's' : ''} the model asked for ${miss.length > 1 ? 'weren\'t' : 'wasn\'t'} found: ${miss.slice(0, 5).join(', ')}${miss.length > 5 ? '…' : ''}. Add ${miss.length > 1 ? 'them' : 'it'} and ${miss.length > 1 ? 'they\'re' : 'it\'s'} linked automatically.`;
  $('noUV').hidden = !mats.length || mats.some(e => e.hasUV);
  list.innerHTML = '';
  if (!mats.length) { list.innerHTML = '<p class="hint">This object has no materials.</p>'; return; }
  mats.forEach(e => {
    const mt = e.mat, o = m?.tex?.[e.key], open = openMatKey === e.key || mats.length <= 2;
    const row = document.createElement('div'); row.className = 'mat' + (open ? ' open' : '');
    const hd = document.createElement('div'); hd.className = 'mhd';
    const sw = document.createElement('span'); sw.className = 'sw';
    const th = texThumb(mt.map); if (th) sw.style.backgroundImage = `url("${th}")`; else if (mt.color) sw.style.background = hex(mt.color);
    const nm = document.createElement('span'); nm.className = 'mn'; nm.textContent = e.name; nm.title = e.name;
    const n = SLOTS.filter(([s]) => mt[s]).length;
    const meta = document.createElement('span'); meta.className = 'mmeta'; meta.textContent = (o ? 'edited · ' : '') + (n ? `${n} texture${n > 1 ? 's' : ''}` : 'no textures');
    hd.append(sw, nm, meta);
    hd.insertAdjacentHTML('beforeend', '<svg class="i sm chev"><use href="#i-chev"/></svg>');
    hd.onclick = () => { openMatKey = openMatKey === e.key ? null : e.key; renderMaterials(); };
    row.appendChild(hd);
    if (open) {
      const body = document.createElement('div'); body.className = 'mbody';
      if (mt.color) {
        const cr = document.createElement('div'); cr.className = 'slotrow';
        const ci = document.createElement('input'); ci.type = 'color'; ci.value = hex(mt.color); ci.style.margin = '0 5px';
        ci.oninput = () => { mt.color.set(ci.value); const mm = models[currentId]; mm.tex = mm.tex || {}; (mm.tex[e.key] = mm.tex[e.key] || {}).color = ci.value; if (!th) sw.style.background = ci.value; scheduleSave(); };
        ci.onchange = () => renderMaterials();
        const tx = document.createElement('div'); tx.className = 'tx'; tx.innerHTML = '<b>Colour</b><span>Tints the base colour texture</span>';
        cr.append(ci, tx);
        if (o) { const rb = document.createElement('button'); rb.className = 'btn sm ghost'; rb.textContent = 'Reset material'; rb.title = 'Back to the model\'s own material'; rb.onclick = () => resetMaterial(e.key); cr.appendChild(rb); }
        body.appendChild(cr);
      }
      SLOTS.filter(([s]) => s in mt).forEach(([s, label]) => {
        const t = mt[s], tt = texThumb(t);
        const r = document.createElement('div'); r.className = 'slotrow';
        const tile = document.createElement('button'); tile.className = 'tile' + (t ? ' full' : ''); tile.title = `Choose an image for ${label.toLowerCase()}`;
        if (tt) tile.style.backgroundImage = `url("${tt}")`; else tile.innerHTML = t ? 'map' : '<svg class="i sm"><use href="#i-plus"/></svg>';
        const pick = () => { slotTarget = { keys: [e.key], slot: s }; $('slotFile').click(); };
        tile.onclick = pick;
        const tx = document.createElement('div'); tx.className = 'tx';
        const b = document.createElement('b'); b.textContent = label;
        const sp = document.createElement('span'); sp.textContent = t ? (o?.names?.[s] || (o?.[s] ? 'Your image' : 'From the model')) : SLOT_HINT[s];
        tx.append(b, sp);
        const ch = document.createElement('button'); ch.className = 'btn sm'; ch.textContent = t ? 'Replace' : 'Choose…'; ch.onclick = pick;
        r.append(tile, tx, ch);
        if (t) { const x = document.createElement('button'); x.className = 'btn icon sm ghost'; x.title = 'Remove this texture'; x.innerHTML = '<svg class="i sm"><use href="#i-x"/></svg>'; x.onclick = () => clearSlot(e.key, s); r.appendChild(x); }
        r.ondragover = ev => { ev.preventDefault(); ev.stopPropagation(); r.classList.add('hot'); };
        r.ondragleave = () => r.classList.remove('hot');
        r.ondrop = ev => { ev.preventDefault(); ev.stopPropagation(); r.classList.remove('hot'); dragDepth = 0; $('drop').classList.remove('on'); const f = ev.dataTransfer?.files?.[0]; if (f) addImageTo([e.key], s, f); };
        body.appendChild(r);
      });
      if (!e.hasUV) body.insertAdjacentHTML('beforeend', '<p class="hint">This part has no UV coordinates: image textures won\'t show, the colour will.</p>');
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

$('file').accept = ACCEPT;
$('import').onclick = () => openImport();
$('file').onchange = e => { openImport([...e.target.files]); e.target.value = ''; };

// ───────── import window ─────────
// Files are staged and read straight away, so you see a live preview, which file is the model, which textures it
// found and which ones it is still missing, before anything is added to the library.
const extOf = n => (n.split('.').pop() || '').toLowerCase();
const mainOf = files => MODEL_EXTS.map(e => files.find(f => extOf(f.name) === e)).find(Boolean);
const fmtBytes = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
let staged = [], stagedRes = null, stagedMissing = [], stagedErr = null, parseTicket = 0;
let impR = null, impScene, impCam, impPivot, impRaf = 0;
function openImport(files) {
  closePalette(); $('importDlg').hidden = false;
  if (!staged.length) $('impUnits').value = prefs.importUnits || 'fit';
  if (files?.length) addStaged(files); else renderStaged();
}
function closeImport() {
  $('importDlg').hidden = true; cancelAnimationFrame(impRaf);
  parseTicket++; staged = []; stagedRes = null; stagedMissing = []; stagedErr = null;
  clearPreview(); $('impName').value = ''; $('impName').dataset.auto = '1'; renderStaged();
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
  renderStaged(!!main);
  if (!main) return;
  try {
    const res = await loadModelFiles(staged.slice());
    if (ticket !== parseTicket) return;
    stagedRes = res; showPreview(res.object); renderStaged();
    setTimeout(() => { if (ticket === parseTicket) { stagedMissing = [...new Set(res.missing)]; renderStaged(); } }, 1600);
  } catch (err) {
    if (ticket !== parseTicket) return;
    console.error(err); stagedErr = err.message || String(err); renderStaged();
  }
}
function renderStaged(loading = false) {
  const list = $('impFiles'), main = mainOf(staged);
  $('impCount').textContent = staged.length ? `${staged.length} file${staged.length > 1 ? 's' : ''}` : '';
  list.innerHTML = '';
  if (!staged.length) list.innerHTML = '<p class="hint">No files yet. Add the model file and, if it has them, its textures (.png / .jpg), .mtl or .bin files.</p>';
  staged.forEach(f => {
    const e = extOf(f.name);
    const [label, cls] = f === main ? ['Model', 'violet'] : MODEL_EXTS.includes(e) ? ['Not used', ''] : IMAGE_EXT.test(f.name) ? ['Texture', 'green'] : ['mtl', 'bin'].includes(e) ? ['Companion', ''] : ['Extra', ''];
    const row = document.createElement('div'); row.className = 'frow';
    row.innerHTML = `<svg class="i sm" style="color:var(--muted)"><use href="#i-${IMAGE_EXT.test(f.name) ? 'image' : f === main ? 'box' : 'file'}"/></svg>`;
    const n = document.createElement('span'); n.className = 'fn'; n.textContent = f.name; n.title = f.name;
    const b = document.createElement('span'); b.className = 'badge ' + cls; b.textContent = label;
    const sz = document.createElement('span'); sz.className = 'fs'; sz.textContent = fmtBytes(f.data.byteLength);
    const x = document.createElement('button'); x.className = 'x'; x.title = 'Remove'; x.innerHTML = '<svg class="i sm"><use href="#i-x"/></svg>';
    x.onclick = () => { staged = staged.filter(s => s !== f); parseStaged(); };
    row.append(n, b, sz, x); list.appendChild(row);
  });
  const missImgs = stagedMissing.filter(n => !staged.some(f => f.name.toLowerCase() === n));
  missImgs.forEach(n => {
    const row = document.createElement('div'); row.className = 'frow missing';
    row.innerHTML = '<svg class="i sm" style="color:var(--warn)"><use href="#i-alert"/></svg>';
    const s = document.createElement('span'); s.className = 'fn'; s.textContent = n;
    const b = document.createElement('span'); b.className = 'badge amber'; b.textContent = 'Missing';
    row.append(s, b); list.appendChild(row);
  });
  // stats + message
  const st = $('impStats'); st.innerHTML = '';
  const badge = (t, c = '') => { const b = document.createElement('span'); b.className = 'badge ' + c; b.textContent = t; st.appendChild(b); };
  if (stagedRes) {
    let meshes = 0, mats = new Set(), uv = false;
    stagedRes.object.traverse(o => { if (o.isMesh) { meshes++; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && mats.add(m)); if (o.geometry?.attributes?.uv) uv = true; } });
    const maps = [...mats].filter(m => m.map).length;
    badge(`${meshes} mesh${meshes === 1 ? '' : 'es'}`); badge(`${mats.size} material${mats.size === 1 ? '' : 's'}`);
    badge(maps ? `${maps} with textures` : 'no textures', maps ? 'green' : '');
    if (!uv) badge('no UVs', 'amber');
    if (missImgs.length) badge(`${missImgs.length} missing`, 'amber');
  }
  const msg = $('impMsg');
  if (!staged.length) msg.textContent = '';
  else if (!main) msg.textContent = 'Add a model file (FBX, OBJ, glTF, GLB, DAE, STL, PLY, 3MF or 3DS).';
  else if (stagedErr) msg.innerHTML = '', msg.append(Object.assign(document.createElement('span'), { style: 'color:var(--err)', textContent: `Couldn't read ${main.name}: ${stagedErr}` }));
  else if (loading || !stagedRes) msg.innerHTML = '<span class="row" style="gap:8px"><span class="spinner"></span>Reading the model…</span>';
  else if (missImgs.length) msg.textContent = `${missImgs.length} texture file${missImgs.length > 1 ? 's are' : ' is'} missing. Drop ${missImgs.length > 1 ? 'them' : 'it'} in now, or add ${missImgs.length > 1 ? 'them' : 'it'} later in Materials.`;
  else msg.textContent = 'Looks good.';
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
  impCam = new THREE.PerspectiveCamera(32, 4 / 3, 0.01, 100); impCam.position.set(0, 0.45, 2.3); impCam.lookAt(0, 0, 0);
  impPivot = new THREE.Group(); impScene.add(impPivot);
  $('impPreview').appendChild(impR.domElement);
}
function showPreview(obj) {
  ensurePreview(); clearPreview();
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const wrap = new THREE.Group(); wrap.scale.setScalar(s); wrap.position.copy(c).multiplyScalar(-s); wrap.add(obj);   // the model's own transform stays untouched
  impPivot.add(wrap); impPivot.rotation.set(0, -0.6, 0);
  $('impPh').hidden = true;
  const loop = () => {
    impRaf = requestAnimationFrame(loop);
    const r = $('impPreview').getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (w && h && (impR.domElement.width !== Math.round(w * impR.getPixelRatio()) || impR.domElement.height !== Math.round(h * impR.getPixelRatio()))) { impR.setSize(w, h, false); impCam.aspect = w / h; impCam.updateProjectionMatrix(); }
    impPivot.rotation.y += 0.006; impR.render(impScene, impCam);
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
    impR.setSize(1, 1, false);                     // the preview loop re-fits it when the import window shows
    return url;
  } catch (e) { return null; }
}
function clearPreview() {
  cancelAnimationFrame(impRaf);
  if (impPivot) { impPivot.clear(); impR.render(impScene, impCam); }
  const ph = $('impPh'); ph.hidden = false; ph.textContent = 'A preview appears here.';
}
async function confirmImport() {
  if (!stagedRes) return;
  const files = staged.slice(), res = stagedRes, units = $('impUnits').value;
  const name = $('impName').value.trim() || res.name.replace(/\.[^.]+$/, '');
  res.object.removeFromParent();                         // out of the preview, back to its own transform
  closeImport(); closeModels();
  await finishImport(files, res, { name, units });
}
async function finishImport(files, res, { name, units = 'fit' } = {}) {
  try {
    const sig = sigOf(files);
    const dup = Object.values(models).find(m => m.sig === sig);
    if (dup) {
      if (dup.id === currentId || await openModel(dup.id, { quiet: true })) return toast(`"${dup.name}" is already in your models, so it was opened`);
      delete models[dup.id];                              // its stored files are gone: add it fresh below
    }
    const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    models[id] = { id, name, kind: 'import', format: extOf(res.name), sig, size: files.reduce((a, f) => a + f.data.byteLength, 0), created: Date.now(), used: Date.now(), thumb: null, work: null, poses: [], initItem: { units } };
    const stored = await store.putFiles(id, files);
    await openModel(id, { loaded: res, quiet: true });
    showTab('object');
    toast(stored ? `Added ${name} to your models` : `Loaded ${name}, but it couldn't be stored, so it won't be remembered`, !stored);
  } catch (err) {
    console.error(err);
    toast('Could not add the model: ' + (err.message || err), true);
  }
}
// kept for the palette / older call sites: everything goes through the import window now
function importFiles(fileList) { openImport(fileList); }
$('impDrop').onclick = () => $('impFile').click();
$('impDrop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('impFile').click(); } };
$('impFile').onchange = e => { addStaged([...e.target.files]); e.target.value = ''; };
$('impName').oninput = () => { $('impName').dataset.auto = '0'; };
$('impOk').onclick = confirmImport;
$('impCancel').onclick = closeImport; $('impClose').onclick = closeImport;
$('importDlg').onclick = e => { if (e.target === $('importDlg')) closeImport(); };
$('importTop').onclick = () => openImport();
$('homeDrop').onclick = () => openImport();
$('homeDrop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openImport(); } };
$('mImport').onclick = e => { e.stopPropagation(); openImport(); };

// ───────── settings ─────────
let appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
let upd = { status: window.desktop ? 'idle' : 'web' }, resetting = false;
function openSettings(pane = 'general') { closePalette(); $('settingsDlg').hidden = false; showSPane(pane); syncSettings(); }
function closeSettings() { $('settingsDlg').hidden = true; }
function showSPane(p) {
  document.querySelectorAll('.snav [data-spane]').forEach(b => b.classList.toggle('on', b.dataset.spane === p));
  document.querySelectorAll('.spane').forEach(s => s.classList.toggle('on', s.dataset.spane === p));
}
function syncSettings() {
  $('setHome').checked = prefs.homeOnStart !== false; $('setGrip').checked = prefs.autoGripNew !== false;
  $('setUnits').value = prefs.importUnits || 'fit'; $('setHints').checked = prefs.hints !== false;
  document.querySelectorAll('#setMouse button').forEach(b => b.classList.toggle('on', b.dataset.m === navMode()));
  document.querySelectorAll('#setZoom button').forEach(b => { b.classList.toggle('on', +b.dataset.z === (prefs.uiScale || 1)); b.disabled = !window.desktop; });
  $('zoomHint').textContent = window.desktop ? 'Makes text and controls bigger or smaller.' : 'In a browser, use Ctrl + / Ctrl − to zoom instead.';
  renderUpdate();
}
document.querySelectorAll('.snav [data-spane]').forEach(b => b.onclick = () => showSPane(b.dataset.spane));
$('settingsBtn').onclick = () => openSettings();
$('sbVersion').onclick = () => openSettings(upd.status === 'ready' ? 'updates' : 'about');
$('setClose').onclick = closeSettings;
$('settingsDlg').onclick = e => { if (e.target === $('settingsDlg')) closeSettings(); };
$('setHome').onchange = e => { prefs.homeOnStart = e.target.checked; scheduleSave(); };
$('setGrip').onchange = e => { prefs.autoGripNew = e.target.checked; scheduleSave(); };
$('setUnits').onchange = e => { prefs.importUnits = e.target.value; scheduleSave(); };
document.querySelectorAll('#setMouse button').forEach(b => b.onclick = () => { prefs.mouse = b.dataset.m; applyMouseMode(); syncSettings(); scheduleSave(); });
$('setHints').onchange = e => { prefs.hints = e.target.checked; $('hint').hidden = !prefs.hints; scheduleSave(); };
document.querySelectorAll('#setZoom button').forEach(b => b.onclick = async () => {
  prefs.uiScale = +b.dataset.z; scheduleSave(); syncSettings();
  if (window.desktop) await window.desktop.setZoom(prefs.uiScale);
});
$('resetAll').onclick = () => {
  if (!confirm('Delete every imported model, texture, saved pose and setting? This cannot be undone.')) return;
  resetting = true; clearTimeout(saveTimer);
  try { localStorage.removeItem('handposer.v1'); } catch (e) { }
  const req = indexedDB.deleteDatabase('handposer');
  req.onsuccess = req.onerror = req.onblocked = () => location.reload();
};
// external links: the desktop app opens them in the browser
document.querySelectorAll('a[target=_blank]').forEach(a => a.onclick = e => { if (window.desktop) { e.preventDefault(); window.desktop.openExternal(a.href); } });

// ───────── updates (desktop app) ─────────
function renderUpdate() {
  const s = upd.status, pill = $('updatePill');
  pill.hidden = !(s === 'ready' || s === 'downloading');
  pill.classList.toggle('busy', s === 'downloading');
  $('updateText').textContent = s === 'ready' ? `Update ${upd.version} ready · Restart` : `Downloading update${upd.percent ? ' ' + upd.percent + '%' : '…'}`;
  pill.title = s === 'ready' ? 'Restart Hand Poser to install the update' : 'Downloading in the background';
  const T = {
    web: 'This is the web version. It doesn\'t update itself; the installed desktop app does.',
    dev: 'Development build: update checks only run in the installed app.',
    idle: 'Checking for updates shortly…', checking: 'Checking for updates…',
    latest: `You're on the latest version${appVersion ? ' (v' + appVersion + ')' : ''}.`,
    downloading: `Downloading version ${upd.version || ''}… ${upd.percent || 0}%`,
    ready: `Version ${upd.version} has been downloaded. Restart to install it (or it installs when you close the app).`,
    error: /404/.test(upd.message || '') ? 'No published releases were found on GitHub yet.' : `Couldn't check for updates${upd.message ? ': ' + upd.message : ''}. Check your internet connection.`,
  };
  $('updText').textContent = T[s] || '—';
  $('updSpin').hidden = !(s === 'checking' || s === 'downloading' || s === 'idle');
  $('updCheck').disabled = s === 'web' || s === 'dev' || s === 'checking' || s === 'downloading';
  $('updInstall').hidden = s !== 'ready';
  $('sbVersion').textContent = (appVersion ? 'v' + appVersion : '') + (s === 'ready' ? ' · update ready' : '');
  $('aboutVer').textContent = appVersion ? `Version ${appVersion}` : '';
}
const installUpdate = () => window.desktop?.installUpdate();
$('updatePill').onclick = () => { if (upd.status === 'ready') installUpdate(); else openSettings('updates'); };
$('updInstall').onclick = installUpdate;
$('updCheck').onclick = async () => { if (!window.desktop) return; upd = { ...upd, status: 'checking' }; renderUpdate(); upd = await window.desktop.checkForUpdates(); renderUpdate(); };
if (window.desktop) {
  document.body.classList.add('desktop');
  window.desktop.info().then(i => {
    appVersion = i.version; upd = i.update || upd;
    if (i.platform === 'darwin') document.body.classList.add('mac');
    renderUpdate();
  });
  window.desktop.onUpdate(s => {
    const was = upd.status; upd = s; renderUpdate();
    if (s.status === 'ready' && was !== 'ready') toast(`Version ${s.version} is ready. Restart from the title bar, or it installs when you close the app.`);
  });
}
renderUpdate();

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
  if (files.every(f => IMAGE_EXT.test(f.name))) { closeModels(); showTab('materials'); return addTextureFiles(files); }   // just images: textures for the current model
  openImport(files);
});

// hands: active, mirror, display
$('handR').onclick = () => setActive('R'); $('handL').onclick = () => setActive('L');
$('live').onchange = e => { live = e.target.checked; if (live) { mirrorTo(other(active)); changed({ commitNow: true }); } scheduleSave(); };
$('copyRL').onclick = () => { mirrorTo('L'); changed({ commitNow: true }); toast('Right hand mirrored onto the left'); };
$('copyLR').onclick = () => { mirrorTo('R'); changed({ commitNow: true }); toast('Left hand mirrored onto the right'); };
$('swap').onclick = () => {
  const pR = hands.R.getPose(), pL = hands.L.getPose(), cR = canonHold('R'), cL = canonHold('L');
  hands.R.setPose(pL); hands.L.setPose(pR); setCanonHold('R', cL.p, cL.q); setCanonHold('L', cR.p, cR.q);
  changed({ commitNow: true, all: true }); toast('Swapped');
};
$('limits').onchange = e => {
  limits = e.target.checked;
  if (limits) Object.values(hands).forEach(h => { POSABLE.forEach(b => clampBone(h, b)); h.applyAll(); });
  changed({ commitNow: true, all: true });
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
  $('showR').checked = prefs.show.R; $('showL').checked = prefs.show.L;
  $('showJoints').checked = prefs.showJoints; $('showIK').checked = prefs.showIK; $('xray').checked = prefs.xray; $('showGrid').checked = prefs.grid;
  $('fur').value = prefs.fur; $('furTex').classList.toggle('on', prefs.furTex);
}
$('showR').onchange = e => { prefs.show.R = e.target.checked; if (!e.target.checked && active === 'R' && prefs.show.L) setActive('L'); applyDisplay(); scheduleSave(); };
$('showL').onchange = e => { prefs.show.L = e.target.checked; if (!e.target.checked && active === 'L' && prefs.show.R) setActive('R'); applyDisplay(); scheduleSave(); };
$('showJoints').onchange = e => { prefs.showJoints = e.target.checked; applyDisplay(); scheduleSave(); };
$('showIK').onchange = e => { prefs.showIK = e.target.checked; if (!prefs.showIK && sel?.kind === 'ik') select(null); applyDisplay(); scheduleSave(); };
$('xray').onchange = e => { prefs.xray = e.target.checked; applyDisplay(); scheduleSave(); };
$('showGrid').onchange = e => { prefs.grid = e.target.checked; applyDisplay(); scheduleSave(); };
$('fur').oninput = e => { prefs.fur = e.target.value; applyDisplay(); scheduleSave(); };
$('furTex').onclick = () => { prefs.furTex = !prefs.furTex; applyDisplay(); scheduleSave(); };

// toolbar
$('toolSelect').onclick = () => setTool('select'); $('toolMove').onclick = () => setTool('move'); $('toolRotate').onclick = () => setTool('rotate');
$('space').onclick = () => setSpace(space === 'local' ? 'world' : 'local');
$('snap').onclick = () => setSnap(!snap);
$('undo').onclick = undo; $('redo').onclick = redo;
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(b.dataset.view));
$('tRight').onclick = () => $('right').classList.toggle('open');

// saved poses
function refreshLib() {
  const el = $('lib'); el.innerHTML = '';
  const library = lib();
  refreshModelChrome();
  if (!library.length) { el.innerHTML = '<p class="hint">No poses saved for this model yet.</p>'; return; }
  library.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'item';
    const name = document.createElement('span'); name.textContent = p.name; name.title = p.name;
    const load = document.createElement('button'); load.className = 'tiny'; load.textContent = 'Load'; load.title = 'Both hands and the object';
    const fing = document.createElement('button'); fing.className = 'tiny'; fing.textContent = 'Fingers'; fing.title = 'Only the finger pose, onto the hand you are editing';
    const del = document.createElement('button'); del.className = 'tiny'; del.textContent = '✕'; del.title = 'Delete';
    load.onclick = () => { applyLibPose(p); changed({ commitNow: true, all: true }); };
    fing.onclick = () => { H().setPose(p[active]); changed({ commitNow: true, all: true }); };
    del.onclick = () => { library.splice(i, 1); refreshLib(); scheduleSave(); };
    row.append(name, load, fing, del); el.appendChild(row);
  });
}
$('poseSave').onclick = () => {
  if (!models[currentId]) return;
  const library = lib();
  const name = $('poseName').value.trim() || `Pose ${library.length + 1}`;
  const s = JSON.parse(snapshot());
  const ex = library.findIndex(p => p.name === name);
  const entry = { name, R: s.R, L: s.L, hR: s.hR, hL: s.hL };
  if (ex >= 0) library[ex] = entry; else library.push(entry);
  models[currentId].thumb = captureThumb() || models[currentId].thumb;
  $('poseName').value = ''; refreshLib(); scheduleSave(); toast(`Saved "${name}" with ${models[currentId].name}`);
};
$('poseName').onkeydown = e => { if (e.key === 'Enter') $('poseSave').click(); };

// export / import
const shortName = b => BONE_NAMES[b].replace(/\.R_nhd$/, '').replace(/\.R_end$/, '_end');
function exportData() {
  const side = s => {
    const h = hands[s], c = canonHold(s), e = new THREE.Euler().setFromQuaternion(h.holder.quaternion, 'YXZ');
    const bones = {};
    POSABLE.forEach(b => bones[shortName(b)] = { curl: round(h.pose[b][0], 2), spread: round(h.pose[b][1], 2), twist: round(h.pose[b][2], 2), localQuaternion: h.bones[b].quaternion.toArray().map(v => round(v, 6)) });
    return {
      object: { position: h.holder.position.toArray().map(v => round(v, 6)), quaternion: h.holder.quaternion.toArray().map(v => round(v, 6)), eulerYXZdeg: [e.x, e.y, e.z].map(v => round(v / DEG, 2)) },
      bones,
    };
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
$('exportJson').onclick = () => download(`hand-pose-${(item.name || 'pose').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')}.json`, new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' }));
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
    changed({ commitNow: true, all: true }); toast('Imported ' + f.name);
  } catch (err) { console.error(err); toast('Not a Hand Poser JSON file', true); }
}
$('copyUnity').onclick = async () => {
  const u = unityHold();
  const lines = [`# Hand Poser - right hand, Unity hand-bone space (metres | quaternion x, y, z, w)`, `object = ${u.position.join(', ')} | ${u.quaternion.join(', ')}`];
  POSABLE.forEach(b => { const q = hands.R.bones[b].quaternion; lines.push(`${shortName(b)} = ${[q.x, -q.y, -q.z, q.w].map(v => v.toFixed(5)).join(', ')}`); });
  const txt = lines.join('\n');
  try { await navigator.clipboard.writeText(txt); toast('Copied Unity text'); }
  catch (e) { download('hand-pose-unity.txt', new Blob([txt], { type: 'text/plain' })); toast('Clipboard blocked - saved as a file instead'); }
};
$('shot').onclick = () => {
  const vis = []; scene.traverse(o => { if ((o.userData.pick || o === gizmo.getHelper()) && o.visible) { vis.push(o); o.visible = false; } });
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => { download('hand-pose.png', b); vis.forEach(o => o.visible = true); });
};

// ───────── camera ─────────
let tween = null;
function flyTo(pos, target) { tween = { p0: camera.position.clone(), t0: orbit.target.clone(), p1: pos, t1: target, start: performance.now() }; }
function view(v) {
  const hp = H().root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.06, 0));
  const palm = new THREE.Vector3(active === 'R' ? -1 : 1, 0, 0);
  const V = {
    front: [new THREE.Vector3(0.1, 0.12, -0.62), CENTER],
    back: [new THREE.Vector3(-0.1, 0.12, 0.62), CENTER],
    top: [new THREE.Vector3(0, 0.75, 0.02), CENTER],
    pov: [new THREE.Vector3(-0.26, 0.3, 0.58), new THREE.Vector3(0.02, 0.05, 0)],
    thumb: [hp.clone().add(new THREE.Vector3(0, 0.02, 0.35)), hp],
    palm: [hp.clone().addScaledVector(palm, 0.17).add(new THREE.Vector3(0, 0.06, -0.24)), hp],   // from the front, clear of the other hand
  };
  if (v === 'fit') return frameSelection();
  const [p, t] = V[v]; flyTo(p.clone(), t.clone());
}
function frameSelection() {
  const h = H(), box = new THREE.Box3();
  if (sel?.kind === 'object') box.setFromObject(h.holder);
  else if (sel?.kind === 'bone' || sel?.kind === 'ik') {
    const F = FINGERS[sel.kind === 'ik' ? sel.finger : fingerOf(sel.b)];
    (F ? F.bones : [sel.b]).forEach(b => box.expandByPoint(h.bonePosWorld(b)));
    if (F) box.expandByPoint(h.tipWorld(Object.keys(FINGERS).find(k => FINGERS[k] === F)));
    box.expandByScalar(0.03);
  } else { [1, 6, 10, 14].forEach(b => box.expandByPoint(h.bonePosWorld(b))); box.expandByObject(h.holder); }
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.03);
  const dir = camera.position.clone().sub(orbit.target).normalize();
  flyTo(c.clone().addScaledVector(dir, r / Math.sin(camera.fov * DEG / 2) * 1.1), c);
}

// ───────── keyboard ─────────
addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); return openImport(); }
  if (e.key === 'Escape') {
    if (!$('importDlg').hidden) return closeImport();
    if (!$('settingsDlg').hidden) return closeSettings();
  }
  if (!$('importDlg').hidden || !$('settingsDlg').hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return $('palette').hidden ? openPalette() : closePalette(); }
  if (!$('palette').hidden) return;
  const NUMVIEW = { Numpad1: e.ctrlKey ? 'back' : 'front', Numpad3: 'thumb', Numpad7: 'top', Numpad0: 'pov' };
  if (!typing && $('models').hidden && NUMVIEW[e.code]) { e.preventDefault(); return view(NUMVIEW[e.code]); }
  if (!typing && $('models').hidden && e.code === 'NumpadDecimal') { e.preventDefault(); return frameSelection(); }
  if ((e.ctrlKey || e.metaKey) && !typing) {
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
    if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); return redo(); }
    return;
  }
  if (e.key === 'Escape') { if (!$('models').hidden) return closeModels(); document.activeElement?.blur?.(); return select(null); }
  if (!$('models').hidden) return;
  if (typing || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); return openPalette(); }
  if (e.key.toLowerCase() === 'h') return $('models').hidden ? showModels() : closeModels();
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'g') setTool('move');            // G / R as in Blender
  else if (k === 'e' || k === 'r') setTool('rotate');
  else if (k === 's') setTool('select');
  else if (k === 'q') setSpace(space === 'local' ? 'world' : 'local');
  else if (k === 'x') setSnap(!snap);
  else if (k === 'f') frameSelection();
  else if (k === 'm') { mirrorTo(other(active)); changed({ commitNow: true }); toast(`Mirrored onto the ${SIDE_NAME[other(active)]} hand`); }
  else if (e.key === 'Tab') { e.preventDefault(); setActive(other(active)); }
  else return;
});

// ───────── refresh ─────────
function refreshUI() {
  refreshBoneUI(); refreshFingerUI(); refreshObjUI(); applyDisplay();
  $('handR').classList.toggle('on', active === 'R'); $('handL').classList.toggle('on', active === 'L');
  $('live').checked = live; $('limits').checked = limits;
  Object.values(hands).forEach(h => Object.entries(h.markers).forEach(([b, m]) => {
    const on = sel?.kind === 'bone' && +b === sel.b;
    m.scale.setScalar(on ? 1.7 : 1); m.material.color.set(on ? 0xffffff : FINGER_COL[fingerOf(+b) || 'palm']);
  }));
  Object.values(hands).forEach(h => Object.entries(h.ik).forEach(([f, m]) => { const on = sel?.kind === 'ik' && sel.finger === f; m.material.opacity = on ? 0.9 : 0.55; }));
  status(); paintRanges();
}

// ───────── app chrome ─────────
function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
  paintRanges();
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
document.querySelectorAll('.card.collapsible > .hd').forEach(hd => hd.onclick = () => hd.parentElement.classList.toggle('closed'));

// range sliders paint their filled part from --p
function paintRange(r) {
  const min = +r.min || 0, max = r.max === '' ? 100 : +r.max, v = +r.value;
  r.style.setProperty('--p', (max > min ? clamp((v - min) / (max - min), 0, 1) * 100 : 0) + '%');
}
function paintRanges() { document.querySelectorAll('input[type=range]').forEach(paintRange); }
document.addEventListener('input', e => { if (e.target.type === 'range') paintRange(e.target); });
document.addEventListener('change', () => paintRanges());

function refreshModelChrome() {
  const m = models[currentId], name = m?.name || '—', thumb = m?.thumb ? `url("${m.thumb}")` : '';
  $('modelsBtnName').textContent = m?.name || 'Models';
  $('libModel').textContent = name; $('heroName').textContent = name; $('sbModel').textContent = name;
  $('modelsBtnThumb').style.backgroundImage = thumb; $('modelsBtnThumb').firstElementChild.style.display = thumb ? 'none' : '';
  $('heroThumb').style.backgroundImage = thumb;
  $('libCount').textContent = lib().length;
}
$('frameBtn').onclick = () => frameSelection();
$('exportTop').onclick = () => $('exportJson').click();
$('selClear').onclick = () => select(null);
$('paletteBtn').onclick = () => openPalette();

// ───────── command palette (Ctrl+K) ─────────
function commands() {
  const C = [], add = (group, label, icon, run, key = '') => C.push({ group, label, icon, run, key });
  add('Tools', 'Select tool', 'cursor', () => setTool('select'), 'S');
  add('Tools', 'Move tool', 'move', () => setTool('move'), 'W');
  add('Tools', 'Rotate tool', 'rotate', () => setTool('rotate'), 'E');
  add('Tools', `Gizmo space: switch to ${space === 'local' ? 'world' : 'local'}`, 'axis', () => setSpace(space === 'local' ? 'world' : 'local'), 'Q');
  add('Tools', `Snap: turn ${snap ? 'off' : 'on'}`, 'magnet', () => setSnap(!snap), 'X');
  add('Tools', 'Frame the selection', 'focus', frameSelection, 'F');
  add('Hands', `Edit the ${SIDE_NAME[other(active)]} hand`, 'hand', () => setActive(other(active)), 'Tab');
  add('Hands', `Mirror the ${SIDE_NAME[active]} hand onto the ${SIDE_NAME[other(active)]}`, 'flip', () => { mirrorTo(other(active)); changed({ commitNow: true }); toast(`Mirrored onto the ${SIDE_NAME[other(active)]} hand`); }, 'M');
  add('Hands', 'Copy right → left', 'flip', () => $('copyRL').click());
  add('Hands', 'Copy left → right', 'flip', () => $('copyLR').click());
  add('Hands', 'Swap hands', 'swap', () => $('swap').click());
  add('Hands', `Live mirror: turn ${live ? 'off' : 'on'}`, 'flip', () => $('live').click());
  add('Hands', 'Auto-grip the object', 'spark', () => $('gripAuto').click());
  add('Hands', 'Reset hand', 'hand', () => $('handReset').click());
  add('Hands', `Joint limits: turn ${limits ? 'off' : 'on'}`, 'bone', () => $('limits').click());
  Object.keys(PRESETS).forEach(n => add('Presets', 'Pose preset: ' + n, 'hand', () => applyPreset(n)));
  lib().forEach(p => add('Saved poses', 'Load pose: ' + p.name, 'save', () => { applyLibPose(p); changed({ commitNow: true, all: true }); toast('Loaded ' + p.name); }));
  add('Saved poses', 'Save the current pose…', 'save', () => { showTab('library'); $('poseName').focus(); });
  Object.values(models).sort((a, b) => b.used - a.used).forEach(m => { if (m.id !== currentId) add('Models', 'Open model: ' + m.name, 'box', () => pickModel(m.id)); });
  add('Models', 'Import a model…', 'upload', () => openImport(), 'Ctrl O');
  add('Models', 'Home: my models', 'home', showModels, 'H');
  add('App', 'Settings', 'gear', () => openSettings());
  add('App', 'Check for updates', 'refresh', () => openSettings('updates'));
  add('App', 'Materials & textures', 'image', () => showTab('materials'));
  [['pov', 'First person'], ['front', 'Front'], ['back', 'Back'], ['top', 'Top'], ['thumb', 'Thumb side'], ['palm', 'Palm']].forEach(([v, n]) => add('Camera', 'View: ' + n, 'eye', () => view(v)));
  add('Export', 'Export pose JSON', 'download', () => $('exportJson').click());
  add('Export', 'Import pose JSON…', 'upload', () => $('importJson').click());
  add('Export', 'Copy Unity text', 'download', () => $('copyUnity').click());
  add('Export', 'Save a screenshot', 'camera', () => $('shot').click());
  [['xray', 'See-through hand'], ['showGrid', 'Floor grid'], ['showJoints', 'Joint handles'], ['showIK', 'Fingertip IK handles'], ['objShow', 'Show object']].forEach(([id, n]) =>
    add('Viewport', `${n}: turn ${$(id).checked ? 'off' : 'on'}`, 'eye', () => $(id).click()));
  return C;
}
let palItems = [], palIdx = 0;
function openPalette() {
  closeModels(); $('palette').hidden = false; $('palInput').value = ''; renderPalette(); setTimeout(() => $('palInput').focus(), 0);
}
function closePalette() { $('palette').hidden = true; $('palInput').blur(); }
function renderPalette() {
  const q = $('palInput').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  palItems = commands().filter(c => q.every(w => (c.label + ' ' + c.group).toLowerCase().includes(w)));
  palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1));
  const list = $('palList'); list.innerHTML = '';
  if (!palItems.length) { list.innerHTML = '<div class="none">No matching actions</div>'; return; }
  let group = null;
  palItems.forEach((c, i) => {
    if (c.group !== group) { group = c.group; const g = document.createElement('div'); g.className = 'grp'; g.textContent = group; list.appendChild(g); }
    const it = document.createElement('div'); it.className = 'it' + (i === palIdx ? ' on' : '');
    it.innerHTML = `<svg class="i sm"><use href="#i-${c.icon}"/></svg>`;
    const t = document.createElement('span'); t.textContent = c.label; it.appendChild(t);
    if (c.key) { const k = document.createElement('span'); k.className = 'kbd k'; k.textContent = c.key; it.appendChild(k); }
    it.onmousemove = () => { if (palIdx !== i) { palIdx = i; list.querySelectorAll('.it').forEach((x, j) => x.classList.toggle('on', j === i)); } };
    it.onclick = () => runPalette(i);
    list.appendChild(it);
  });
  list.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) { const c = palItems[i]; if (!c) return; closePalette(); c.run(); }
$('palInput').oninput = () => { palIdx = 0; renderPalette(); };
$('palInput').onkeydown = e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = (palIdx + 1) % Math.max(1, palItems.length); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = (palIdx - 1 + palItems.length) % Math.max(1, palItems.length); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palIdx); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
};
$('palette').onclick = e => { if (e.target === $('palette')) closePalette(); };

// ───────── start ─────────
function resize() {
  const r = $('view').getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('view')); resize();
// belt and braces: if anything ever scrolls the page itself (it has no scrollable content), put it back
addEventListener('scroll', () => { if (document.scrollingElement.scrollTop || document.scrollingElement.scrollLeft) document.scrollingElement.scrollTo(0, 0); }, true);

const saved = store.loadState();
if (saved) {
  Object.assign(prefs, saved.prefs || {});
  prefs.show = Object.assign({ R: true, L: true }, (saved.prefs || {}).show);
  active = saved.active || 'R'; live = !!saved.live; limits = saved.limits !== false;
  tool = saved.tool || 'move'; setSnap(!!saved.snap);
  models = saved.models || {};
  item.show = saved.showObject ?? saved.item?.show ?? true;
}
ensureSamples();
setTool(tool);
camera.position.set(-0.26, 0.3, 0.58); orbit.target.set(0.02, 0.05, 0);
refreshItemUI(); refreshUI();

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
        models[want] = { id: want, name: main.name.replace(/\.[^.]+$/, ''), kind: 'import', sig: files.map(f => f.name + ':' + f.data.byteLength).sort().join('|'),
          size: files.reduce((a, f) => a + f.data.byteLength, 0), created: Date.now(), used: Date.now(), thumb: null, work: null, poses: [] };
        if (await store.putFiles(want, files)) store.clearModel(); else { delete models[want]; want = null; }
      }
    }
    if (want && models[want]) { models[want].work = work; models[want].poses = saved.library || []; }
  }
  if (!(want && models[want] && await openModel(want, { quiet: true }))) await openModel(SAMPLE_ID('bottle'), { quiet: true });
  if (prefs.homeOnStart !== false) showModels();
})();
applyMouseMode();
if (prefs.hints === false) $('hint').hidden = true;
if (window.desktop && prefs.uiScale && prefs.uiScale !== 1) window.desktop.setZoom(prefs.uiScale);

const tipTmp = new THREE.Vector3();
(function frame(now) {
  requestAnimationFrame(frame);
  if (tween) {
    const t = Math.min(1, (performance.now() - tween.start) / 350), k = t * t * (3 - 2 * t);
    camera.position.lerpVectors(tween.p0, tween.p1, k); orbit.target.lerpVectors(tween.t0, tween.t1, k);
    if (t >= 1) tween = null;
  }
  orbit.update();
  // fingertip handles sit on the tips unless one is being dragged
  Object.values(hands).forEach(h => Object.entries(h.ik).forEach(([f, m]) => {
    if (dragging && sel?.kind === 'ik' && sel.finger === f && h === H()) return;
    m.position.copy(h.tipHand(f, tipTmp));
  }));
  Object.values(hands).forEach(h => Object.values(h.ik).forEach(m => m.userData.ring.quaternion.copy(camera.quaternion).premultiply(h.root.getWorldQuaternion(new THREE.Quaternion()).invert())));
  renderer.render(scene, camera);
})();

// for debugging / automation
window.handPoser = { hands, importJsonFile, select, setActive, mirrorTo, exportData, applyPreset, view, gripFingers, solveFinger, FINGERS, THREE, camera, orbit, changed, setTool, openModel, showModels, get models() { return models; }, get currentId() { return currentId; } };
