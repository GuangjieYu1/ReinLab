/**
 * 年号历（1B）：年号 + 干支 + 农历 与公历互转（design/prd/19-creative.md §2、20 契约 §5.1）。
 *
 * 做法：
 * - 年号表给到明清常用的那些（聊斋、志怪、笔记里的年份基本落在这一段）；表里没有就回 422，不猜。
 * - 干支按六十甲子算，能验证「甲子年」和数字年是否对得上。
 * - 农历用天文算法自己算：新月定月首（东八区当地日期），冬至所在月为十一月，无中气的月为闰月。
 *   精度：朔与冬至都用 Meeus 的级数（分钟级），中气用低精度太阳黄经（约分钟级）。
 *   落在日界 / 月界附近的，宁可给候选（StoryTime.candidates），也不硬填一个日期。
 *
 * 全部按东八区（UTC+8）算：农历的「今天」是中国标准时间的今天。
 */

const SYNODIC_MONTH = 29.530588861;
const J2000 = 2451545.0;
const CHINA_OFFSET_DAYS = 8 / 24;
const RAD = Math.PI / 180;

const norm360 = (value: number): number => ((value % 360) + 360) % 360;
const sinDeg = (value: number): number => Math.sin(value * RAD);

/** 儒略日（UT）→ 世界时日期，按东八区取当地「日」。 */
function civilFromJd(jd: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const shifted = jd + CHINA_OFFSET_DAYS + 0.5;
  const z = Math.floor(shifted);
  const fraction = shifted - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  const minutes = Math.round(fraction * 1440);
  return { year, month, day, hour: Math.floor(minutes / 60) % 24, minute: minutes % 60 };
}

