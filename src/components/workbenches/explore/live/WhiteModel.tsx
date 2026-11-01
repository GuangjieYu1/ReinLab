import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Building, BuildingScene, LngLat, Stop } from '../../../../../packages/contracts/src/explore';
import { center } from './overlays';
import { hm, localToDate, sunPos } from './sunlive';

// 机位白模（09-explore-v2.md 第 7.4 节）：真实轮廓与高度立楼块；未知高度只画地面轮廓 + 标记，不补默认楼块；
// 视觉阴影只是示意，见光状态读服务端 light2（不读屏幕阴影）。局部米制：x 东、z 南（Three 习惯 -z 为北）、y 上。
// 点地面可以放模特站位 / 片区参考点（写回计划，服务端重算受光）；点楼看它的高度来源。

const FULL_FRAME = { wMm: 36, hMm: 24 };
const PAPER = 0xf0eeea, BLOCK = 0xe8e6e1, EDGE = 0x141213, ORANGE = 0xff7a1a, HIT = 0xffb27a;
const K = Math.PI / 180, R = 6371008.8;

/** 经纬度 ↔ 以 origin 为原点的米（东、北）。场景尺度（1 km）够用。 */
const toLocal = (o: LngLat, p: LngLat): [number, number] => [(p[0] - o[0]) * K * R * Math.cos(o[1] * K), (p[1] - o[1]) * K * R];
const toLngLat = (o: LngLat, x: number, y: number): LngLat => [o[0] + x / (K * R * Math.cos(o[1] * K)), o[1] + y / (K * R)];

/** "高度未知"标记：始终朝向屏幕的小牌子。 */
function unknownTag() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d')!; g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#141213'; g.font = '700 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('高度未知', 128, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
  sp.scale.set(0.16, 0.04, 1); sp.renderOrder = 2; return sp;
}

const SOURCE: Record<Building['heightSource'], string> = { tag: '标注高度', levels: '按层数估算', unknown: '高度未知' };

