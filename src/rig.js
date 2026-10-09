// The gorilla hand as a real THREE.SkinnedMesh, built once per side.
//
// Source data (window.GT_HAND) is the RIGHT hand in Unity hand-bone space (left-handed, metres).
// three.js space = Unity with x negated, so:
//   right hand = data with x negated (positions, and rest matrices conjugated by F = diag(-1,1,1))
//   left hand  = the raw data (its exact mirror image)
// Because the left hand is a true reflection of the right one (geometry AND skeleton), nothing has to be
// "re-oriented" by hand: the thumb stays on the correct side and the palm faces the correct way.
//
// Posing: every posable bone stores [curl, spread, twist] in degrees, applied on top of its rest rotation
// about anatomical axes (curl = bend towards the palm, spread = side to side, twist = roll along the bone).
// The left hand's axes are the mirror-image pseudo-vectors (-F * axis) of the right hand's, so the SAME numbers
// give the exact mirror pose. Copying a pose to the other hand is therefore a plain copy.
import * as THREE from 'three';

const H = window.GT_HAND;
export const F = new THREE.Matrix4().makeScale(-1, 1, 1);

export const BONE_NAMES = H.bones;
export const PARENT = H.parent;
export const FINGERS = {
  thumb:  { label: 'Thumb',  bones: [3, 4, 5], tip: 6 },
  index:  { label: 'Index',  bones: [7, 8, 9], tip: 10 },
  middle: { label: 'Middle', bones: [11, 12, 13], tip: 14 },
};
export const PALM_BONES = [1, 2];
export const POSABLE = [1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13];
export const NICE = {
  0: 'Wrist', 1: 'Palm (index)', 2: 'Palm (middle)',
  3: 'Thumb 1', 4: 'Thumb 2', 5: 'Thumb 3', 6: 'Thumb tip',
  7: 'Index 1', 8: 'Index 2', 9: 'Index 3', 10: 'Index tip',
  11: 'Middle 1', 12: 'Middle 2', 13: 'Middle 3', 14: 'Middle tip',
};
export const fingerOf = b => Object.keys(FINGERS).find(k => FINGERS[k].bones.includes(b) || FINGERS[k].tip === b) || null;

// Joint limits (degrees) per bone: [min, max] for curl, spread, twist. Used when "joint limits" is on and by IK.
export function limitsFor(b) {
  const f = fingerOf(b);
  if (PALM_BONES.includes(b)) return [[-15, 30], [-15, 15], [-10, 10]];
  if (f === 'thumb') {
    const seg = FINGERS.thumb.bones.indexOf(b);
    return seg === 0 ? [[-40, 70], [-45, 45], [-35, 35]] : [[-25, 95], [-10, 10], [-10, 10]];
  }
  const seg = FINGERS[f].bones.indexOf(b);
  return seg === 0 ? [[-30, 100], [-30, 30], [-15, 15]] : [[-15, 115], [-5, 5], [-5, 5]];
}

// ───────── rest pose in three space ─────────
const restUnity = H.rest.map(r => new THREE.Matrix4().set(...r[0], ...r[1], ...r[2], ...r[3]));
const restRight = restUnity.map(m => F.clone().multiply(m).multiply(F));
const restOf = side => (side === 'R' ? restRight : restUnity);

// Anatomical axes, computed in RIGHT hand space. In Unity space the palm faces +X and the thumb closes towards
// (0.6, 0.3, -1); after the x flip that is (-1,0,0) and (-0.6,0.3,-1).
const PALM_R = new THREE.Vector3(-1, 0, 0);
const THUMB_TO_R = new THREE.Vector3(-0.6, 0.3, -1).normalize();
function childOf(b) { return PARENT.indexOf(b); }
const axesHandR = BONE_NAMES.map((name, b) => {
  const c = childOf(b);
  if (b === 0 || c < 0) return null;
  const p0 = new THREE.Vector3().setFromMatrixPosition(restRight[b]);
  const p1 = new THREE.Vector3().setFromMatrixPosition(restRight[c]);
  const d = p1.sub(p0).normalize();
  const to = name.startsWith('thumb') ? THUMB_TO_R : PALM_R;
  const curl = new THREE.Vector3().crossVectors(d, to).normalize();          // rotating d about d x to moves it towards `to`
  const spread = new THREE.Vector3().crossVectors(d, curl).normalize();     // e2 = e3 x e1  -> right-handed basis
  return [curl, spread, d];
});

