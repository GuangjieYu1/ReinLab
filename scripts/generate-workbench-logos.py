# -*- coding: utf-8 -*-
"""Build concrete workbench identities within the supplied template's rings."""
from __future__ import annotations

import argparse
import copy
import math
import re
from pathlib import Path
import xml.etree.ElementTree as ET

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
OUT = Path(__file__).resolve().parents[1] / 'public' / 'workbench-logos'


def times(values):
    return ';'.join(f'{v / 6.4:.5f}' for v in values)


def fade(start, end):
    return f'<animate attributeName="opacity" dur="6.4s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="{times([0, start, end, 5.62, 6.22, 6.4])}" calcMode="spline" keySplines="0 0 1 1;.16 1 .3 1;0 0 1 1;.4 0 .8 1;0 0 1 1"/>'


def assemble(markup, start=.7, end=1.65, offset=(0, 8)):
    x, y = offset
    translation = f'<animateTransform attributeName="transform" type="translate" dur="6.4s" repeatCount="indefinite" values="{x} {y};{x} {y};0 0;0 0;{x} {-y};{x} {-y}" keyTimes="{times([0, start, end, 5.62, 6.22, 6.4])}" calcMode="spline" keySplines="0 0 1 1;.16 1 .3 1;0 0 1 1;.4 0 .8 1;0 0 1 1"/>'
    return f'<g>{fade(start, end)}{translation}{markup}</g>'


def draw(d, start=.75, end=1.7, width=2.7, color='ink'):
    return f'<path d="{d}" fill="none" stroke="var(--{color})" stroke-width="{width}" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" dur="6.4s" repeatCount="indefinite" values="100;100;0;0;100;100" keyTimes="{times([0, start, end, 5.82, 6.31, 6.4])}" calcMode="spline" keySplines="0 0 1 1;.2 .7 .2 1;0 0 1 1;.4 0 .8 1;0 0 1 1"/></path>'


def pulse(markup, start, end):
    return f'<g opacity="0"><animate attributeName="opacity" dur="6.4s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="{times([0, start, start + .16, end - .12, end, 6.4])}"/>{markup}</g>'


def packet(d, start, end):
    return f'<g opacity="0"><animate attributeName="opacity" dur="6.4s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="{times([0, start - .08, start, end, end + .08, 6.4])}"/><rect x="-3" y="-3" width="6" height="6" fill="var(--accent)"><animateMotion path="{d}" dur="6.4s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="{times([0, start, end, 6.4])}" calcMode="linear"/></rect></g>'


def engineering():
    # A code editor is the primary silhouette; a moving cog conveys building.
    core = draw('M224 166V99H80V212H177', .45, 1.48, 5.2)
    core += draw('M82 130H222', .68, 1.5, 2)
    core += assemble('<rect x="95" y="112" width="5" height="5" fill="var(--ink)"/><rect x="108" y="112" width="5" height="5" fill="var(--ink)"/><rect x="121" y="112" width="5" height="5" fill="var(--accent)"/>', .64, 1.45, (0, 0))
    core += draw('M125 149L108 168L125 187', .83, 1.68, 6.4)
    core += draw('M162 147L144 190', 1.05, 1.89, 6.4)
    core += draw('M181 149L198 168L181 187', 1.25, 2.08, 6.4)
    points = []
    for i in range(8):
        for angle, radius in [(i*45-13, 22), (i*45-11, 28), (i*45+11, 28), (i*45+13, 22)]:
            theta = math.radians(angle)
            points.append((213 + radius*math.cos(theta), 207 + radius*math.sin(theta)))
    outline = 'M' + 'L'.join(f'{x:.2f} {y:.2f}' for x, y in points) + 'Z'
    gear = f'<path d="{outline} M223 207A10 10 0 1 0 203 207A10 10 0 1 0 223 207Z" fill="var(--ink)" fill-rule="evenodd"/><rect x="210" y="204" width="6" height="6" fill="var(--accent)"/>'
    rotation = f'<animateTransform attributeName="transform" type="rotate" dur="6.4s" repeatCount="indefinite" values="0 213 207;0 213 207;45 213 207;45 213 207;0 213 207;0 213 207" keyTimes="{times([0, 2.42, 3.72, 5.6, 6.24, 6.4])}" calcMode="spline" keySplines="0 0 1 1;.2 .7 .2 1;0 0 1 1;.4 0 .8 1;0 0 1 1"/>'
    core += assemble(f'<g>{rotation}{gear}</g>', 1.3, 2.18, (8, 8))
    core += draw('M94 199L100 205L112 193', 2.85, 3.74, 2.5, 'accent')
    core += pulse('<path d="M162 147L144 190" stroke="var(--accent)" stroke-width="6.4"/>', 2.45, 3.1)
    core += assemble('<path d="M129 254H191" stroke="var(--ink)" stroke-width="1.4"/><rect x="153" y="263" width="14" height="2" fill="var(--accent)"/>', 1.7, 2.24, (0, 0))
    return core


