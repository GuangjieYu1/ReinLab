/**
 * 场景模板与家具库（契约 §13.9）：前后端共用同一份清单。
 * 前端按 label 认家具、按外框参数拆成面/腿/牙板画；服务端用模板给导演搭初版白模。
 */

export type TemplatePrim = {
  label: string;
  kind: 'box' | 'cylinder';
  /** 底面中心（米，房间局部坐标）。 */
  c: [number, number, number];
  s: [number, number, number];
  rotY?: number;
  material?: string;
  color?: string | null;
  outside?: boolean;
  from?: 'shell' | 'layout' | 'author';
  key?: string;
};

/** 家具库名单（15 种）+ 默认外框尺寸（宽×高×深，米）。导演交白模时 label 用这些名字。 */
export const FURNITURE_NAMES: { name: string; size: [number, number, number] }[] = [
  { name: '八仙桌', size: [0.95, 0.82, 0.95] },
  { name: '长凳', size: [1.1, 0.46, 0.28] },
  { name: '方凳', size: [0.42, 0.46, 0.42] },
  { name: '椅', size: [0.5, 0.95, 0.5] },
  { name: '条案', size: [1.8, 0.85, 0.45] },
  { name: '柜台', size: [2.6, 1.0, 0.6] },
  { name: '货架', size: [1.6, 2.0, 0.35] },
  { name: '碗架', size: [1.0, 1.4, 0.35] },
  { name: '茶炉', size: [0.7, 0.9, 0.7] },
  { name: '屏风', size: [1.8, 1.8, 0.06] },
  { name: '门', size: [1.6, 2.4, 0.12] },
  { name: '窗', size: [1.2, 1.1, 0.08] },
  { name: '灯', size: [0.18, 0.4, 0.18] },
  { name: '坛', size: [0.44, 0.55, 0.44] },
  { name: '匾额', size: [1.6, 0.45, 0.06] },
];

/** 场景模板：客栈门厅（24 件）。按房间轮廓外接矩形摆，门在南墙正中。 */
export function innLobbyTemplate(outline: [number, number][], height: number): TemplatePrim[] {
  const xs = outline.map((point) => point[0]);
  const zs = outline.map((point) => point[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, H = height;
  const P = (label: string, kind: 'box' | 'cylinder', c: [number, number, number], s: [number, number, number], rotY = 0, material?: string, extra: Partial<TemplatePrim> = {}): TemplatePrim => ({ label, kind, c, s, rotY, ...(material ? { material } : {}), ...extra });
  const door = Math.min(1.8, W * 0.25), seg = (W - door) / 2;
  return [
    P('青砖地面', 'box', [cx, 0, cz], [W, 0.02, D], 0, 'stone'),
    P('北墙', 'box', [cx, 0, z0], [W, H, 0.2], 0, 'plaster'),
    P('西墙', 'box', [x0, 0, cz], [0.2, H, D], 0, 'plaster'),
    P('东墙', 'box', [x1, 0, cz], [0.2, H, D], 0, 'plaster'),
    P('南墙西段', 'box', [x0 + seg / 2, 0, z1], [seg, H, 0.2], 0, 'plaster'),
    P('南墙东段', 'box', [x1 - seg / 2, 0, z1], [seg, H, 0.2], 0, 'plaster'),
    P('临街大门', 'box', [cx, 0, z1], [door, Math.min(2.6, H - 0.3), 0.12], 0, 'wood'),
    P('门外石阶', 'box', [cx, 0, z1 + 0.9], [door + 1.2, 0.12, 1.4], 0, 'stone', { outside: true }),
    P('顶棚', 'box', [cx, H - 0.1, cz], [W, 0.1, D], 0, 'tile'),
    P('西墙花窗', 'box', [x0 + 0.12, 1.0, cz - D * 0.15], [1.2, 1.1, 0.08], 90, 'wood'),
    P('柜台', 'box', [x1 - 1.1, 0, z0 + D * 0.32], [Math.min(3.2, D * 0.45), 1.0, 0.6], 270, 'wood'),
    P('柜台后货架', 'box', [x1 - 0.3, 0, z0 + D * 0.32], [Math.min(3.4, D * 0.48), Math.min(2.2, H - 0.5), 0.35], 270, 'wood'),
    P('柜台油灯', 'box', [x1 - 1.1, 1.0, z0 + D * 0.32 - 0.6], [0.18, 0.4, 0.18], 0, 'wood'),
    P('酒坛', 'cylinder', [x1 - 1.0, 0, z0 + D * 0.32 + D * 0.26], [0.22, 0.55, 0], 0, 'stone'),
    P('茶炉', 'box', [x0 + 0.6, 0, z0 + 0.6], [0.7, 0.9, 0.7], 0, 'stone'),
    P('碗架', 'box', [x0 + 1.75, 0, z0 + 0.25], [1.0, 1.4, 0.35], 0, 'wood'),
    P('条案', 'box', [cx - W * 0.05, 0, z0 + 0.3], [Math.min(2.0, W * 0.22), 0.85, 0.45], 0, 'wood'),
    P('匾额', 'box', [cx - W * 0.05, H - 0.75, z0 + 0.12], [1.6, 0.45, 0.06], 0, 'wood'),
    ...[-1, 1].flatMap((i) => {
      const tx = cx + i * Math.min(1.5, W * 0.16) - W * 0.05;
      const tz = cz + D * 0.12;
      return [
        P(`八仙桌${i < 0 ? '一' : '二'}`, 'box', [tx, 0, tz], [0.95, 0.82, 0.95], 0, 'wood'),
        P(`长凳${i < 0 ? '一' : '三'}`, 'box', [tx, 0, tz - 0.75], [1.1, 0.46, 0.28], 0, 'wood'),
        P(`长凳${i < 0 ? '二' : '四'}`, 'box', [tx, 0, tz + 0.75], [1.1, 0.46, 0.28], 0, 'wood'),
      ];
    }),
  ];
}

export const TEMPLATES: { name: string; build: (outline: [number, number][], height: number) => TemplatePrim[] }[] = [
  { name: '客栈门厅', build: innLobbyTemplate },
];
