import type { BackupOutcome, ObsSession } from '../types';
import type { Instrument, ObsNight, ObsTarget, Telescope } from '../types';
import {
  altitudeRuns,
  axisMinutes,
  durationMinutes,
  HIGH_MOON_PHASE_PCT,
  isNarrowbandTarget,
  maxNightAltitude,
  minutesToTime,
  moonPhaseText,
  type AltitudeRun,
} from './astro';

/** 一段「因云取消」段的试算结果 */
export interface BackupPlanItem {
  /** 原取消段 ID */
  sourceId: string;
  outcome: BackupOutcome;
  /** 可安排 / 无法安排的人类可读说明（含高度、月相、设备细节） */
  detail: string;
  /** 建议开始时刻（仅可安排时有值） */
  startTime?: string;
  /** 建议结束时刻（仅可安排时有值） */
  endTime?: string;
  telescopeId?: string;
  instrumentId?: string;
  /** 该夜最大高度角（度），用于说明高度原因 */
  maxAltitude?: number;
  /** 该夜目标可见区间文案 */
  windowText?: string;
  /** 该替补夜是否已有该来源段的替补（重复生成时跳过） */
  alreadyPlaced?: boolean;
}

export interface BackupPlan {
  backupNightId: string;
  items: BackupPlanItem[];
  /** 可安排数量 */
  placedCount: number;
  /** 冲突数量（设备占用导致） */
  conflictCount: number;
  /** 无法安排数量（高度 / 月相 / 无可用设备） */
  blockedCount: number;
  /** 该备用夜月相偏高，排序时窄带目标优先 */
  highMoon: boolean;
  /** 输入数据缺失等硬性错误（确认时会在这一项停止） */
  errors: string[];
}

export interface BackupPlanContext {
  nights: ObsNight[];
  targets: ObsTarget[];
  telescopes: Telescope[];
  instruments: Instrument[];
  sessions: ObsSession[];
}

interface Slot {
  startAxis: number;
  endAxis: number;
  telescope: Telescope;
  instrument: Instrument;
}

/** 占用区间（含落在该望远镜上的跨零点时段），已取消（因云取消）段不占用设备 */
interface BusySpan {
  start: number;
  end: number;
  label: string;
}

/** 取某望远镜在该夜上的占用区间；返回的轴可超过 1440（跨零点） */
function busySpansOf(sessions: ObsSession[], nightId: string, telescopeId: string): BusySpan[] {
  return sessions
    .filter((session) => session.nightId === nightId && session.telescopeId === telescopeId && session.status !== '因云取消')
    .map((session) => {
      const start = axisMinutes(session.startTime);
      let end = axisMinutes(session.endTime);
      if (end <= start) end += 1440;
      return { start, end, label: `${session.startTime}-${session.endTime}` };
    });
}

/** 在给定可见区间内，为该望远镜找最早能容纳 durationMinutes 的空档 */
function earliestSlot(run: AltitudeRun, duration: number, busy: BusySpan[], telescope: Telescope, instrument: Instrument): Slot | null {
  // 以 10 分钟为步进在区间内搜索；候选起点不得越过区间末端
  const STEP = 10;
  for (let start = run.startAxis; start + duration <= run.endAxis + 0.001; start += STEP) {
    const end = start + duration;
    const overlap = busy.some((span) => start < span.end && end > span.start);
    if (!overlap) {
      return { startAxis: start, endAxis: end, telescope, instrument };
    }
  }
  return null;
}

function runText(run: AltitudeRun): string {
  return `${minutesToTime(run.startAxis)}-${minutesToTime(run.endAxis)}（最高 ${run.maxAltitude}°）`;
}

/**
 * 为一组「因云取消」段在指定备用观测夜上试算替补安排（纯函数，不落库）：
 * 1) 按目标最小地平高度取可见区间；2) 月相偏高时只安排窄带目标；
 * 3) 在可见区间内按望远镜占用找最早空档（原望远镜优先）。
 */