def creative():
    core = draw('M83 127V108H151 M204 108H229V133 M229 179V222H83V166', .5, 1.5, 5.2)
    core += draw('M72 140H94 M83 129V151 M218 231H240 M229 220V242', .75, 1.7, 1.4, 'muted')
    core += assemble('<path d="M101 144h44v5h-44z M101 156h30v3h-30z" fill="var(--ink)"/><rect x="101" y="167" width="14" height="3" fill="var(--accent)"/>', .8, 1.72, (-8, 0))
    core += draw('M100 204L130 175L149 194L171 174L197 201', 1.05, 2.03, 3.2)
    # A carved channel keeps the nib transparent in both color modes.
    pen = '<path d="M137 197L146 166L207 105L231 129L170 190Z M157 171L163 177L217 123L211 117Z" fill="var(--ink)" fill-rule="evenodd"/><path d="M137 197L142 180L154 192Z" fill="var(--accent)"/><path d="M201 111L225 135" stroke="var(--muted)" stroke-width="1.4"/>'
    core += assemble(pen, .97, 1.95, (10, -10))
    core += draw('M114 233Q157 220 199 233', 2.15, 3.04, 2.5, 'accent')
    core += packet('M114 233Q157 220 199 233', 2.6, 3.7)
    core += pulse('<rect x="101" y="167" width="14" height="3" fill="var(--accent)"/><path d="M137 197L142 180L154 192Z" fill="var(--accent)"/>', 3.68, 4.3)
    core += assemble('<path d="M129 254H191" stroke="var(--ink)" stroke-width="1.4"/><rect x="153" y="263" width="14" height="2" fill="var(--accent)"/>', 1.7, 2.24, (0, 0))
    return core


def automation():
    # Time triggers a robot, which turns the task into a checked deliverable.
    core = draw('M99 107H172Q184 107 184 119V183Q184 195 172 195H99Q87 195 87 183V119Q87 107 99 107Z', .5, 1.55, 5.2)
    core += draw('M135 107V85 M117 196V209H153V196', .75, 1.75, 4.2)
    core += assemble('<rect x="77" y="133" width="7" height="26" fill="var(--ink)"/><rect x="188" y="133" width="7" height="26" fill="var(--ink)"/><circle cx="135" cy="80" r="4" fill="var(--accent)"/>', .75, 1.65, (0, 0))
    core += assemble('<rect x="108" y="136" width="13" height="13" fill="var(--ink)"/><rect x="150" y="136" width="13" height="13" fill="var(--ink)"/><path d="M113 170H157V180H113Z M116 173V177H154V173Z" fill="var(--ink)" fill-rule="evenodd"/><path d="M127 172V179 M143 172V179" stroke="var(--ink)" stroke-width="2"/>', .92, 1.85, (0, 4))
    clock = '<circle cx="219" cy="107" r="17" stroke="var(--ink)" stroke-width="2.7" fill="none"/><path d="M219 96V107L228 112" fill="none" stroke="var(--ink)" stroke-width="2.7"/><circle cx="219" cy="107" r="2" fill="var(--accent)"/>'
    core += assemble(clock, 1.05, 1.92, (8, -7))
    core += draw('M199 107H189 M170 207H187V202H196', 1.6, 2.24, 1.7)
    core += assemble('<path d="M189 198L197 202L189 206Z" fill="var(--ink)"/>', 1.6, 2.24, (0, 0))
    core += draw('M201 169H230L244 183V237H201Z M230 169V183H244', 1.2, 2.17, 3.4)
    core += draw('M210 187H223 M210 226H232', 1.55, 2.24, 1.3, 'muted')
    core += packet('M201 107H184', 2.45, 2.92)
    core += pulse('<rect x="108" y="136" width="13" height="13" fill="var(--accent)"/><rect x="150" y="136" width="13" height="13" fill="var(--accent)"/>', 2.84, 3.48)
    core += packet('M170 207H187V202H196', 3.08, 3.55)
    core += draw('M210 208L218 216L235 197', 3.42, 4.22, 4.4, 'accent')
    core += assemble('<path d="M129 254H191" stroke="var(--ink)" stroke-width="1.4"/><rect x="153" y="263" width="14" height="2" fill="var(--accent)"/>', 1.7, 2.24, (0, 0))
    return core


