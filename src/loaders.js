// Importing the user's own objects. Accepts several files at once (e.g. model.obj + model.mtl + textures, or
// scene.gltf + scene.bin + textures); companion files are matched by file name, whatever folder the model expects.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

export const MODEL_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'dae', 'stl', 'ply', '3mf', '3ds'];
export const ACCEPT = MODEL_EXTS.map(e => '.' + e).concat(['.mtl', '.bin', '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.webp', '.gif']).join(',');

const ext = n => (n.split('.').pop() || '').toLowerCase();
const base = n => decodeURIComponent(n).split(/[\\/]/).pop().split('?')[0].toLowerCase();

// files: [{ name, data: ArrayBuffer }]
export async function loadModelFiles(files) {
  const main = MODEL_EXTS.map(e => files.find(f => ext(f.name) === e)).find(Boolean);
  if (!main) throw new Error('No model file found. Supported: ' + MODEL_EXTS.join(', ').toUpperCase());
  const urls = {}, made = [];
  for (const f of files) { const u = URL.createObjectURL(new Blob([f.data])); urls[base(f.name)] = u; made.push(u); }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => (url.startsWith('blob:') && made.includes(url)) ? url : (urls[base(url)] || url));
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  const mainUrl = urls[base(main.name)];
  const missing = [];
  manager.onError = url => missing.push(base(url));
  let obj;
  try {
    obj = await parse(ext(main.name), main, files, manager, mainUrl);
  } finally {
    setTimeout(() => made.forEach(u => URL.revokeObjectURL(u)), 60000);   // textures keep loading after parse
  }
  obj.name = main.name;
  prepare(obj);
  return { object: obj, name: main.name, missing };   // `missing` fills in as textures fail to resolve
}

async function parse(type, main, files, manager, url) {
  switch (type) {
    case 'glb': case 'gltf': {
      const g = await new GLTFLoader(manager).loadAsync(url);
      return g.scene || g.scenes[0];
    }
    case 'fbx': return new FBXLoader(manager).parse(main.data, '');
    case 'obj': {
      const loader = new OBJLoader(manager);
      const mtl = files.find(f => ext(f.name) === 'mtl');
      if (mtl) {
        const ml = new MTLLoader(manager);
        const mats = ml.parse(new TextDecoder().decode(mtl.data), '');
        mats.preload(); loader.setMaterials(mats);
      }
      return loader.parse(new TextDecoder().decode(main.data));
    }
    case 'dae': return (await new ColladaLoader(manager).loadAsync(url)).scene;
    case '3mf': return new ThreeMFLoader(manager).parse(main.data);
    case '3ds': { const l = new TDSLoader(manager); l.setResourcePath(''); return l.parse(main.data, ''); }
    case 'stl': case 'ply': {
      const geo = type === 'stl' ? new STLLoader(manager).parse(main.data) : new PLYLoader(manager).parse(main.data);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: geo.attributes.color ? 0xffffff : 0xb9c2cf, vertexColors: !!geo.attributes.color, roughness: 0.6, metalness: 0.05 });
      const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat)); return g;
    }
  }
  throw new Error('Unsupported file type: ' + type);
}

// make every imported mesh render sensibly next to the hand
function prepare(obj) {
  obj.traverse(o => {
    if (o.isLight || o.isCamera) { o.visible = false; return; }
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      m.side = THREE.DoubleSide;                     // many exported models have flipped or open faces
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      // full-white emissive with no emissive map = the map didn't come along; without this the model renders pure white
      if (m.emissive && !m.emissiveMap && m.emissive.r > 0.9 && m.emissive.g > 0.9 && m.emissive.b > 0.9) m.emissive.setRGB(0, 0, 0);
    });
  });
}

// ───────── built-in sample objects (so there is something to hold before importing) ─────────
const mat = (c, r = 0.6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
export const SAMPLES = {
  bottle: { label: 'Bottle', make() {
    const pts = [[0, 0], [0.034, 0], [0.036, 0.004], [0.036, 0.12], [0.03, 0.15], [0.013, 0.17], [0.012, 0.2], [0.014, 0.205], [0, 0.205]]
      .map(([x, y]) => new THREE.Vector2(x, y - 0.1));
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 32), mat(0x2f7a4a, 0.25, 0.1)));
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0365, 0.0365, 0.06, 32, 1, true, -0.9, 1.8), mat(0xe8dcc0, 0.8));
    label.position.y = -0.03; g.add(label); return g;
  } },
  handle: { label: 'Handle bar', make() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.16, 24), mat(0x3a3f4a, 0.5, 0.3)));
    [-1, 1].forEach(s => { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 24), mat(0xc84a3a)); c.position.y = s * 0.086; g.add(c); });
    return g;
  } },
  ball: { label: 'Ball', make() { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 32, 20), mat(0xd9862b, 0.7))); return g; } },
  box: { label: 'Box', make() { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.03), mat(0x4a78c8, 0.6))); return g; } },
  pistol: { label: 'Pistol grip', make() {
    const g = new THREE.Group(), m = mat(0x2b2d33, 0.45, 0.4);
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.03, 0.17), m); slide.position.set(0, 0.06, 0.04); g.add(slide);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.11, 0.04), mat(0x6b4a2f, 0.8)); grip.position.set(0, 0, -0.02); grip.rotation.x = -0.25; g.add(grip);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 8, 20, Math.PI), m); guard.rotation.y = Math.PI / 2; guard.rotation.z = Math.PI; guard.position.set(0, 0.045, 0.02); g.add(guard);
    const trig = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.018, 0.004), m); trig.position.set(0, 0.035, 0.018); g.add(trig);
    return g;
  } },
  none: { label: 'Nothing', make() { return new THREE.Group(); } },
};