export function buildBackupPlan(sourceIds: string[], backupNightId: string, context: BackupPlanContext): BackupPlan {
  const night = context.nights.find((item) => item.id === backupNightId);
  const items: BackupPlanItem[] = [];
  const errors: string[] = [];
  if (!night) {
    return { backupNightId, items, placedCount: 0, conflictCount: 0, blockedCount: 0, highMoon: false, errors: ['所选备用观测夜不存在'] };
  }
  const highMoon = night.moonPhasePct >= HIGH_MOON_PHASE_PCT;

  const sources = sourceIds
    .map((id) => context.sessions.find((session) => session.id === id))
    .filter((session): session is ObsSession => Boolean(session));

  // 月相偏高时窄带目标优先；其余保持原序
  const ordered = [...sources].sort((a, b) => {
    if (!highMoon) return 0;
    const ta = context.targets.find((target) => target.id === a.targetId);
    const tb = context.targets.find((target) => target.id === b.targetId);
    return Number(Boolean(tb && isNarrowbandTarget(tb))) - Number(Boolean(ta && isNarrowbandTarget(ta)));
  });

  // 试算中已经排入的替补段（最小占位记录），逐段累积，避免两段抢进同一空档
  const planned: ObsSession[] = [];
  const occupiedSessions = () => [...context.sessions, ...planned];

  for (const source of ordered) {
    const target = context.targets.find((item) => item.id === source.targetId);
    if (!target) {
      errors.push(`排程段 ${source.id} 引用的目标（${source.targetId}）已不存在，不适合继续处理`);
      continue;
    }
    const duration = durationMinutes(source.startTime, source.endTime);

    // 该来源段在此备用夜上已有替补 → 幂等，不再复制
    const duplicate = context.sessions.find(
      (session) => session.sourceSessionId === source.id && session.nightId === backupNightId && session.status !== '因云取消',
    );
    if (duplicate) {
      items.push({
        sourceId: source.id,
        outcome: '已替补',
        detail: `该段在本备用夜已有替补排程 ${duplicate.id}（${duplicate.startTime}-${duplicate.endTime}），无需重复生成`,
        startTime: duplicate.startTime,
        endTime: duplicate.endTime,
        telescopeId: duplicate.telescopeId,
        instrumentId: duplicate.instrumentId,
        alreadyPlaced: true,
      });
      continue;
    }

    // 1) 最低高度
    const runs = altitudeRuns(target, night);
    if (runs.length === 0) {
      const maxAlt = maxNightAltitude(target, night);
      items.push({
        sourceId: source.id,
        outcome: '高度不足',
        maxAltitude: maxAlt,
        detail: `目标 ${target.name} 在本夜最高仅 ${maxAlt}°，低于最低高度阈值 ${target.minAltitude}°，无满足要求的可见时段`,
      });
      continue;
    }
    const windowText = runs.map(runText).join('；');

    // 2) 月相：偏高时只放行窄带目标
    if (highMoon && !isNarrowbandTarget(target)) {
      items.push({
        sourceId: source.id,
        outcome: '月相过高',
        maxAltitude: Math.max(...runs.map((run) => run.maxAltitude)),
        windowText,
        detail: `本夜月相 ${night.moonPhasePct}%（${moonPhaseText(night.moonPhasePct)}）偏高，目标 ${target.name} 使用 ${target.filter} 宽带滤镜（${target.magnitude} 等），背景天光过亮；高月相夜优先安排窄带（Ha/OIII/SII）目标`,
      });
      continue;
    }

    // 3) 设备：可用望远镜 + 能挂上的终端，原望远镜优先
    const originalTelescope = context.telescopes.find((item) => item.id === source.telescopeId);
    const telescopeOrder: Telescope[] = [];
    if (originalTelescope) telescopeOrder.push(originalTelescope);
    context.telescopes
      .filter((item) => item.id !== source.telescopeId)
      .sort((a, b) => a.code.localeCompare(b.code))
      .forEach((item) => telescopeOrder.push(item));

    let chosen: Slot | null = null;
    const rejected: string[] = [];
    for (const telescope of telescopeOrder) {
      if (telescope.status !== '可用') {
        rejected.push(`${telescope.code}（${telescope.status}）`);
        continue;
      }
      // 优先原终端，其次该望远镜编号下任意可用终端
      const matched = context.instruments.filter((instrument) => instrument.telescopeCode === telescope.code);
      const instrument = matched.find((item) => item.id === source.instrumentId) ?? matched[0];
      if (!instrument) {
        rejected.push(`${telescope.code}（无适配终端）`);
        continue;
      }
      const busy = busySpansOf(occupiedSessions(), backupNightId, telescope.id);
      for (const run of runs) {
        const slot = earliestSlot(run, duration, busy, telescope, instrument);
        if (slot) {
          chosen = slot;
          break;
        }
      }
      if (chosen) break;
      rejected.push(`${telescope.code}（可见区间内被占用${busy.length ? `：${busy.map((span) => span.label).join('、')}` : ''}）`);
    }

    if (!chosen) {
      // 没有任何「可用且挂得上终端」的望远镜 → 无可用设备；否则是这些望远镜可见区间全被占用
      const usableTelescopes = telescopeOrder.filter((telescope) => {
        if (telescope.status !== '可用') return false;
        return context.instruments.some((instrument) => instrument.telescopeCode === telescope.code);
      });
      const outcome: BackupOutcome = usableTelescopes.length === 0 ? '无可用设备' : '设备占用';
      items.push({
        sourceId: source.id,
        outcome,
        maxAltitude: Math.max(...runs.map((run) => run.maxAltitude)),
        windowText,
        detail:
          outcome === '无可用设备'
            ? `目标 ${target.name} 在本夜可见（${windowText}），但没有状态可用且能挂上终端的望远镜：${rejected.join('；') || '全部望远镜维护 / 外出'}`
            : `目标 ${target.name} 在本夜可见（${windowText}），需要连续 ${duration} 分钟，但各可用望远镜在可见区间内均已排满：${rejected.join('；')}`,
      });
      continue;
    }

    const startTime = minutesToTime(chosen.startAxis);
    const endTime = minutesToTime(chosen.endAxis);
    const narrowNote = highMoon && isNarrowbandTarget(target) ? '（高月相夜窄带优先）' : '';
    items.push({
      sourceId: source.id,
      outcome: '已替补',
      startTime,
      endTime,
      telescopeId: chosen.telescope.id,
      instrumentId: chosen.instrument.id,
      maxAltitude: Math.max(...runs.map((run) => run.maxAltitude)),
      windowText,
      detail: `${startTime}-${endTime} 排入 ${chosen.telescope.code} / ${chosen.instrument.model}，可见区间 ${windowText}${narrowNote}`,
    });
    planned.push({
      id: `__plan_${source.id}`,
      nightId: backupNightId,
      targetId: target.id,
      startTime,
      endTime,
      telescopeId: chosen.telescope.id,
      instrumentId: chosen.instrument.id,
      filterSlot: source.filterSlot,
      plannedFrames: source.plannedFrames,
      status: '待执行',
      schemaVersion: 0,
    });
  }

  // 幂等项（该来源段已有替补）只作提示，不计入本次可安排数量
  const placedCount = items.filter((item) => item.outcome === '已替补' && !item.alreadyPlaced).length;
  const conflictCount = items.filter((item) => item.outcome === '设备占用').length;
  const blockedCount = items.filter((item) => item.outcome === '高度不足' || item.outcome === '月相过高' || item.outcome === '无可用设备').length;

  return { backupNightId, items, placedCount, conflictCount, blockedCount, highMoon, errors };
}