def research():
    # The eyepiece, specimen stage, curved arm and base form a microscope.
    arm = '<path d="M185 111C224 113 245 148 234 184C228 205 213 219 194 225V235H162V222C193 218 218 198 222 175C226 152 213 135 185 130Z" fill="var(--ink)"/>'
    core = assemble(arm, .63, 1.72, (9, 6))
    core += assemble('<path d="M115 228H198L221 242H98Z" fill="var(--ink)"/><path d="M110 232H197" stroke="var(--muted)" stroke-width="1.3"/>', .7, 1.7, (0, 8))
    optics = '<path d="M115 83L145 66L156 85L125 103Z M123 83L142 72L147 80L128 91Z" fill="var(--ink)" fill-rule="evenodd"/><path d="M128 97L151 84L182 135L159 148Z M139 98L147 93L170 130L161 135Z" fill="var(--ink)" fill-rule="evenodd"/><path d="M164 148L181 138L189 151L171 162Z" fill="var(--ink)"/>'
    core += assemble(optics, .82, 1.91, (-8, -8))
    core += assemble('<circle cx="190" cy="124" r="11" fill="var(--ink)"/><circle cx="190" cy="124" r="4" fill="var(--accent)"/>', 1.1, 1.98, (0, 0))
    core += draw('M113 184H195 M125 184V192 M183 184V192', 1.1, 2.02, 4.8)
    sample = '<ellipse cx="173" cy="176" rx="17" ry="4" fill="none" stroke="var(--ink)" stroke-width="1.8"/><path d="M156 176V180Q173 187 190 180V176" fill="none" stroke="var(--ink)" stroke-width="1.5"/><circle cx="173" cy="175" r="2.8" fill="var(--accent)"/>'
    core += assemble(sample, 1.48, 2.3, (-12, 0))
    core += pulse('<path d="M176 161L166 173 M178 162L181 173" stroke="var(--accent)" stroke-width="1.4"/><ellipse cx="173" cy="175" rx="9" ry="2" fill="var(--accent)"/>', 2.75, 3.75)
    core += pulse('<circle cx="190" cy="124" r="4" fill="var(--accent)"/><circle cx="173" cy="175" r="4" fill="var(--accent)"/>', 3.88, 4.45)
    core += assemble('<path d="M129 254H191" stroke="var(--ink)" stroke-width="1.4"/><rect x="153" y="263" width="14" height="2" fill="var(--accent)"/>', 1.7, 2.24, (0, 0))
    return core


def exploration():
    core = draw('M82 118L131 100L181 118L233 99V214L182 232L132 214L82 232Z M131 100V214 M181 118V232', .65, 1.7, 3.6)
    core += assemble('<path d="M160 85C142 85 134 98 134 111C134 130 160 151 160 151S186 130 186 111C186 98 178 85 160 85Z M160 99A11 11 0 1 0 160 121A11 11 0 1 0 160 99Z" fill="var(--ink)" fill-rule="evenodd"/><circle cx="160" cy="110" r="3" fill="var(--accent)"/>', .85, 1.85, (0,-8))
    core += draw('M101 205L116 185L145 198L168 174L205 185', 1.2, 2.2, 2.2, 'accent')
    core += packet('M101 205L116 185L145 198L168 174L205 185', 2.5, 4.0)
    core += assemble('<circle cx="205" cy="185" r="5" fill="var(--ink)"/><path d="M128 254H192" stroke="var(--ink)" stroke-width="1.4"/>', 1.3, 2.2, (0,0))
    return core


