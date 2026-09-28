import type { ObsNight } from '../types/night';
import type { ObsTarget } from '../types/target';
import type { ObsSession, ReplanBlockReason, ReplanOutcome } from '../types/session';
import type { Telescope } from '../types/equipment';
import { NIGHT_TOTAL_MINUTES } from '../types/night';
import { altitudeAt, axisMinutes, durationMinutes, minutesToTime, moonPhaseText } from './astro';

/** 高度角采样步长（分钟） */
const ALT_STEP_MINUTES = 10;

/** 窄带滤镜：月相偏高时只有窄带目标仍可安排 */
export const NARROW_BAND_FILTERS = new Set(['Ha', 'OIII', 'SII']);

/** 判定目标是否窄带目标 */
export function isNarrowBand(target: Pick<ObsTarget, 'filter'>): boolean {
  return NARROW_BAND_FILTERS.has(target.filter);
}

/** 夜轴边界：日落早于 18:00 时从轴起点 0 开始，日出缺失时取轴末端 */
export function nightAxisBounds(night: Pick<ObsNight, 'sunset' | 'sunrise'>): { from: number; to: number } {
  const rawFrom = axisMinutes(night.sunset);
  const rawTo = axisMinutes(night.sunrise);
  return {
    from: rawFrom > NIGHT_TOTAL_MINUTES ? 0 : rawFrom,
    to: rawTo === 0 ? NIGHT_TOTAL_MINUTES : Math.min(rawTo, NIGHT_TOTAL_MINUTES),
  };
}

/** 连续可见区间 */
export interface VisibleInterval {
  /** 区间起点（夜轴分钟） */
  start: number;
  /** 区间终点（夜轴分钟，可至 NIGHT_TOTAL_MINUTES） */
  end: number;
}

/** 可见窗口计算结果 */
export interface VisibilityResult {
  /** 连续满足最低高度阈值的区间 */
  intervals: VisibleInterval[];
  /** 全夜最高高度角（度） */
  maxAltitude: number;
}

/**
 * 计算目标在指定观测夜的连续可见区间：日落到日出之间按固定步长采样高度角，
 * 把连续不低于目标最低高度阈值的采样点合并成区间。
 */
export function visibleIntervals(target: ObsTarget, night: ObsNight): VisibilityResult {
  const { from, to } = nightAxisBounds(night);
  const base = new Date(`${night.date}T18:00:00`);
  const intervals: VisibleInterval[] = [];
  let current: VisibleInterval | null = null;
  let maxAltitude = -90;
  for (let axis = from; axis <= to; axis += ALT_STEP_MINUTES) {
    const at = new Date(base.getTime() + axis * 60_000);
    const altitude = altitudeAt(target, at, night.siteLat, night.siteLng);
    maxAltitude = Math.max(maxAltitude, altitude);
    if (altitude >= target.minAltitude) {
      if (!current) current = { start: axis, end: axis + ALT_STEP_MINUTES };
      else current.end = axis + ALT_STEP_MINUTES;
    } else if (current) {
      intervals.push(current);
      current = null;
    }
  }
  if (current) intervals.push(current);
  return { intervals, maxAltitude: Number(maxAltitude.toFixed(1)) };
}

/**
 * 月相是否排除该宽带目标：月相偏高时暗弱宽带目标无法安排，窄带目标豁免。
 * 阈值与 astro.moonConflict 保持一致。
 */
export function isMoonBlocked(target: ObsTarget, moonPhasePct: number): boolean {
  if (isNarrowBand(target)) return false;
  if (moonPhasePct >= 85 && target.magnitude >= 6) return true;
  if (moonPhasePct >= 60 && target.magnitude >= 8) return true;
  return false;
}

/** 可安排时的时段信息 */
export interface ReplanSlot {
  startTime: string;
  endTime: string;
  /** 可见窗口起点（跨零点安全） */
  windowStart: string;
  /** 可见窗口终点 */
  windowEnd: string;
  /** 窗口内峰值高度角 */
  maxAltitude: number;
  /** 是否沿用来源段原时刻 */
  keptOriginal: boolean;
  /** 安排说明 */
  note: string;
}

