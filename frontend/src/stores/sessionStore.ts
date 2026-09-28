import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { BackupPlan, BackupPlanItem } from '../utils/backupPlan';
import type { BackupOutcome, ObsSession, SessionStatus } from '../types';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
  backupOutcome?: BackupOutcome;
  backupReason?: string;
  sourceSessionId?: string;
  sourceNote?: string;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  /** 原子提交替补试算结果：复制可安排段、回写无法安排原因；任一段失败整体回滚 */
  applyBackupPlan: (plan: BackupPlan) => Promise<{ placed: ObsSession[]; blocked: number }>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
}

/** 替补安排提交过程中某一段不适合（数据校验失败）时抛出，事务随之回滚 */
export class BackupPlanAbortError extends Error {
  sourceId: string;
  constructor(sourceId: string, message: string) {
    super(message);
    this.name = 'BackupPlanAbortError';
    this.sourceId = sourceId;
  }
}

/** 排程段与冲突检测所需数据 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      backupOutcome: input.backupOutcome,
      backupReason: input.backupReason?.trim() || undefined,
      sourceSessionId: input.sourceSessionId,
      sourceNote: input.sourceNote?.trim() || undefined,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const updated = targets.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      schemaVersion: SCHEMA_VERSION,
    }));
    for (const session of updated) {
      await persistRow('sessions', session);
    }
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  applyBackupPlan: async (plan) => {
    const existing = get().sessions;
    const night = await db.nights.get(plan.backupNightId);
    if (!night) {
      throw new BackupPlanAbortError('-', `备用观测夜 ${plan.backupNightId} 不存在，无法生成替补安排`);
    }

    // 全部校验与写入放在同一个 Dexie 事务里：任何一段不适合即抛出，
    // 事务整体回滚，页面与本地数据保留确认前状态。
    const attemptedAt = new Date().toISOString();
    const result = await db.transaction('rw', db.sessions, db.targets, db.telescopes, db.instruments, db.nights, async () => {
      const copies: ObsSession[] = [];
      const patches: ObsSession[] = [];
      for (const item of plan.items) {
        if (item.alreadyPlaced) continue;
        const source = existing.find((session) => session.id === item.sourceId);
        if (!source) {
          throw new BackupPlanAbortError(item.sourceId, `排程段 ${item.sourceId} 已被删除，不适合生成替补，已停止整批处理`);
        }
        const target = await db.targets.get(source.targetId);
        if (!target) {
          throw new BackupPlanAbortError(source.id, `排程段 ${source.id} 的目标 ${source.targetId} 不存在，不适合生成替补，已停止整批处理`);
        }

        if (item.outcome === '已替补' && item.startTime && item.endTime && item.telescopeId && item.instrumentId) {
          const telescope = await db.telescopes.get(item.telescopeId);
          const instrument = await db.instruments.get(item.instrumentId);
          if (!telescope || telescope.status !== '可用') {
            throw new BackupPlanAbortError(source.id, `排程段 ${source.id}（${target.name}）选用的望远镜不可用，不适合生成替补，已停止整批处理`);
          }
          if (!instrument) {
            throw new BackupPlanAbortError(source.id, `排程段 ${source.id}（${target.name}）选用的终端不存在，不适合生成替补，已停止整批处理`);
          }
          if (instrument.telescopeCode !== telescope.code) {
            throw new BackupPlanAbortError(source.id, `排程段 ${source.id}（${target.name}）的终端与望远镜不配套，不适合生成替补，已停止整批处理`);
          }
          const sourceNight = await db.nights.get(source.nightId);
          const sourceDate = sourceNight?.date ?? source.nightId;
          const sourceNote = `${sourceDate} 因云取消段 ${source.id} 的替补`;
          const id = uid('s');
          copies.push({
            id,
            nightId: plan.backupNightId,
            targetId: source.targetId,
            startTime: item.startTime,
            endTime: item.endTime,
            telescopeId: item.telescopeId,
            instrumentId: item.instrumentId,
            filterSlot: source.filterSlot,
            plannedFrames: source.plannedFrames,
            status: '待执行',
            sourceSessionId: source.id,
            sourceNote,
            schemaVersion: SCHEMA_VERSION,
          });
          patches.push({
            ...source,
            backupNightId: plan.backupNightId,
            backupOutcome: '已替补',
            backupReason: `已生成替补段 ${id}：${item.startTime}-${item.endTime}，${telescope.code} / ${instrument.model}`,
            backupAttemptedAt: attemptedAt,
            schemaVersion: SCHEMA_VERSION,
          });
        } else if (item.outcome === '高度不足' || item.outcome === '月相过高' || item.outcome === '设备占用' || item.outcome === '无可用设备') {
          // 无法安排：保留「因云取消」状态，仅写明高度 / 月相 / 设备原因
          patches.push({
            ...source,
            backupNightId: plan.backupNightId,
            backupOutcome: item.outcome,
            backupReason: item.detail,
            backupAttemptedAt: attemptedAt,
            schemaVersion: SCHEMA_VERSION,
          });
        }
      }
      if (copies.length) await db.sessions.bulkPut(copies);
      if (patches.length) await db.sessions.bulkPut(patches);
      return { copies, patches };
    });

    const copies = result.copies;
    const patches = result.patches;
    const copyIds = new Set(copies.map((session) => session.id));
    const patchById = new Map(patches.map((session) => [session.id, session]));
    set({
      sessions: [...existing.filter((session) => !copyIds.has(session.id)), ...copies].map((session) => patchById.get(session.id) ?? session),
    });
    return { placed: copies, blocked: patches.length - copies.length };
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },
}));