DESIGNS = [
    ('research', '实验研究工作台', 'RESEARCH WORKBENCH', '02 / RESEARCH', 'EXPERIMENT SYSTEM', '样本归位 / 镜下观测 / 实验验证', research),
    ('engineering', '工程开发工作台', 'ENGINEERING STUDIO', '03 / ENGINEERING', 'PRODUCTION SYSTEM', '编写代码 / 构建运行 / 工程交付', engineering),
    ('creative', '创作工作台', 'CREATIVE STUDIO', '04 / CREATIVE', 'CONTENT SYSTEM', '画幅展开 / 笔迹生成 / 作品成形', creative),
    ('automation', '自动化工作台', 'AUTOMATION STUDIO', '05 / AUTOMATION', 'WORKFLOW SYSTEM', '定时触发 / 机器人执行 / 任务完成', automation),
]

STYLE = '''.rhine-mark{--ink:#252E2B;--accent:#AC985A;--muted:#A2AA9B;shape-rendering:geometricPrecision}.rhine-mark .still{display:none}@media(prefers-reduced-motion:reduce){.rhine-mark .motion{display:none}.rhine-mark .still{display:inline}}'''


def serialize(element):
    return ET.tostring(element, encoding='unicode')


def make_svg(template, name, core):
    motion = template.find(f'{{{NS}}}g[@class="motion"]')
    base = ''.join(serialize(copy.deepcopy(x)) for x in list(motion)[:6])
    still_base = ''.join(serialize(copy.deepcopy(x)) for x in list(template.find(f'{{{NS}}}g[@class="still"]'))[:5])
    static_core = ET.fromstring(f'<g xmlns="{NS}">{core}</g>')
    for element in list(static_core.iter()):
        for child in list(element):
            if child.tag.rsplit('}', 1)[-1].startswith('animate'):
                element.remove(child)
    still = still_base + ''.join(serialize(x) for x in static_core)
    description = '原创几何标识。透明背景，6.4 秒装配、信号传递、停留与归位；减少动态效果时显示静态版本。'
    animated = f'<svg xmlns="{NS}" class="rhine-mark" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="{name}"><title>{name}</title><desc>{description}</desc><style>{STYLE}</style><g class="motion">{base}{core}</g><g class="still">{still}</g></svg>'
    static = f'<svg xmlns="{NS}" class="rhine-mark" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="{name} 静态标识"><title>{name}</title><style>.rhine-mark{{--ink:#252E2B;--accent:#AC985A;--muted:#A2AA9B;shape-rendering:geometricPrecision}}</style>{still}</svg>'
    ET.fromstring(animated)
    ET.fromstring(static)
    return animated, static


def card(key, name, english, code, tag, meaning, svg, download=True):
    downloads = f'<div class="downloads"><a href="{key}.svg" download>动态 SVG ↗</a><a href="{key}-static.svg" download>静态 SVG ↗</a></div>' if download else ''
    return f'<article class="card"><div class="card-top"><span>{code}</span><span class="tag">{tag}</span></div><div class="icon-slot">{svg}</div><h2>{name}</h2><p class="english">{english}</p><p class="meaning">{meaning}</p>{downloads}</article>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--template', type=Path)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.template:
        document = args.template.read_text()
        originals = re.findall(r'<svg\b.*?</svg>', document, re.S)
        if len(originals) != 2:
            raise ValueError('Expected the supplied two-mark template')
        template_css = re.search(r'<style>(.*?)</style>', document, re.S).group(1)
        (OUT / 'template.css').write_text(template_css)
        for key, svg in zip(['curriculum', 'research-template'], originals):
            ET.fromstring(svg)
            (OUT / f'{key}.svg').write_text(svg)
    else:
        originals = [(OUT / f'{key}.svg').read_text() for key in ['curriculum', 'research-template']]
        template_css = (OUT / 'template.css').read_text()
    template = ET.fromstring(originals[0])
    cards = []
    creative_card = ''
    for key, name, english, code, tag, meaning, builder in DESIGNS:
        ring = ET.fromstring(originals[1]) if key == 'research' else template
        animated, static = make_svg(ring, name, builder())
        (OUT / f'{key}.svg').write_text(animated)
        (OUT / f'{key}-static.svg').write_text(static)
        rendered = card(key, name, english, code, tag, meaning, animated)
        if key == 'creative':
            creative_card = rendered
        else:
            cards.append(rendered)
    original_cards = card('curriculum', '学科课程工作室', 'CURRICULUM STUDIO', '01 / EDUCATION', 'CURRICULUM SYSTEM', '书页展开 / 知识连接 / 课程成形', originals[0], False)
    original_cards += creative_card
    for suffix, source in zip(['', '-static'], make_svg(template, '规划探索工作台', exploration())):
        (OUT / f'exploration{suffix}.svg').write_text(source)
    native_assets = OUT.parents[1] / 'src' / 'assets' / 'workbench-logos'
    native_assets.mkdir(parents=True, exist_ok=True)
    for key in ['curriculum', 'research', 'engineering', 'creative', 'automation', 'exploration']:
        (native_assets / f'{key}.svg').write_bytes((OUT / f'{key}.svg').read_bytes())
    document = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReinLab · 工作台动态标识</title><style>''' + template_css + '''
