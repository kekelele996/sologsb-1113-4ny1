/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消';

/** 替补安排的规划结论（确认前预演 / 确认后留痕共用） */
export type ReplanOutcome = '可安排' | '冲突' | '无法安排';

/** 无法安排的具体原因分类 */
export type ReplanBlockReason = 'altitude' | 'moon' | 'equipment';

/** 观测排程段 */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 替补排程段：来源段 ID（因云取消段复制而来） */
  replanSourceSessionId?: string;
  /** 替补排程段：来源观测夜 ID（便于跨夜按来源追溯） */
  replanSourceNightId?: string;
  /** 替补排程段：规划说明（安排依据，如“21:50-23:30 可见，T-02 空闲”） */
  replanNote?: string;
  /** 取消段：最近一次替补规划的替补夜 ID */
  replanNightId?: string;
  /** 取消段：最近一次替补规划的结论 */
  replanOutcome?: ReplanOutcome;
  /** 取消段：无法安排 / 冲突的原因分类 */
  replanBlockReason?: ReplanBlockReason;
  /** 取消段：无法安排 / 冲突的具体说明（高度、月相或设备原因） */
  replanDetail?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消'];

/** 4 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
};