export default function WhiteModel({ scene, stop, day, tz, minutes, onMinutes, focals, sensor, orientation, cameraHeightM, subjectHeightM, highlight, pick, onPick }: {
  scene: BuildingScene; stop: Stop; day: string; tz: string; minutes: number; onMinutes: (m: number) => void;
  focals: number[]; sensor: { wMm: number; hMm: number } | null; orientation: 'portrait' | 'landscape';
  cameraHeightM: number; subjectHeightM: number;
  /** 此刻挡光的楼（light2.cause.buildingIds），标成橙色 */
  highlight: string[];
  /** 点地面放什么：模特站位 / 片区参考点；null = 点楼看信息 */
  pick: 'subject' | 'area' | null; onPick: (at: LngLat) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'orbit' | 'camera'>('orbit');
  const [focal, setFocal] = useState(focals[0] ?? 35);
  const [orient, setOrient] = useState(orientation);
  const [info, setInfo] = useState<Building | null>(null);
  useEffect(() => { if (focals.length && !focals.includes(focal)) setFocal(focals[0]); }, [focals.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOrient(orientation); }, [orientation]);
  type T = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; orbitCam: THREE.PerspectiveCamera; viewCam: THREE.PerspectiveCamera; sun: THREE.DirectionalLight;
    controls: OrbitControls; frustum: THREE.CameraHelper; camMark: THREE.Mesh; fig: THREE.Mesh; ground: THREE.Mesh; meshes: Map<string, THREE.Mesh>; dirty: () => void };
  const three = useRef<T | null>(null);

  const camAt = toLocal(scene.origin, center(stop));
  const subj = stop.subjectPoint ? toLocal(scene.origin, stop.subjectPoint) : null;
  const facing = (stop.facing ?? 0) * K;
  const sens = sensor ?? FULL_FRAME;
  // 竖拍时画面高对应传感器长边
  const vSensor = orient === 'portrait' ? sens.wMm : sens.hMm;
  const aspect = orient === 'portrait' ? 2 / 3 : 3 / 2;
  const vfov = 2 * Math.atan(vSensor / (2 * focal)) / K;
  const modeRef = useRef(mode); modeRef.current = mode;
  const pickRef = useRef(pick); pickRef.current = pick;
  const onPickRef = useRef(onPick); onPickRef.current = onPick;

  // 建场景（场景数据变了才重建）。按需重画：拖动、改参数时才画一帧
  useEffect(() => {
    const el = box.current!; const w = el.clientWidth, h = el.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio)); renderer.setSize(w, h); renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    const sc = new THREE.Scene(); sc.background = new THREE.Color(PAPER);
    sc.add(new THREE.HemisphereLight(0xffffff, 0xe8e4dc, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, near: 1, far: 3000 });
    sc.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(scene.radiusM * 2.4, scene.radiusM * 2.4), new THREE.MeshLambertMaterial({ color: PAPER }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; sc.add(ground);

    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 });
    const unknownMat = new THREE.LineDashedMaterial({ color: ORANGE, dashSize: 3, gapSize: 2 });
    const blockMat = new THREE.MeshLambertMaterial({ color: BLOCK });
    const meshes = new Map<string, THREE.Mesh>();
    // "高度未知"牌子只挂离机位最近的 12 栋（其余靠橙色轮廓），楼多时不糊成一片
    const near = new Set(scene.buildings.filter(b => b.heightM === null)
      .map(b => ({ id: b.id, d: Math.hypot(b.footprint[0][0] - camAt[0], b.footprint[0][1] - camAt[1]) })).filter(x => x.d < 250)
      .sort((a, b) => a.d - b.d).slice(0, 12).map(x => x.id));
    for (const b of scene.buildings) {
      const shape = new THREE.Shape(b.footprint.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const hole of b.holes ?? []) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      if (b.heightM === null) {
        // 高度未知：只画地面轮廓（橙色虚线 + 淡橙底），不补默认楼块
        const pts = b.footprint.map(([x, y]) => new THREE.Vector3(x, 0.3, -y));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), unknownMat); line.computeLineDistances(); sc.add(line);
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
        fill.rotation.x = -Math.PI / 2; fill.position.y = 0.2; fill.userData.b = b; sc.add(fill); meshes.set(b.id, fill);
        // 楼多时牌子会糊成一片：只给 300 m 内的挂
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
        if (near.has(b.id)) { const tag = unknownTag(); tag.position.set(cx, 4, cz); sc.add(tag); }
        continue;
      }
      const height = Math.max(0.5, b.heightM - b.minHeightM);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);   // 挤出方向朝上；shape 的 y（北）变成 -z
      const mesh = new THREE.Mesh(geo, blockMat);
      mesh.position.y = (b.baseM ?? 0) + b.minHeightM; mesh.castShadow = mesh.receiveShadow = true; mesh.userData.b = b; sc.add(mesh); meshes.set(b.id, mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat); edges.position.copy(mesh.position); sc.add(edges);
    }

    // 机位、模特标记（位置在下面的 effect 里跟着计划更新）
    const camMark = new THREE.Mesh(new THREE.ConeGeometry(2.2, 5, 4), new THREE.MeshBasicMaterial({ color: EDGE }));
    camMark.rotation.x = Math.PI; sc.add(camMark);
    const fig = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 12), new THREE.MeshLambertMaterial({ color: ORANGE }));
    fig.castShadow = true; sc.add(fig);

    const orbitCam = new THREE.PerspectiveCamera(45, w / h, 1, 5000);
    orbitCam.position.set(camAt[0] - 160, 180, -camAt[1] + 200);
    const controls = new OrbitControls(orbitCam, renderer.domElement);
    controls.target.set(camAt[0], 0, -camAt[1]); controls.maxPolarAngle = Math.PI / 2 - 0.02; controls.update();
    const viewCam = new THREE.PerspectiveCamera(vfov, aspect, 0.3, 3000);
    const frustum = new THREE.CameraHelper(viewCam); sc.add(frustum);

    let raf = 0;
    const draw = () => { raf = 0; const t = three.current; if (t) t.renderer.render(t.scene, modeRef.current === 'camera' ? t.viewCam : t.orbitCam); };
    const dirty = () => { if (!raf) raf = requestAnimationFrame(draw); };
    controls.addEventListener('change', dirty);
    three.current = { renderer, scene: sc, orbitCam, viewCam, sun, controls, frustum, camMark, fig, ground, meshes, dirty };

    // 点地面 / 点楼：按下和抬起离得近才算点击（拖动旋转不算）
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || modeRef.current !== 'orbit') return;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, orbitCam);
      if (pickRef.current) {
        const hit = ray.intersectObject(ground)[0];
        if (hit) onPickRef.current(toLngLat(scene.origin, hit.point.x, -hit.point.z));
        return;
      }
      const hit = ray.intersectObjects([...meshes.values()])[0];
      setInfo((hit?.object.userData.b as Building | undefined) ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    const ro = new ResizeObserver(() => { const W = el.clientWidth, H = el.clientHeight; renderer.setSize(W, H); orbitCam.aspect = W / H; orbitCam.updateProjectionMatrix(); dirty(); });
    ro.observe(el);
    dirty();
    return () => {
      if (raf) cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.dispose(); el.removeChild(renderer.domElement); three.current = null;
    };
  }, [scene.id, scene.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // 机位 / 模特标记、机位视角：站位、离地高度、朝向、焦段 / 传感器
  useEffect(() => {
    const t = three.current; if (!t) return;
    t.camMark.position.set(camAt[0], cameraHeightM + 2.5, -camAt[1]);
    t.fig.visible = !!subj;
    if (subj) { t.fig.scale.y = subjectHeightM; t.fig.position.set(subj[0], subjectHeightM / 2, -subj[1]); }
    const c = t.viewCam; c.fov = vfov; c.aspect = aspect; c.updateProjectionMatrix();
    c.position.set(camAt[0], cameraHeightM, -camAt[1]);
    c.lookAt(camAt[0] + Math.sin(facing) * 100, cameraHeightM, -camAt[1] - Math.cos(facing) * 100);
    t.frustum.update(); t.frustum.visible = mode === 'orbit';
    t.controls.enabled = mode === 'orbit';
    t.dirty();
  }, [vfov, aspect, cameraHeightM, subjectHeightM, facing, mode, camAt[0], camAt[1], subj?.[0], subj?.[1], scene.id, scene.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // 挡光的楼标橙
  useEffect(() => {
    const t = three.current; if (!t) return;
    const hitMat = new THREE.MeshLambertMaterial({ color: HIT });
    const touched: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    for (const id of highlight) { const m = t.meshes.get(id); if (m && m.geometry.type === 'ExtrudeGeometry') { touched.push([m, m.material]); m.material = hitMat; } }
    t.dirty();
    return () => { for (const [m, mat] of touched) m.material = mat; hitMat.dispose(); three.current?.dirty(); };
  }, [highlight.join(), scene.id, scene.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // 太阳：和第一版同一约定（真北顺时针）；地平线以下不画直射光
  const sp = sunPos(localToDate(day, minutes, tz), scene.origin[0], scene.origin[1]);
  useEffect(() => {
    const t = three.current; if (!t) return;
    const az = sp.az * K, alt = sp.alt * K;
    t.sun.visible = sp.alt > 0;
    t.sun.position.set(camAt[0] + Math.sin(az) * Math.cos(alt) * 1500, Math.sin(alt) * 1500, -camAt[1] - Math.cos(az) * Math.cos(alt) * 1500);
    t.sun.target.position.set(camAt[0], 0, -camAt[1]);
    t.dirty();
  }, [sp.az, sp.alt, scene.id, scene.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const unknown = scene.buildings.filter(b => b.heightM === null).length;
  const estimated = scene.buildings.filter(b => b.heightSource === 'levels').length;
  const allFocals = [...new Set([...focals, focal])].sort((a, b) => a - b);
  return <div className="exw">
    <div className="exw-tools">
      <div className="ex-seg"><button aria-pressed={mode === 'orbit'} onClick={() => setMode('orbit')}>环绕</button><button aria-pressed={mode === 'camera'} onClick={() => setMode('camera')}>机位视角</button></div>
      <select value={focal} onChange={e => setFocal(Number(e.target.value))} aria-label="焦段">{allFocals.map(f => <option key={f} value={f}>{f}mm</option>)}</select>
      <button className="dm-link" onClick={() => setOrient(o => o === 'portrait' ? 'landscape' : 'portrait')}>{orient === 'portrait' ? '竖 2:3' : '横 3:2'}</button>
      <span>离地 {cameraHeightM} m{sensor ? ` · 传感器 ${sensor.wMm}×${sensor.hMm}` : ' · 按全画幅假设'}</span>
      <span>太阳 {Math.round(sp.az)}° / {sp.alt.toFixed(1)}°{sp.alt <= 0 ? ' · 地平线下' : ''}</span>
    </div>
    <div className="exw-stage" ref={box} data-mode={mode} data-pick={pick ?? undefined} style={mode === 'camera' ? { aspectRatio: String(aspect), width: `min(100%, ${Math.round(520 * aspect)}px)` } : undefined}>
      {mode === 'camera' && <div className="exw-frame"><i className="v1" /><i className="v2" /><i className="h1" /><i className="h2" /></div>}
      {pick && mode === 'orbit' && <div className="exw-pickhint">在地面上点一下，放{pick === 'subject' ? '模特站位' : '片区参考点'}</div>}
      {info && !pick && mode === 'orbit' && <div className="exw-info">
        <b>{info.osm}</b>
        <span>{info.heightM === null ? '高度未知（只画轮廓）' : `${info.heightM.toFixed(1)} m · ${SOURCE[info.heightSource]}`}{info.minHeightM ? ` · 离地 ${info.minHeightM} m 起` : ''}</span>
        <small>{info.basis}</small>
        <button className="dm-link" onClick={() => setInfo(null)}>关</button>
      </div>}
    </div>
    <input className="exw-time" type="range" min={300} max={1260} step={5} value={minutes} onChange={e => onMinutes(Number(e.target.value))} aria-label="时间" />
    <p className="exw-note">
      {hm(minutes)} · {scene.buildings.length} 栋楼（{estimated} 栋按层数估算高度，{unknown} 栋高度未知只画轮廓）· 范围 {scene.radiusM} m · {scene.source}
      {scene.coverage.status !== 'ok' && <b> · {scene.coverage.status === 'empty' ? '这一带没取到建筑数据（不代表没有楼）' : scene.coverage.status === 'failed' ? `建筑数据没取到${scene.coverage.note ? `：${scene.coverage.note}` : ''}` : `数据不全：${scene.coverage.note}`}</b>}
      <br />点楼看高度来源。阴影只是示意；见光状态以上面的受光提示为准，橙色的是此刻挡光的楼。
    </p>
  </div>;
}
