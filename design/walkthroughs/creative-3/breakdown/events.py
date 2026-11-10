# 从逐帧曲线切出事件（时间码到毫秒；分辨率 = 1 帧 ≈ 42ms）
import json, math, sys
src = sys.argv[1]; d = json.load(open(f'/tmp/mvp3/exp/breakdown-{src}.json')); fr = d['frames']; fps = d['fps']
def tc(ms): return f"{ms//1000:02d}.{ms%1000:03d}"
ev = []
def spans(name, flags, minlen=2, what=''):
    i = 0
    while i < len(flags):
        if flags[i]:
            j = i
            while j + 1 < len(flags) and flags[j + 1]: j += 1
            if j - i + 1 >= minlen: ev.append((fr[i]['ms'], fr[j]['ms'] + round(1000 / fps), name, what))
            i = j + 1
        else: i += 1
# 表情（第一张脸）
bs = [f['faces'][0]['bs'] if f['faces'] else None for f in fr]
g = lambda k, t: [b is not None and b.get(k, 0) > t for b in bs]
blink = [b is not None and (b['eyeBlinkLeft'] + b['eyeBlinkRight']) / 2 > .45 for b in bs]
spans('眨眼', blink, 1, 'eyeBlink>0.45')
spans('张嘴（说话 / 吸气）', g('jawOpen', .18), 2, 'jawOpen>0.18')
spans('微笑', [b is not None and (b['mouthSmileLeft'] + b['mouthSmileRight']) / 2 > .3 for b in bs], 3, 'mouthSmile>0.3')
spans('皱眉', [b is not None and (b['browDownLeft'] + b['browDownRight']) / 2 > .35 for b in bs], 3, 'browDown>0.35')
spans('抬眉', g('browInnerUp', .35), 3, 'browInnerUp>0.35')
spans('视线朝下', [b is not None and (b['eyeLookDownLeft'] + b['eyeLookDownRight']) / 2 > .45 for b in bs], 3, 'eyeLookDown>0.45')
# 头部转向（面部变换矩阵的偏航）
yaw = [math.degrees(math.atan2(f['faces'][0]['m'][8], f['faces'][0]['m'][10])) if f['faces'] and f['faces'][0]['m'] else None for f in fr]
yv = [y for y in yaw if y is not None]
# 身体（第一个人）：髋部中心位置、手腕高于肩、肩宽（侧身）
P = [f['poses'][0]['lm'] if f['poses'] else None for f in fr]
hip = [((p[23][0] + p[24][0]) / 2, (p[23][1] + p[24][1]) / 2) if p else None for p in P]
spd = [0] + [math.hypot(hip[i][0] - hip[i-1][0], hip[i][1] - hip[i-1][1]) * fps if hip[i] and hip[i-1] else 0 for i in range(1, len(hip))]
sm = [sum(spd[max(0, i-3):i+4]) / len(spd[max(0, i-3):i+4]) for i in range(len(spd))]
spans('走动', [s > .06 for s in sm], 4, '髋部画面速度>0.06/秒')
spans('站定', [s <= .03 for s in sm], 6, '髋部画面速度≤0.03/秒')
spans('抬手（手腕高过肩）', [p is not None and (p[15][1] < p[11][1] or p[16][1] < p[12][1]) for p in P], 3, 'wrist.y<shoulder.y')
sw = [abs(p[11][0] - p[12][0]) if p else None for p in P]
# 运镜
cam = [(f['ms'], f['cam']) for f in fr if f.get('cam')]
z = 1; camrows = []
for ms, q in cam:
    z *= q['scale']; camrows.append((ms, q['scale'], q['tx'], q['ty']))
push = [abs(r[1] - 1) > .003 and r[1] > 1 for r in camrows]
ev.sort()
out = {'src': src, 'fps': fps, 'frames': len(fr), 'events': [{'from': tc(a), 'to': tc(b), 'what': n, 'rule': w} for a, b, n, w in ev],
       'camera': {'zoom_total': round(z, 3), 'pan_total': round(sum(r[2] for r in camrows), 3), 'tilt_total': round(sum(r[3] for r in camrows), 3), 'steps': [{'at': tc(ms), 'scale': round(s, 4), 'tx': round(tx, 4), 'ty': round(ty, 4)} for ms, s, tx, ty in camrows]},
       'headYaw': {'min': round(min(yv), 1) if yv else None, 'max': round(max(yv), 1) if yv else None, 'series': [None if y is None else round(y, 1) for y in yaw][::3]},
       'coverage': {'pose': sum(1 for p in P if p), 'face': sum(1 for b in bs if b)}}
json.dump(out, open(f'/tmp/mvp3/exp/events-{src}.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: out[k] for k in ['coverage', 'headYaw']}, ensure_ascii=False)[:400]); print('camera', out['camera']['zoom_total'], out['camera']['pan_total'], out['camera']['tilt_total'])
for e in out['events']: print(e['from'], '→', e['to'], e['what'])