/** 公历日期 → 儒略日（UT，零时）。 */
export function jdFromCivil(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/** 第 k 个朔（自 2000-01-06 起算）的儒略日（JDE，忽略 ΔT，分钟级）。 */
export function newMoonJde(k: number): number {
  const t = k / 1236.85;
  let jde = 2451550.09766 + SYNODIC_MONTH * k + 0.00015437 * t ** 2 - 0.000000150 * t ** 3 + 0.00000000073 * t ** 4;
  const sunAnomaly = 2.5534 + 29.10535670 * k - 0.0000014 * t ** 2 - 0.00000011 * t ** 3;
  const moonAnomaly = 201.5643 + 385.81693528 * k + 0.0107582 * t ** 2 + 0.00001238 * t ** 3 - 0.000000058 * t ** 4;
  const moonLatitude = 160.7108 + 390.67050284 * k - 0.0016118 * t ** 2 - 0.00000227 * t ** 3 + 0.000000011 * t ** 4;
  const node = 124.7746 - 1.56375588 * k + 0.0020672 * t ** 2 + 0.00000215 * t ** 3;
  jde +=
    -0.40720 * sinDeg(moonAnomaly) +
    0.17241 * sinDeg(sunAnomaly) +
    0.01608 * sinDeg(2 * moonAnomaly) +
    0.01039 * sinDeg(2 * moonLatitude) +
    0.00739 * sinDeg(moonAnomaly - sunAnomaly) -
    0.00514 * sinDeg(moonAnomaly + sunAnomaly) +
    0.00208 * sinDeg(2 * sunAnomaly) -
    0.00111 * sinDeg(moonAnomaly - 2 * moonLatitude) -
    0.00057 * sinDeg(moonAnomaly + 2 * moonLatitude) +
    0.00056 * sinDeg(2 * moonAnomaly + sunAnomaly) -
    0.00042 * sinDeg(3 * moonAnomaly) +
    0.00042 * sinDeg(sunAnomaly + 2 * moonLatitude) +
    0.00038 * sinDeg(sunAnomaly - 2 * moonLatitude) -
    0.00024 * sinDeg(2 * moonAnomaly - sunAnomaly) -
    0.00017 * sinDeg(node) -
    0.00007 * sinDeg(moonAnomaly + 2 * sunAnomaly) +
    0.00004 * sinDeg(2 * moonAnomaly - 2 * moonLatitude) +
    0.00004 * sinDeg(3 * sunAnomaly) +
    0.00003 * sinDeg(moonAnomaly + sunAnomaly - 2 * moonLatitude) +
    0.00003 * sinDeg(2 * moonAnomaly + 2 * moonLatitude) -
    0.00003 * sinDeg(moonAnomaly + sunAnomaly + 2 * moonLatitude) +
    0.00003 * sinDeg(moonAnomaly - sunAnomaly + 2 * moonLatitude) -
    0.00002 * sinDeg(moonAnomaly - sunAnomaly - 2 * moonLatitude) -
    0.00002 * sinDeg(3 * moonAnomaly + sunAnomaly) +
    0.00002 * sinDeg(4 * moonAnomaly);
  return jde;
}

/** 太阳视黄经（度，Meeus 低精度，误差约 0.001°）。 */
export function solarLongitude(jd: number): number {
  const t = (jd - J2000) / 36525;
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * sinDeg(m) +
    (0.019993 - 0.000101 * t) * sinDeg(2 * m) +
    0.000289 * sinDeg(3 * m);
  const omega = 125.04 - 1934.136 * t;
  return norm360(l0 + c - 0.00569 - 0.00478 * sinDeg(omega));
}

/** 冬至（12 月）的儒略日，Meeus 第 27 章的近似式。 */
export function winterSolsticeJde(year: number): number {
  const y = (year - 2000) / 1000;
  return 2451900.05952 + 365242.74049 * y - 0.06223 * y * y - 0.00823 * y * y * y + 0.00032 * y ** 4;
}

/** 太阳黄经到达 target（度）的时刻，从 jd 起二分逼近。 */
function solarTermJde(startJd: number, target: number): number {
  let low = startJd - 40;
  let high = startJd + 40;
  const delta = (jd: number) => {
    let diff = norm360(solarLongitude(jd) - target);
    if (diff > 180) diff -= 360;
    return diff;
  };
  for (let index = 0; index < 60; index += 1) {
    const mid = (low + high) / 2;
    if (delta(mid) > 0) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

export type LunarMonth = {
  /** 农历月号：11、12、1..10。 */
  month: number;
  leap: boolean;
  /** 月首的东八区日期。 */
  start: { year: number; month: number; day: number };
  startJd: number;
  /** 这个月的朔（新月）的儒略日：判断是不是贴着日界、要不要给候选。 */
  moonJd: number;
  days: number;
};

const dayStartJd = (jd: number): number => Math.floor(jd + CHINA_OFFSET_DAYS + 0.5) - 0.5 - CHINA_OFFSET_DAYS;

/** 从月首反推那一次朔的儒略日（月首是它所在那一天）。 */
const moonJdOf = (startJd: number): number => startJd + 0.5 - CHINA_OFFSET_DAYS + 0.5;

/**
 * 一个「冬至周期」的月表：从冬至所在月（十一月）起到下一个冬至月之前。
 * 月号按 11、12、1…10 排；闰月是当年第一个没有中气的月，月号重复上一个。
 */
function lunarCycle(lunarYear: number): { months: LunarMonth[]; leapYear: boolean } {
  const solstice = winterSolsticeJde(lunarYear - 1);
  let index = Math.round((solstice - 2451550.09766) / SYNODIC_MONTH);
  while (newMoonJde(index) > dayStartJd(solstice)) index -= 1;
  while (newMoonJde(index + 1) <= dayStartJd(solstice)) index += 1;
  const nextSolstice = winterSolsticeJde(lunarYear);
  let nextIndex = Math.round((nextSolstice - 2451550.09766) / SYNODIC_MONTH);
  while (newMoonJde(nextIndex) > dayStartJd(nextSolstice)) nextIndex -= 1;
  while (newMoonJde(nextIndex + 1) <= dayStartJd(nextSolstice)) nextIndex += 1;
  const nextSolsticeStart = dayStartJd(newMoonJde(nextIndex));
  const starts: number[] = [];
  for (let at = 0; at < 14; at += 1) {
    const jd = dayStartJd(newMoonJde(index + at));
    if (jd >= nextSolsticeStart) break;
    starts.push(jd);
  }
  const leapYear = nextIndex - index === 13;
  const civil = (jd: number) => {
    const date = civilFromJd(jd);
    return { year: date.year, month: date.month, day: date.day };
  };
  const months: LunarMonth[] = [];
  let number = 11;
  let leapUsed = false;
  for (let at = 0; at < starts.length; at += 1) {
    const startJd = starts[at];
    const nextJd = at + 1 < starts.length ? starts[at + 1] : nextSolsticeStart;
    const hasMajorTerm = (() => {
      const startLongitude = solarLongitude(startJd);
      const target = Math.ceil(startLongitude / 30) * 30;
      const termJd = solarTermJde(startJd + 15, norm360(target));
      return termJd >= startJd && termJd < nextJd;
    })();
    const isLeap = leapYear && !hasMajorTerm && !leapUsed && at > 0;
    if (isLeap) leapUsed = true;
    // 闰月沿用上一个月号（正月里的闰月是「闰正月」），不另起一号。
    const label = isLeap ? (number === 1 ? 12 : number - 1) : number;
    months.push({
      month: label,
      leap: isLeap,
      start: civil(startJd),
      startJd,
      moonJd: moonJdOf(startJd),
      days: Math.round(nextJd - startJd),
    });
    if (!isLeap) number = number === 12 ? 1 : number + 1;
  }
  return { months, leapYear };
}

/**
 * 农历某一年的月表（正月到十二月，闰月按重复月号带上）。
 * 农历年从正月起：本年周期里的 1…10 月，加上下一周期开头的 11、12 月。
 */
export function lunarMonthsOfYear(lunarYear: number): LunarMonth[] {
  const current = lunarCycle(lunarYear).months;
  const next = lunarCycle(lunarYear + 1).months;
  const firstMonthOne = current.findIndex((item) => item.month === 1 && !item.leap);
  const head = firstMonthOne >= 0 ? current.slice(firstMonthOne) : current;
  const tail: LunarMonth[] = [];
  for (const item of next) {
    if (item.month === 1 && !item.leap) break;
    tail.push(item);
  }
  return [...head, ...tail];
}

/**
 * 这个月的月首离日界有多近（分钟）：太近就说不准是前一天还是后一天，要给候选。
 * 方法：把这一个朔的时刻换算成东八区的当地时刻，看到 00:00 的距离。
 */
export function monthBoundaryRisk(month: LunarMonth): number {
  // 朔在东八区当地的时刻：离 00:00 不到半小时就说不准是哪一天。
  const local = month.moonJd + CHINA_OFFSET_DAYS;
  const fraction = local - Math.floor(local);
  const minutes = fraction * 1440;
  return Math.min(minutes, 1440 - minutes);
}

/**
 * 历史上的农历按北京地方时（约 UTC+7:45）排，1928 年以后按 UTC+8。
 * 朔落在两种标准的日界之间时，同一个「三月初七」会差一天：这种时候给候选，不硬填。
 */
const OFFSETS = [8 / 24, 7.7605 / 24];

export function monthStartCandidates(month: LunarMonth): { year: number; month: number; day: number }[] {
  const days = new Set<string>();
  const out: { year: number; month: number; day: number }[] = [];
  for (const offset of OFFSETS) {
    const localJd = month.moonJd + offset;
    const dateStart = Math.floor(localJd + 0.5) - 0.5;
    const date = civilFromJd(dateStart - offset);
    const key = `${date.year}-${date.month}-${date.day}`;
    if (days.has(key)) continue;
    days.add(key);
    out.push({ year: date.year, month: date.month, day: date.day });
  }
  return out;
}

/** 农历 → 公历（东八区日期）。找不到这个月（比如闰月不存在）返回 null。 */
export function lunarToCivil(
  year: number,
  month: number,
  day: number,
  leap = false,
): { year: number; month: number; day: number; days: number } | null {
  const months = lunarMonthsOfYear(year);
  const found = months.find((item) => item.month === month && item.leap === leap);
  if (!found) return null;
  if (day < 1 || day > found.days) return null;
  const jd = found.startJd + (day - 1);
  const date = civilFromJd(jd);
  return { year: date.year, month: date.month, day: date.day, days: found.days };
}

// ── 年号 ──────────────────────────────────────────
export type Era = { name: string; dynasty: '明' | '清'; start: number; end: number };

export const ERA_TABLE: Era[] = [
  { name: '洪武', dynasty: '明', start: 1368, end: 1398 },
  { name: '建文', dynasty: '明', start: 1399, end: 1402 },
  { name: '永乐', dynasty: '明', start: 1403, end: 1424 },
  { name: '洪熙', dynasty: '明', start: 1425, end: 1425 },
  { name: '宣德', dynasty: '明', start: 1426, end: 1435 },
  { name: '正统', dynasty: '明', start: 1436, end: 1449 },
  { name: '景泰', dynasty: '明', start: 1450, end: 1457 },
  { name: '天顺', dynasty: '明', start: 1457, end: 1464 },
  { name: '成化', dynasty: '明', start: 1465, end: 1487 },
  { name: '弘治', dynasty: '明', start: 1488, end: 1505 },
  { name: '正德', dynasty: '明', start: 1506, end: 1521 },
  { name: '嘉靖', dynasty: '明', start: 1522, end: 1566 },
  { name: '隆庆', dynasty: '明', start: 1567, end: 1572 },
  { name: '万历', dynasty: '明', start: 1573, end: 1619 },
  { name: '泰昌', dynasty: '明', start: 1620, end: 1620 },
  { name: '天启', dynasty: '明', start: 1621, end: 1627 },
  { name: '崇祯', dynasty: '明', start: 1628, end: 1644 },
  { name: '顺治', dynasty: '清', start: 1644, end: 1661 },
  { name: '康熙', dynasty: '清', start: 1662, end: 1722 },
  { name: '雍正', dynasty: '清', start: 1723, end: 1735 },
  { name: '乾隆', dynasty: '清', start: 1736, end: 1795 },
  { name: '嘉庆', dynasty: '清', start: 1796, end: 1820 },
  { name: '道光', dynasty: '清', start: 1821, end: 1850 },
  { name: '咸丰', dynasty: '清', start: 1851, end: 1861 },
  { name: '同治', dynasty: '清', start: 1862, end: 1874 },
  { name: '光绪', dynasty: '清', start: 1875, end: 1908 },
  { name: '宣统', dynasty: '清', start: 1909, end: 1911 },
];

export const eraByName = (name: string): Era | undefined => ERA_TABLE.find((item) => item.name === name);

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';

/** 公元年 → 干支（按干支纪年：公元 4 年为甲子）。 */
export function ganzhiOfYear(year: number): string {
  const offset = ((year - 4) % 60 + 60) % 60;
  return GAN[offset % 10] + ZHI[offset % 12];
}

/** 干支年在给定范围里是哪一年（取最近的；含糊就都返回）。 */
export function yearsOfGanzhi(ganzhi: string, near: number, span = 60): number[] {
  const ganIndex = GAN.indexOf(ganzhi[0]);
  const zhiIndex = ZHI.indexOf(ganzhi[1]);
  if (ganIndex < 0 || zhiIndex < 0) return [];
  const years: number[] = [];
  for (let year = Math.floor(near - span); year <= Math.ceil(near + span); year += 1)
    if (ganzhiOfYear(year) === ganzhi) years.push(year);
  return years;
}

/** 农历月份名。 */
export const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];

/** 农历日名：初一…初十、十一…二十、廿一…三十。 */
export function lunarDayName(day: number): string {
  if (day <= 10) return `初${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][day - 1]}`;
  if (day < 20) return `十${['一', '二', '三', '四', '五', '六', '七', '八', '九'][day - 11]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${['一', '二', '三', '四', '五', '六', '七', '八', '九'][day - 21]}`;
  return '三十';
}

/** 公历 → 年号 + 干支标签（展示用；找不到年号就只给干支）。 */
export function eraLabelOf(year: number): string {
  const era = [...ERA_TABLE].reverse().find((item) => year >= item.start && year <= item.end);
  const ganzhi = ganzhiOfYear(year);
  if (!era) return `${ganzhi}年（${year}）`;
  const nth = year - era.start + 1;
  return `${era.dynasty}${era.name}${nth === 1 ? '元' : nth}年 · ${ganzhi}年`;
}
