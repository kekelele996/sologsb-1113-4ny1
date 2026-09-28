import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { axisMinutes } from '../utils/astro';
import type { ObsSession, ReplanBlockReason, ReplanOutcome, SessionStatus } from '../types';

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
}

/** 确认替补安排时每一段的落库指令（由规划预演结果映射而来） */
export interface ReplanCommitItem {
  sourceId: string;
  outcome: ReplanOutcome;
  /** 无法安排 / 冲突的原因分类 */
  blockReason?: ReplanBlockReason;
  /** 无法安排 / 冲突的具体说明（高度、月相或设备原因） */
  detail?: string;
  /** 可安排时的替补时段与说明 */
  newSession?: {
    startTime: string;
    endTime: string;
    note: string;
  };
}

export interface ReplanCommitResult {
  /** 新生成的替补排程段 */
  added: ObsSession[];
  /** 被更新结论的来源（取消）段 */
  updated: ObsSession[];
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
  /**
   * 原子确认一批替补安排：在同一事务内新增替补段并回写来源段结论。
   * 事务内会重新读取数据并二次校验设备占用，任何一段不适合都整体回滚，
   * 页面与本地数据保持确认前状态。
   */
  applyReplanPlan: (backupNightId: string, reason: string, items: ReplanCommitItem[]) => Promise<ReplanCommitResult>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
}

function endAxis(session: Pick<ObsSession, 'startTime' | 'endTime'>): number {
  const start = axisMinutes(session.startTime);
  let end = axisMinutes(session.endTime);
  if (end <= start) end += 1440;
  return end;
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

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  applyReplanPlan: async (backupNightId, reason, items) => {
    const trimmedReason = reason.trim();
    const result: ReplanCommitResult = { added: [], updated: [] };

    await db.transaction('rw', db.sessions, async () => {
      const rows = await db.sessions.toArray();

      // 事务内逐段校验并构造待写入对象；任一段失败抛出 → 整个事务回滚
      const toPut: ObsSession[] = [];
      /** 本批新替补段已占用的设备区间，防止批次内部互相重叠 */
      const claimed = new Map<string, Array<{ start: number; end: number; label: string }>>();

      for (const item of items) {
        const source = rows.find((row) => row.id === item.sourceId);
        if (!source) {
          throw new Error(`排程段 ${item.sourceId} 已不存在，无法生成替补安排`);
        }
        if (source.status !== '因云取消') {
          throw new Error(`排程段 ${source.id}（目标 ${source.targetId}）当前状态为「${source.status}」，不是「因云取消」，不适合生成替补安排`);
        }

        // 同一来源段在该备用夜已有替补段时停止，避免重复复制
        const duplicate = rows.find(
          (row) => row.nightId === backupNightId && row.replanSourceSessionId === source.id && row.status !== '因云取消',
        );
        if (duplicate) {
          throw new Error(`排程段 ${source.id}（目标 ${source.targetId}）在该备用夜已有替补排程段 ${duplicate.id}，请勿重复生成`);
        }

        const rescheduleReason = trimmedReason || source.rescheduleReason || '改期至备用观测夜';

        if (item.outcome !== '可安排' || !item.newSession) {
          // 冲突 / 无法安排：保留取消状态，写明高度、月相或设备原因
          const updated: ObsSession = {
            ...source,
            status: '因云取消',
            rescheduleReason,
            backupNightId,
            replanNightId: backupNightId,
            replanOutcome: item.outcome,
            replanBlockReason: item.blockReason,
            replanDetail: item.detail,
            schemaVersion: SCHEMA_VERSION,
          };
          toPut.push(updated);
          result.updated.push(updated);
          continue;
        }

        // 可安排：二次校验该夜同一望远镜此时段确实空闲
        const start = axisMinutes(item.newSession.startTime);
        const end = axisMinutes(item.newSession.endTime) + (axisMinutes(item.newSession.endTime) <= start ? 1440 : 0);
        const nightRows = rows.filter(
          (row) => row.nightId === backupNightId && row.telescopeId === source.telescopeId && row.status !== '因云取消',
        );
        const overlapRow = nightRows.find((row) => {
          const otherStart = axisMinutes(row.startTime);
          const otherEnd = endAxis(row);
          return start < otherEnd && end > otherStart;
        });
        const ownClaim = (claimed.get(source.telescopeId) ?? []).find((block) => start < block.end && end > block.start);
        if (overlapRow || ownClaim) {
          const who = overlapRow ? `已被排程段 ${overlapRow.id} 占用` : `与本批 ${ownClaim?.label ?? ''} 互相重叠`;
          throw new Error(`排程段 ${source.id}（目标 ${source.targetId}）不适合安排在 ${item.newSession.startTime}-${item.newSession.endTime}：${who}，请返回重算`);
        }

        const added: ObsSession = {
          id: uid('s'),
          nightId: backupNightId,
          targetId: source.targetId,
          startTime: item.newSession.startTime,
          endTime: item.newSession.endTime,
          telescopeId: source.telescopeId,
          instrumentId: source.instrumentId,
          filterSlot: source.filterSlot,
          plannedFrames: source.plannedFrames,
          status: '待执行',
          // 新替补段不携带改期原因，来源信息单独标注
          replanSourceSessionId: source.id,
          replanSourceNightId: source.nightId,
          replanNote: item.newSession.note,
          schemaVersion: SCHEMA_VERSION,
        };
        const updatedSource: ObsSession = {
          ...source,
          status: '因云取消',
          rescheduleReason,
          backupNightId,
          replanNightId: backupNightId,
          replanOutcome: '可安排',
          replanBlockReason: undefined,
          replanDetail: undefined,
          schemaVersion: SCHEMA_VERSION,
        };
        toPut.push(added, updatedSource);
        const list = claimed.get(source.telescopeId) ?? [];
        list.push({ start, end, label: `${item.newSession.startTime}-${item.newSession.endTime}` });
        claimed.set(source.telescopeId, list);
        result.added.push(added);
        result.updated.push(updatedSource);
      }

      await db.sessions.bulkPut(toPut);
    });

    // 事务成功后才把结果同步进内存 store，保证页面与本地数据一致
    set((state) => {
      const addedIds = new Set(result.added.map((session) => session.id));
      const updatedById = new Map(result.updated.map((session) => [session.id, session]));
      return {
        sessions: [
          ...state.sessions.filter((session) => !addedIds.has(session.id)).map((session) => updatedById.get(session.id) ?? session),
          ...result.added,
        ],
      };
    });

    return result;
  },
}));
