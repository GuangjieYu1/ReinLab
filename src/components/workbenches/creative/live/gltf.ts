// MVP-3：白模导出 glTF（契约 §13.6，前端做）。部件、人偶都带地点和人物 ID（extras），坐标和视口一致（米，y 向上）。
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { WhiteboxPrim } from '../../../../../packages/contracts/src/creative';
import { matOf, type Doll } from './Viewport3';

const RADIUS = { slim: .16, average: .2, heavy: .25 } as const;

export async function exportGlb(name: string, placeId: string, room: { outline: [number, number][]; height: number } | null, prims: WhiteboxPrim[], dolls: Doll[]) {
  const scene = new THREE.Scene(); scene.name = name; scene.userData = { placeId };
  for (const p of prims) {
    const geo = p.kind === 'box' ? new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]) : new THREE.CylinderGeometry(p.s[0], p.s[0], p.s[1], p.kind === 'cylinder' ? 24 : Math.max(3, p.sides ?? 6));
    const [r, g, b] = matOf(p.label, p), m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255), roughness: .9 })); m.name = p.label || p.id;
    m.position.set(p.c[0], p.c[1] + p.s[1] / 2, p.c[2]); m.rotation.y = ((p.rotY ?? 0) * Math.PI) / 180;
    m.userData = { primId: p.id, placeId, entityId: p.entityId ?? null, label: p.label ?? null };
    scene.add(m);
  }
  if (room) {
    const shape = new THREE.Shape(room.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0x8f8a80, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2; floor.name = '房间地面'; floor.userData = { placeId, roomHeight: room.height }; scene.add(floor);
  }
  for (const d of dolls) {
    const H = d.heightM || 1.7, r = RADIUS[d.build ?? 'average'], g = new THREE.Group(); g.name = d.name;
    const dollMat = new THREE.MeshStandardMaterial({ color: d.color ? new THREE.Color(d.color[0] / 255, d.color[1] / 255, d.color[2] / 255) : 0xb9b4aa, roughness: .9 });
    g.userData = { entityId: d.id, heightM: H, build: d.build };
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H * .34, 12), dollMat); torso.position.y = H * .48 + H * .17; torso.name = `${d.name}·躯干`;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(H * .065, H * .065, H * .13, 12), dollMat); head.position.y = H * .87 + H * .065; head.name = `${d.name}·头`;
    g.add(torso, head); g.position.set(d.at[0], 0, d.at[2]); g.rotation.y = -(d.facing * Math.PI) / 180; scene.add(g);
  }
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const a = document.createElement('a'); a.href = url; a.download = `${name}.glb`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  return glb.byteLength;
}
