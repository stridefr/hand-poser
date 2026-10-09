// Fingertip IK (damped least squares over the finger's anatomical joint values) and auto-grip.
//
// The solver works directly on each joint's anatomical [curl, spread, twist] values, so whatever it produces is
// an ordinary pose: it respects joint limits, shows up in the sliders and mirrors to the other hand exactly.
import * as THREE from 'three';
import { FINGERS, PARENT, limitsFor } from './rig.js';

// Natural curl proportions of each finger's three joints (degrees at a full fist). The solver reaches the target
// first and, where it has freedom, keeps the joints curling in these proportions, so the whole finger bends
// together instead of the tip folding in on its own.
export const CURL_PROFILE = { thumb: [25, 40, 45], index: [80, 95, 75], middle: [80, 95, 75] };
const SHAPE = 2.5;        // how strongly the natural shape is preferred (a 10% shape difference costs like 0.25 mm of reach)
const KEEP_SPREAD = 0.2;  // slight reluctance to change the knuckle's side-to-side angle

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const tip = new THREE.Vector3(), off = new THREE.Vector3();
const FREE = [[-180, 180], [-180, 180], [-180, 180]];
function updateFrom(hand, b) { hand.bones[b].updateMatrixWorld(true); }

// Move the finger so its tip reaches `targetWorld` (Levenberg-Marquardt). Returns the remaining distance (metres).
// Parameters: base curl, base spread, middle curl, tip curl.
// `looseDir` (unit, world): the target only loosely constrains this direction. Pass the camera's view direction while
// dragging on screen: the tip then follows the cursor exactly, and how far it comes towards / away from you is left to
// the natural finger shape (otherwise a target dragged "down" in the palm's plane can only be reached by folding the tip).
export function solveFinger(hand, finger, targetWorld, { limits = true, iterations = 40, looseDir = null, looseWeight = 0.12 } = {}) {
  const F = FINGERS[finger], [b1, b2, b3] = F.bones, prof = CURL_PROFILE[finger];
  const lim = b => (limits ? limitsFor(b) : FREE);
  const BOUNDS = [lim(b1)[0], lim(b1)[1], lim(b2)[0], lim(b3)[0]];
  const s0 = hand.pose[b1][1];
  hand.bones[PARENT[b1]].updateMatrixWorld(true);
  const fk = v => {
    hand.pose[b1][0] = v[0]; hand.pose[b1][1] = v[1]; hand.pose[b2][0] = v[2]; hand.pose[b3][0] = v[3];
    hand.applyBone(b1); hand.applyBone(b2); hand.applyBone(b3);
    hand.bones[b1].updateMatrixWorld(true);
    return hand.tipWorld(finger, tip);
  };
  const residual = v => {
    const p = fk(v);
    off.subVectors(p, targetWorld);
    if (looseDir) off.addScaledVector(looseDir, (looseWeight - 1) * off.dot(looseDir));
    return [off.x * 1000, off.y * 1000, off.z * 1000,
      SHAPE * (v[0] / prof[0] - v[2] / prof[1]), SHAPE * (v[2] / prof[1] - v[3] / prof[2]), KEEP_SPREAD * (v[1] - s0) / 30];
  };
  const cost = r => r.reduce((a, x) => a + x * x, 0);
  const bound = v => v.map((x, i) => clamp(x, BOUNDS[i][0], BOUNDS[i][1]));
  let v = bound([hand.pose[b1][0], hand.pose[b1][1], hand.pose[b2][0], hand.pose[b3][0]]);
  let r = residual(v), c = cost(r), lambda = 1e-2;
  const JtJ = new THREE.Matrix4();
  for (let it = 0; it < iterations; it++) {
    if (Math.hypot(r[0], r[1], r[2]) < 0.1 && it > 2) break;          // within 0.1 mm (of the weighted error)
    // numeric Jacobian (6 residuals x 4 parameters), stepping away from a bound when sitting on one
    const J = v.map((x, i) => {
      const h = x + 0.25 > BOUNDS[i][1] ? -0.25 : 0.25, w = v.slice(); w[i] += h;
      return residual(w).map((y, k) => (y - r[k]) / h);
    });
    const A = [], g = [];
    for (let i = 0; i < 4; i++) { g[i] = J[i].reduce((a, x, k) => a + x * r[k], 0); for (let j = 0; j < 4; j++) A[i * 4 + j] = J[i].reduce((a, x, k) => a + x * J[j][k], 0); }
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const M = A.slice(); for (let i = 0; i < 4; i++) M[i * 5] += lambda * (A[i * 5] + 1e-6);
      JtJ.set(...M).invert();
      const e = JtJ.elements;                                          // column-major
      const step = [0, 1, 2, 3].map(i => -[0, 1, 2, 3].reduce((a, j) => a + e[j * 4 + i] * g[j], 0));
      const nv = bound(v.map((x, i) => x + clamp(step[i], -15, 15)));
      const nr = residual(nv), nc = cost(nr);
      if (nc < c) { v = nv; r = nr; c = nc; lambda = Math.max(lambda / 3, 1e-6); improved = true; }
      else lambda *= 4;
    }
    if (!improved) break;                                              // as close as the joints allow
  }
  return fk(v).distanceTo(targetWorld);
}

// Close a finger joint by joint until each segment touches one of `meshes` (or reaches its curl limit).
// Fingers are opened first so the grip wraps from the outside in.
export function autoGrip(hand, finger, meshes, { limits = true, radius = 0.009, step = 1.5 } = {}) {
  if (!meshes.length) return false;
  const F = FINGERS[finger], chain = F.bones;
  const ray = new THREE.Raycaster();
  const segs = chain.map((b, j) => [b, j + 1 < chain.length ? chain[j + 1] : F.tip]);
  chain.forEach(b => { hand.pose[b][0] = Math.min(hand.pose[b][0], 0); hand.applyBone(b); });
  hand.root.updateMatrixWorld(true);
  const a = new THREE.Vector3(), c = new THREE.Vector3(), dir = new THREE.Vector3(), inward = new THREE.Vector3(), o = new THREE.Vector3();
  const touching = () => {
    // any segment from this joint outwards touching the object?
    for (const [b0, b1] of segs) {
      hand.bonePosWorld(b0, a); if (b1 === F.tip) hand.tipWorld(finger, c); else hand.bonePosWorld(b1, c);
      dir.subVectors(c, a); const len = dir.length(); dir.normalize();
      inward.crossVectors(hand.dofAxisWorld(b0, 0), dir).normalize();      // the side that moves when curling = finger pad
      for (const off of [0, radius * 0.5, radius]) {
        o.copy(a).addScaledVector(inward, off);
        ray.set(o, dir); ray.far = len + (b1 === F.tip ? radius * 0.3 : 0);
        if (ray.intersectObjects(meshes, false).length) return true;
      }
      // a short probe out of the pad, at mid segment
      o.copy(a).addScaledVector(dir, len * 0.6);
      ray.set(o, inward); ray.far = radius;
      if (ray.intersectObjects(meshes, false).length) return true;
    }
    return false;
  };
  if (touching()) return false;                                   // already inside the object, nothing sensible to do
  let any = false;
  for (let j = 0; j < chain.length; j++) {
    const b = chain[j], max = limits ? limitsFor(b)[0][1] : 150;
    while (hand.pose[b][0] < max) {
      hand.pose[b][0] = Math.min(max, hand.pose[b][0] + step);
      hand.applyBone(b); updateFrom(hand, b);
      if (touching()) {
        hand.pose[b][0] -= step; hand.applyBone(b); updateFrom(hand, b);
        any = true; break;
      }
    }
  }
  return any;
}