// Per side: bone-local basis matrix B (columns curl, spread, twist) and its inverse.
function basesFor(side) {
  const rest = restOf(side);
  return axesHandR.map((ax, b) => {
    if (!ax) return null;
    const handAx = side === 'R' ? ax : ax.map(v => new THREE.Vector3(v.x, -v.y, -v.z));   // -F v  (pseudo-vector mirror)
    const rotInv = new THREE.Matrix4().extractRotation(rest[b]).invert();
    const loc = handAx.map(v => v.clone().applyMatrix4(rotInv).normalize());
    const B = new THREE.Matrix4().makeBasis(loc[0], loc[1], loc[2]);
    return { B, Binv: B.clone().transpose(), qB: new THREE.Quaternion().setFromRotationMatrix(B) };
  });
}

// ───────── the hand ─────────
export class Hand {
  constructor(side, furTexture) {
    this.side = side;
    this.root = new THREE.Group();              // hand-bone space; everything held is a child of this
    this.root.name = 'hand' + side;
    const rest = restOf(side);
    const s = side === 'R' ? -1 : 1;

    // geometry
    const N = H.p.length / 3;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = s * H.p[i * 3]; pos[i * 3 + 1] = H.p[i * 3 + 1]; pos[i * 3 + 2] = H.p[i * 3 + 2]; }
    const idx = H.i.slice();
    if (side === 'R') for (let t = 0; t < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a; }
    const si = new Uint16Array(N * 4), sw = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const inf = H.skin[i]; let tot = 0;
      inf.forEach(([b, w], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = w; tot += w; });
      if (tot < 1e-4) { si[i * 4] = 0; sw[i * 4] = 1; }
      else for (let k = 0; k < 4; k++) sw[i * 4 + k] /= tot;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(H.u, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    // skeleton
    this.bones = rest.map((m, b) => { const bone = new THREE.Bone(); bone.name = BONE_NAMES[b]; return bone; });
    this.restLocalQ = [];
    rest.forEach((m, b) => {
      const par = PARENT[b];
      const local = par < 0 ? m.clone() : rest[par].clone().invert().multiply(m);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      local.decompose(p, q, sc);
      this.bones[b].position.copy(p); this.bones[b].quaternion.copy(q);
      this.restLocalQ[b] = q.clone();
      if (par >= 0) this.bones[par].add(this.bones[b]);
    });

    this.material = new THREE.MeshStandardMaterial({ map: furTexture, color: 0xffffff, roughness: 1, flatShading: true });
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.add(this.bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.userData.hand = this;
    this.root.add(this.mesh);

    // The real fingertip, in the last finger bone's frame. The rig's *_end bones stop up to 15 mm past the mesh, so the
    // IK handle and effector use the average of the vertices furthest out along the last bone instead.
    this.tipLocal = {};
    Object.entries(FINGERS).forEach(([f, F]) => {
      const last = F.bones[2], inv = rest[last].clone().invert();
      const end = new THREE.Vector3().setFromMatrixPosition(rest[F.tip]).applyMatrix4(inv), dir = end.clone().normalize();
      const pts = [];
      for (let i = 0; i < N; i++) {
        let w = 0; for (let k = 0; k < 4; k++) if (si[i * 4 + k] === last) w += sw[i * 4 + k];
        if (w >= 0.6) { const p = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(inv); pts.push([p.dot(dir), p]); }
      }
      if (!pts.length) { this.tipLocal[f] = end; return; }
      const max = Math.max(...pts.map(x => x[0])), near = pts.filter(x => x[0] > max - 0.002);
      this.tipLocal[f] = near.reduce((a, x) => a.add(x[1]), new THREE.Vector3()).divideScalar(near.length);
    });

    this.bases = basesFor(side);
    this.pose = {};                               // bone index -> [curl, spread, twist] degrees
    POSABLE.forEach(b => this.pose[b] = [0, 0, 0]);
  }

  // offset rotation (bone-local) for [c,s,t] degrees
  offsetQ(b, cst, out = new THREE.Quaternion()) {
    const { qB } = this.bases[b];
    const e = new THREE.Euler(cst[0] * DEG, cst[1] * DEG, cst[2] * DEG, 'XYZ');
    const qe = new THREE.Quaternion().setFromEuler(e);
    return out.copy(qB).multiply(qe).multiply(qB.clone().invert());
  }
  applyBone(b) {
    const q = this.offsetQ(b, this.pose[b]);
    this.bones[b].quaternion.copy(this.restLocalQ[b]).multiply(q);
  }
  applyAll() { POSABLE.forEach(b => this.applyBone(b)); this.root.updateMatrixWorld(true); }

  // read a bone's current local quaternion back into [c,s,t] (after a free gizmo rotation)
  readBone(b) {
    const off = this.restLocalQ[b].clone().invert().multiply(this.bones[b].quaternion);
    const { qB } = this.bases[b];
    const qb = qB.clone().invert().multiply(off).multiply(qB);
    const e = new THREE.Euler().setFromQuaternion(qb, 'XYZ');
    this.pose[b] = [e.x / DEG, e.y / DEG, e.z / DEG];
    return this.pose[b];
  }

  // axis (bone-local, rest frame) that changing DOF k rotates about, given current values (Euler XYZ chain)
  dofAxisLocal(b, k) {
    const { qB } = this.bases[b];
    const [c, s] = this.pose[b];
    const q = new THREE.Quaternion();
    if (k >= 1) q.multiply(new THREE.Quaternion().setFromAxisAngle(X, c * DEG));
    if (k >= 2) q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, s * DEG));
    const v = [X, Y, Z][k].clone().applyQuaternion(q);
    return v.applyQuaternion(qB);
  }
  // same axis in world space
  dofAxisWorld(b, k) {
    const par = this.bones[PARENT[b]];
    const wq = new THREE.Quaternion(); par.getWorldQuaternion(wq);
    return this.dofAxisLocal(b, k).applyQuaternion(this.restLocalQ[b]).applyQuaternion(wq).normalize();
  }

  bonePosWorld(b, out = new THREE.Vector3()) { return this.bones[b].getWorldPosition(out); }
  // bone position in this hand's root (hand-bone) space
  bonePosHand(b, out = new THREE.Vector3()) {
    this.bones[b].getWorldPosition(out);
    return this.root.worldToLocal(out);
  }

  // the fingertip (mesh tip, see tipLocal) in world / hand space
  tipWorld(f, out = new THREE.Vector3()) { return out.copy(this.tipLocal[f]).applyMatrix4(this.bones[FINGERS[f].bones[2]].matrixWorld); }
  tipHand(f, out = new THREE.Vector3()) { return this.root.worldToLocal(this.tipWorld(f, out)); }

  getPose() { const o = {}; POSABLE.forEach(b => o[b] = this.pose[b].slice()); return o; }
  setPose(p) { POSABLE.forEach(b => this.pose[b] = (p && p[b] ? p[b] : [0, 0, 0]).slice()); this.applyAll(); }
}

export const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

// mirror a transform expressed in hand-root space: position (x,y,z)->(-x,y,z), quaternion (x,y,z,w)->(x,-y,-z,w)
export function mirrorPos(p) { return new THREE.Vector3(-p.x, p.y, p.z); }
export function mirrorQuat(q) { return new THREE.Quaternion(q.x, -q.y, -q.z, q.w); }
