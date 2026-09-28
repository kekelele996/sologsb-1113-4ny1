/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消';

/** 替补安排结果（写在因云取消的原段上，下次打开可按来源查回原因） */
export type BackupOutcome = '已替补' | '高度不足' | '月相过高' | '设备占用' | '无可用设备';

/** 目标在观测夜上的连续可见区间 */
export interface AltitudeRun {
  /** 区间起点（夜时间轴分钟，18:00 起算） */
  startAxis: number;
  /** 区间终点（夜时间轴分钟，可超过 1440 表示跨零点） */
  endAxis: number;
  /** 区间内最大地平高度角（度） */
  maxAltitude: number;
}

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
  /** 替补安排结果：已替补 / 高度不足 / 月相过高 / 设备占用 / 无可用设备 */
  backupOutcome?: BackupOutcome;
  /** 无法替补时的具体原因（写明高度、月相或设备细节） */
  backupReason?: string;
  /** 替补排程段：来源（原取消段）ID，可据此查回原段 */
  sourceSessionId?: string;
  /** 替补排程段：来源说明文案（如 2025-10-12 因云取消段 s-11 的替补） */
  sourceNote?: string;
  /** 尝试生成替补安排的时间（ISO） */
  backupAttemptedAt?: string;
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

/** 替补结果配色（MUI Chip color） */
export const BACKUP_OUTCOME_COLOR: Record<BackupOutcome, 'success' | 'warning' | 'error' | 'info'> = {
  已替补: 'success',
  高度不足: 'warning',
  月相过高: 'warning',
  设备占用: 'error',
  无可用设备: 'error',
};