/** 单段替补规划结论 */
export interface ReplanEvaluation {
  source: ObsSession;
  outcome: ReplanOutcome;
  slot?: ReplanSlot;
  blockReason?: ReplanBlockReason;
  /** 无法安排 / 冲突的具体说明 */
  detail?: string;
}

/** 规划结果数量统计 */
export interface ReplanSummary {
  total: number;
  schedulable: number;
  conflict: number;
  infeasible: number;
}

interface BusyBlock {
  start: number;
  end: number;
}

/**
 * 为一组「因云取消」段在指定备用夜上生成替补安排（纯计算，不落库）：
 * 1. 先按最低高度阈值求可见窗口，没有窗口记「无法安排（高度）」；
 * 2. 月相偏高时宽带暗目标记「无法安排（月相）」，窄带目标继续；
 * 3. 按原望远镜在可见窗口内找连续空档（先试原时刻，再沿窗口逐格前移），
 *    占用以该夜现有非取消排程 + 本批已占位段为准，找不到记「冲突（设备）」。
 * 月相偏高夜窄带段优先占位，其余按来源段开始时刻排序。
 */
export function evaluateReplan(
  sources: ObsSession[],
  night: ObsNight,
  targets: ObsTarget[],
  existingSessions: ObsSession[],
  telescopes: Telescope[],
): ReplanEvaluation[] {
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const telescopeById = new Map(telescopes.map((telescope) => [telescope.id, telescope]));
  const moonHigh = night.moonPhasePct >= 60;

  const ordered = [...sources].sort((a, b) => {
    const ta = targetById.get(a.targetId);
    const tb = targetById.get(b.targetId);
    const narrowA = ta && moonHigh && isNarrowBand(ta) ? 0 : 1;
    const narrowB = tb && moonHigh && isNarrowBand(tb) ? 0 : 1;
    if (narrowA !== narrowB) return narrowA - narrowB;
    return axisMinutes(a.startTime) - axisMinutes(b.startTime);
  });

  /** 该夜已占用的设备时段（只统计目标备用夜，取消段不占设备），按望远镜归集 */
  const busy = new Map<string, BusyBlock[]>();
  for (const session of existingSessions) {
    if (session.nightId !== night.id || session.status === '因云取消') continue;
    const start = axisMinutes(session.startTime);
    let end = axisMinutes(session.endTime);
    if (end <= start) end += 1440;
    const list = busy.get(session.telescopeId) ?? [];
    list.push({ start, end });
    busy.set(session.telescopeId, list);
  }

  return ordered.map((source) => {
    const target = targetById.get(source.targetId);
    if (!target) {
      return { source, outcome: '无法安排', blockReason: 'altitude', detail: `目标 ${source.targetId} 已不存在，无法评估可见窗口` };
    }
    const telescope = telescopeById.get(source.telescopeId);
    const telescopeCode = telescope?.code ?? source.telescopeId;
    const need = durationMinutes(source.startTime, source.endTime);
    const { intervals, maxAltitude } = visibleIntervals(target, night);

    // 1) 高度：全夜没有达到最低高度阈值的窗口
    if (intervals.length === 0) {
      return {
        source,
        outcome: '无法安排',
        blockReason: 'altitude',
        detail: `高度原因：${target.name} 在该夜最高仅 ${maxAltitude}°，低于最低高度阈值 ${target.minAltitude}°，没有可观测窗口`,
      };
    }

    const longEnough = intervals.filter((interval) => interval.end - interval.start >= need);

    // 可见窗口都容不下原排程时长，仍属高度（可见时间不足）
    if (longEnough.length === 0) {
      const longest = Math.max(...intervals.map((interval) => interval.end - interval.start));
      return {
        source,
        outcome: '无法安排',
        blockReason: 'altitude',
        detail: `高度原因：${target.name} 该夜可见窗口最长仅 ${longest} 分钟，不足排程需要的 ${need} 分钟（峰值 ${maxAltitude}° / 阈值 ${target.minAltitude}°）`,
      };
    }

    // 2) 月相：偏高月相下的宽带暗目标
    if (isMoonBlocked(target, night.moonPhasePct)) {
      return {
        source,
        outcome: '无法安排',
        blockReason: 'moon',
        detail: `月相原因：该夜月相 ${night.moonPhasePct}%（${moonPhaseText(night.moonPhasePct)}），${target.name} 为 ${target.magnitude} 等宽带（${target.filter}）目标，背景过亮；建议安排窄带目标或改到月相更低的备用夜`,
      };
    }

    // 设备不可用（维护中 / 外出）
    if (telescope && telescope.status !== '可用') {
      return {
        source,
        outcome: '无法安排',
        blockReason: 'equipment',
        detail: `设备原因：望远镜 ${telescopeCode} 当前为「${telescope.status}」，该夜无法使用`,
      };
    }

    // 3) 设备：在足够长的可见区间内找与现有占用不重叠的最早空档
    const mine = (busy.get(source.telescopeId) ?? []).slice().sort((a, b) => a.start - b.start);
    const fits = (start: number, end: number) => !mine.some((block) => start < block.end && end > block.start);

    const describeWindow = (interval: VisibleInterval) =>
      `${minutesToTime(interval.start)}-${minutesToTime(Math.min(interval.end, NIGHT_TOTAL_MINUTES))}`;

    // 先试来源段原时刻
    const originalStart = axisMinutes(source.startTime);
    const originalInterval = longEnough.find((interval) => originalStart >= interval.start && originalStart + need <= interval.end);
    if (originalInterval && fits(originalStart, originalStart + need)) {
      const slot: ReplanSlot = {
        startTime: source.startTime,
        endTime: minutesToTime(originalStart + need),
        windowStart: minutesToTime(originalInterval.start),
        windowEnd: minutesToTime(Math.min(originalInterval.end, NIGHT_TOTAL_MINUTES)),
        maxAltitude,
        keptOriginal: true,
        note: `原时段 ${source.startTime}-${minutesToTime(originalStart + need)} 高度达标（窗口 ${describeWindow(originalInterval)}，峰值 ${maxAltitude}°），${telescopeCode} 空闲，保持原时刻`,
      };
      mine.push({ start: originalStart, end: originalStart + need });
      busy.set(source.telescopeId, mine);
      return { source, outcome: '可安排', slot };
    }

    // 再沿各可见区间从早到晚逐格寻找
    for (const interval of longEnough) {
      for (let start = interval.start; start + need <= interval.end; start += ALT_STEP_MINUTES) {
        if (fits(start, start + need)) {
          const narrowNote = moonHigh && isNarrowBand(target) ? `；月相 ${night.moonPhasePct}%，${target.filter} 窄带目标优先且不受月光影响` : '';
          const slot: ReplanSlot = {
            startTime: minutesToTime(start),
            endTime: minutesToTime(Math.min(start + need, NIGHT_TOTAL_MINUTES + 1440)),
            windowStart: minutesToTime(interval.start),
            windowEnd: minutesToTime(Math.min(interval.end, NIGHT_TOTAL_MINUTES)),
            maxAltitude,
            keptOriginal: false,
            note: `调整至 ${minutesToTime(start)}-${minutesToTime(Math.min(start + need, NIGHT_TOTAL_MINUTES + 1440))}（可见窗口 ${describeWindow(interval)}，峰值 ${maxAltitude}°），${telescopeCode} 空闲${narrowNote}`,
          };
          mine.push({ start, end: start + need });
          busy.set(source.telescopeId, mine);
          return { source, outcome: '可安排', slot };
        }
      }
    }

    const windowsText = longEnough.map(describeWindow).join('、');
    return {
      source,
      outcome: '冲突',
      blockReason: 'equipment',
      detail: `设备原因：${target.name} 可见窗口 ${windowsText} 内 ${telescopeCode} 均已被其他排程占用，凑不出 ${need} 分钟连续空档，请更换望远镜或换一个备用夜`,
    };
  });
}

/** 汇总规划数量：可安排 / 冲突 / 无法安排 */
export function summarizeReplan(evaluations: ReplanEvaluation[]): ReplanSummary {
  const summary: ReplanSummary = { total: evaluations.length, schedulable: 0, conflict: 0, infeasible: 0 };
  for (const evaluation of evaluations) {
    if (evaluation.outcome === '可安排') summary.schedulable += 1;
    else if (evaluation.outcome === '冲突') summary.conflict += 1;
    else summary.infeasible += 1;
  }
  return summary;
}