.sheet{width:min(1320px,100%)}.cards.new-marks{grid-template-columns:repeat(3,minmax(0,1fr))}.card{padding:21px 24px 25px}.icon-slot{width:320px;height:auto;aspect-ratio:1}.downloads{display:flex;justify-content:center;gap:18px;margin-top:19px}.downloads a{font-size:10px;color:#77806F;text-decoration:none;border-bottom:1px solid #C9CDBF;padding-bottom:3px}.downloads a:hover{color:#252E2B;border-color:#252E2B}.reference-label{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:40px 0 17px}.reference-label h2{font-size:15px;letter-spacing:2px;margin:0;text-align:left}.reference-label span{font-size:9px;color:#78806E;letter-spacing:1.4px}.references .icon-slot{width:270px}.transport{display:flex;align-items:center;gap:17px;padding:16px 0;color:#7B8275;font-size:10px;letter-spacing:1px}.transport label{white-space:nowrap}.transport input{min-width:40px;flex:1;accent-color:#AC985A;height:2px;cursor:ew-resize}.transport output{font-variant-numeric:tabular-nums;white-space:nowrap}.transport .phase{min-width:48px;text-align:right}.controls{flex-wrap:wrap;justify-content:flex-end}.controls button[aria-pressed="true"]{background:#252E2B;color:#F5F4ED;border-color:#252E2B}.controls button:disabled{opacity:.45;cursor:default}body[data-motion="still"] .rhine-mark .motion{display:none}body[data-motion="still"] .rhine-mark .still{display:inline}body[data-motion="still"] .transport input{opacity:.45}.card-top{font-size:9px;letter-spacing:1.2px}.card-top .tag{font-size:8px;letter-spacing:.8px}h2{font-size:22px}.meaning{font-size:11px;letter-spacing:.7px}.sub{line-height:1.8}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #AC985A;outline-offset:4px}footer{gap:20px}.ticks{flex-shrink:0}body[data-capture] .controls{visibility:hidden}body[data-capture] .references,body[data-capture] .reference-label,body[data-capture] .help,body[data-capture] .transport{display:none}body[data-capture] .downloads{visibility:hidden}body[data-capture] .sheet{padding-bottom:30px}
@media(max-width:1050px) and (min-width:761px){.sheet{padding:30px 28px}.card{padding:18px 15px}.card-top{flex-direction:column;gap:7px}.card-top .tag{font-size:8px}h2{font-size:19px;letter-spacing:1px}.meaning{font-size:10px}}
@media(max-width:760px){.cards.new-marks{grid-template-columns:1fr}.card+.card{border-left:0}.controls{justify-content:flex-start}.card-top{font-size:10px}.card-top .tag{font-size:9px}.reference-label{align-items:flex-start;flex-direction:column;gap:8px}.icon-slot{width:300px;height:auto}footer{align-items:flex-start;flex-direction:column}.kicker{flex-wrap:wrap;gap:10px}.card{padding:20px 16px}h2{font-size:22px}.transport{gap:10px}}
</style></head><body data-palette="rhine" data-motion="animated"><main class="sheet"><div class="kicker"><span>REINLAB / WORKBENCH MOTION IDENTITIES</span><span class="status"><i class="signal"></i>VECTOR STUDY 03</span></div><header><div><h1>研究 · 工程 · 自动化</h1><p class="sub">INSTITUTIONAL FORMS · RHINE-INSPIRED</p></div><div class="controls"><button type="button" id="toggle" aria-label="暂停全部标识动画">暂停</button><button type="button" id="replay">重新播放</button><button type="button" id="still" aria-pressed="false">静态展示</button><button type="button" id="mono" aria-pressed="false">纯黑白</button></div></header><section class="cards new-marks" aria-label="研究、工程与自动化标识">''' + ''.join(cards) + '''</section><div class="transport"><label for="timeline">动画进度</label><input id="timeline" type="range" min="0" max="6.4" step="0.01" value="0" aria-label="动画进度，单位秒"><output id="time" aria-live="off">00.00 / 06.40 s</output><span id="phase" class="phase">装配</span></div><div class="reference-label"><h2>课程与创作 · 系列对照</h2><span>CURRICULUM & CREATIVE / SAME FAMILY</span></div><section class="cards references" aria-label="课程与创作标识参考">''' + original_cards + '''</section><footer><div class="footnote">GEOMETRIC ASSEMBLY / SIGNAL PASS / HOLD / RESET<br>原创符号 · 透明矢量 · 同步动效 · 无外部依赖</div><div class="ticks">''' + '<i></i>' * 20 + '''<span class="speed">06.4 S / LOOP</span></div></footer></main><p class="help">研究采用显微镜与样本，工程采用代码窗口与齿轮，自动化采用机器人与任务单。沿用原模板的圆环、配色与 6.4 秒循环。每枚修订标识提供动态及静态 SVG。系统开启“减少动态效果”时自动显示静态版本。</p>
<script>
const marks=[...document.querySelectorAll('svg.rhine-mark')];
const toggle=document.getElementById('toggle'),replay=document.getElementById('replay'),mono=document.getElementById('mono'),still=document.getElementById('still'),timeline=document.getElementById('timeline'),time=document.getElementById('time'),phase=document.getElementById('phase');
const preference=matchMedia('(prefers-reduced-motion:reduce)');let paused=false,staticMode=false;
function pauseAll(){marks.forEach(s=>s.pauseAnimations());paused=true;toggle.textContent='播放';toggle.setAttribute('aria-label','播放全部标识动画');}
function playAll(){if(preference.matches)return;marks.forEach(s=>s.unpauseAnimations());paused=false;toggle.textContent='暂停';toggle.setAttribute('aria-label','暂停全部标识动画');}
function updateTime(t){timeline.value=t;time.textContent=t.toFixed(2).padStart(5,'0')+' / 06.40 s';phase.textContent=staticMode?'静态':t<2.4?'装配':t<4.45?'信号':t<5.6?'停留':'归位';}
function setFrame(t){const frame=Math.max(0,Math.min(6.4,Number(t)||0));pauseAll();marks.forEach(s=>s.setCurrentTime(frame));updateTime(frame);}
function setStatic(next){staticMode=next;document.body.dataset.motion=next?'still':'animated';still.setAttribute('aria-pressed',String(next));still.textContent=next?'动态展示':'静态展示';timeline.disabled=next;toggle.disabled=next;replay.disabled=next;if(next){pauseAll();updateTime(marks[0].getCurrentTime()%6.4);}else{marks.forEach(s=>s.setCurrentTime(0));playAll();}}
toggle.onclick=()=>paused?playAll():pauseAll();replay.onclick=()=>{marks.forEach(s=>s.setCurrentTime(0));playAll();};still.onclick=()=>setStatic(!staticMode);
mono.onclick=()=>{const isMono=document.body.dataset.palette!=='mono';document.body.dataset.palette=isMono?'mono':'rhine';mono.setAttribute('aria-pressed',String(isMono));mono.textContent=isMono?'莱茵配色':'纯黑白';};
timeline.addEventListener('input',()=>setFrame(timeline.value));window.setFrame=setFrame;
function applyPreference(){still.disabled=preference.matches;setStatic(preference.matches);if(preference.matches)still.textContent='系统静态';}preference.addEventListener('change',applyPreference);
function tick(){if(!paused&&!staticMode)updateTime(marks[0].getCurrentTime()%6.4);requestAnimationFrame(tick);}applyPreference();requestAnimationFrame(tick);
const query=new URLSearchParams(location.search);if(query.has('capture')){document.body.dataset.capture='true';setFrame(query.has('frame')?query.get('frame'):4.8);}
</script></body></html>'''
    (OUT / 'index.html').write_text(document)
    print(f'Generated {len(DESIGNS)} animated marks, {len(DESIGNS)} static marks and preview: {OUT}')


if __name__ == '__main__':
    main()
