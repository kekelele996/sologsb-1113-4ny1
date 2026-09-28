import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import ConflictBadge from '../components/common/ConflictBadge';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { useSessionStore, type ReplanCommitItem } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { FILTER_NAMES, SESSION_STATUSES, type ObsSession, type SessionStatus } from '../types';
import { axisMinutes, durationMinutes, formatMinutes } from '../utils/astro';
import { evaluateReplan, summarizeReplan, type ReplanEvaluation } from '../utils/replan';

interface SessionFormState {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason: string;
}

/** 排程段列表与冲突检测结果，支持批量改期到备用观测夜 */
export default function SessionsPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const addSession = useSessionStore((s) => s.addSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const rescheduleToBackup = useSessionStore((s) => s.rescheduleToBackup);
  const applyReplanPlan = useSessionStore((s) => s.applyReplanPlan);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const { findConflicts, conflictIds } = useConflictCheck();

  /** 支持从设备分配视图一键跳转：?night=<夜ID>&highlight=<排程段ID> */
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight') ?? '';
  const nightParam = searchParams.get('night') ?? '';
  const [nightFilter, setNightFilter] = useState(nightParam || '全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [onlyConflict, setOnlyConflict] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleNight, setRescheduleNight] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  /** 「生成替补安排」对话框 */
  const [replanOpen, setReplanOpen] = useState(false);
  const [replanNight, setReplanNight] = useState('');
  const [replanReason, setReplanReason] = useState('');
  const [replanError, setReplanError] = useState('');
  const [applying, setApplying] = useState(false);
  /** 来源筛选：全部 / 替补段 / 各取消段（按来源查回新增段） */
  const [sourceFilter, setSourceFilter] = useState('全部');
  const [form, setForm] = useState<SessionFormState>({
    nightId: '',
    targetId: '',
    startTime: '20:00',
    endTime: '21:00',
    telescopeId: '',
    instrumentId: '',
    filterSlot: 'L',
    plannedFrames: 30,
    status: '待执行',
    rescheduleReason: '',
  });

  const conflictSet = useMemo(() => conflictIds(), [conflictIds]);
  const backupNights = useMemo(() => nights.filter((night) => night.backup), [nights]);

  /** 勾选段中的「因云取消」段（只有它们参与替补安排） */
  const selectedCancelled = useMemo(
    () => sessions.filter((session) => selected.includes(session.id) && session.status === '因云取消'),
    [sessions, selected],
  );

  /** 有来源的替补段（replanSourceSessionId → 来源段），用于按来源追溯 */
  const replacementSessions = useMemo(() => sessions.filter((session) => session.replanSourceSessionId), [sessions]);
  const replacementSourceIds = useMemo(
    () => new Set(replacementSessions.map((session) => session.replanSourceSessionId as string)),
    [replacementSessions],
  );

  /** 预演结果：对当前选中取消段在所选备用夜上生成可执行安排（确认前只读、不落库） */
  const replanPreview: ReplanEvaluation[] = useMemo(() => {
    if (!replanOpen || !replanNight || selectedCancelled.length === 0) return [];
    const night = nights.find((item) => item.id === replanNight);
    if (!night) return [];
    return evaluateReplan(selectedCancelled, night, targets, sessions, telescopes);
  }, [replanOpen, replanNight, selectedCancelled, nights, targets, sessions, telescopes]);
  const replanSummary = useMemo(() => summarizeReplan(replanPreview), [replanPreview]);

  const visible = useMemo(() => {
    return [...sessions]
      .filter((session) => {
        if (nightFilter !== '全部' && session.nightId !== nightFilter) return false;
        if (statusFilter !== '全部' && session.status !== statusFilter) return false;
        if (onlyConflict && !conflictSet.has(session.id)) return false;
        if (sourceFilter === 'replacement' && !session.replanSourceSessionId) return false;
        if (sourceFilter.startsWith('src:') && session.replanSourceSessionId !== sourceFilter.slice(4)) return false;
        return true;
      })
      .sort((a, b) => a.nightId.localeCompare(b.nightId) || axisMinutes(a.startTime) - axisMinutes(b.startTime));
  }, [sessions, nightFilter, statusFilter, onlyConflict, conflictSet, sourceFilter]);

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const telescopeById = (id: string) => telescopes.find((item) => item.id === id);
  const instrumentById = (id: string) => instruments.find((item) => item.id === id);
  const nightById = (id: string) => nights.find((night) => night.id === id);

  const liveConflicts = useMemo(() => {
    if (!dialogOpen) return [];
    return findConflicts({
      nightId: form.nightId,
      telescopeId: form.telescopeId,
      startTime: form.startTime,
      endTime: form.endTime,
      ignoreSessionId: editingId || undefined,
    });
  }, [dialogOpen, findConflicts, form.nightId, form.telescopeId, form.startTime, form.endTime, editingId]);

  function openCreate() {
    setEditingId('');
    setError('');
    const night = nights.find((item) => item.primary) ?? nights[0];
    const telescope = telescopes.find((item) => item.status === '可用') ?? telescopes[0];
    const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
    setForm({
      nightId: night?.id ?? '',
      targetId: targets[0]?.id ?? '',
      startTime: '20:00',
      endTime: '21:00',
      telescopeId: telescope?.id ?? '',
      instrumentId: instrument?.id ?? '',
      filterSlot: 'L',
      plannedFrames: 30,
      status: '待执行',
      rescheduleReason: '',
    });
    setDialogOpen(true);
  }

  function openEdit(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    setEditingId(id);
    setError('');
    setForm({
      nightId: session.nightId,
      targetId: session.targetId,
      startTime: session.startTime,
      endTime: session.endTime,
      telescopeId: session.telescopeId,
      instrumentId: session.instrumentId,
      filterSlot: session.filterSlot,
      plannedFrames: session.plannedFrames,
      status: session.status,
      rescheduleReason: session.rescheduleReason ?? '',
    });
    setDialogOpen(true);
  }

  async function submit() {
    if (!form.nightId || !form.targetId || !form.telescopeId) {
      setError('观测夜、目标与望远镜均为必填');
      return;
    }
    if (durationMinutes(form.startTime, form.endTime) <= 0) {
      setError('结束时刻必须晚于开始时刻');
      return;
    }
    if (liveConflicts.length > 0) {
      setError('该望远镜在所选时段已有排程，请调整时段或改期到备用观测夜');
      return;
    }
    if (editingId) {
      await updateSession(editingId, { ...form, rescheduleReason: form.rescheduleReason });
      setNotice('已更新排程段');
    } else {
      await addSession({ ...form, rescheduleReason: form.rescheduleReason });
      setNotice('已新增排程段');
    }
    setDialogOpen(false);
  }

  async function submitReschedule() {
    if (!rescheduleNight) {
      setError('请选择备用观测夜');
      return;
    }
    const count = await rescheduleToBackup(selected, rescheduleNight, rescheduleReason);
    setNotice(`已将 ${count} 个排程段改期至 ${nightById(rescheduleNight)?.date ?? rescheduleNight}，原因：${rescheduleReason || '未填写'}`);
    setSelected([]);
    setRescheduleOpen(false);
    setRescheduleReason('');
  }

  /** 打开「生成替补安排」：默认取选中段共同指向的备用夜，沿用首个取消原因 */
  function openReplan() {
    const preferred = selectedCancelled[0]?.backupNightId ?? backupNights[0]?.id ?? '';
    setReplanNight(preferred);
    setReplanReason(selectedCancelled[0]?.rescheduleReason ?? '');
    setReplanError('');
    setReplanOpen(true);
  }

  /**
   * 确认替补安排：先由预演映射出落库指令，再走 store 的事务化提交。
   * 任何一段二次校验失败都会整体回滚，页面与本地数据保持确认前状态。
   */
  async function confirmReplan() {
    if (!replanNight) {
      setReplanError('请选择备用观测夜');
      return;
    }
    const night = nights.find((item) => item.id === replanNight);
    const items: ReplanCommitItem[] = replanPreview.map((evaluation) => ({
      sourceId: evaluation.source.id,
      outcome: evaluation.outcome,
      blockReason: evaluation.blockReason,
      detail: evaluation.detail,
      newSession: evaluation.slot
        ? { startTime: evaluation.slot.startTime, endTime: evaluation.slot.endTime, note: evaluation.slot.note }
        : undefined,
    }));
    setApplying(true);
    setReplanError('');
    try {
      const result = await applyReplanPlan(replanNight, replanReason, items);
      setNotice(
        `已在 ${night?.date ?? replanNight} 生成 ${result.added.length} 段替补排程；` +
          `${replanSummary.conflict} 段设备冲突、${replanSummary.infeasible} 段无法安排已保留取消状态并写明原因`,
      );
      setReplanOpen(false);
      setSelected([]);
      setReplanReason('');
    } catch (reason) {
      setReplanError(`替补安排已停止，未写入任何改动：${(reason as Error).message}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        排程段列表与冲突检测
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        同一时段同一望远镜重复排入即进入冲突列表；勾选「因云取消」段后可在备用夜预演替补安排（按最低高度与设备占用找位置，月相偏高时窄带目标优先），确认后可安排的复制为替补夜排程，无法安排的保留取消并写明高度、月相或设备原因。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      {highlightId ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          已从设备分配视图定位到排程段 <strong>{highlightId}</strong>（对应行已用左侧红条标出）
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增排程段
        </Button>
        <Button variant="contained" color="success" disabled={selectedCancelled.length === 0} onClick={openReplan}>
          生成替补安排（取消段 {selectedCancelled.length}）
        </Button>
        <Button variant="outlined" color="warning" disabled={selected.length === 0} onClick={() => setRescheduleOpen(true)}>
          仅标记改期（已选 {selected.length}）
        </Button>
        <TextField
          select
          size="small"
          label="来源追溯"
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="全部">全部排程段</MenuItem>
          <MenuItem value="replacement">仅看替补生成段（{replacementSessions.length}）</MenuItem>
          {[...new Set(sessions.filter((session) => session.status === '因云取消'))]
            .filter((session) => replacementSourceIds.has(session.id))
            .map((session) => (
              <MenuItem key={session.id} value={`src:${session.id}`}>
                来源：{session.id}（{targetById(session.targetId)?.name ?? '未知目标'}）
              </MenuItem>
            ))}
        </TextField>
        <TextField select size="small" label="观测夜" value={nightFilter} onChange={(event) => setNightFilter(event.target.value)} sx={{ minWidth: 200 }}>
          {['全部', ...nights.map((night) => night.id)].map((id) => (
            <MenuItem key={id} value={id}>
              {id === '全部' ? '全部' : `${nightById(id)?.date ?? id}${nightById(id)?.primary ? '（主夜）' : '（备用夜）'}`}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 140 }}>
          {['全部', ...SESSION_STATUSES].map((status) => (
            <MenuItem key={status} value={status}>
              {status}
            </MenuItem>
          ))}
        </TextField>
        <Button variant={onlyConflict ? 'contained' : 'outlined'} color="error" onClick={() => setOnlyConflict((value) => !value)}>
          仅看冲突（{conflictSet.size} 段）
        </Button>
        <Chip size="small" label={`命中 ${visible.length} / ${sessions.length}`} />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={visible.length > 0 && selected.length === visible.length}
                  onChange={(event) => setSelected(event.target.checked ? visible.map((session) => session.id) : [])}
                />
              </TableCell>
              <TableCell>观测夜</TableCell>
              <TableCell>时段</TableCell>
              <TableCell>目标</TableCell>
              <TableCell>望远镜 / 终端</TableCell>
              <TableCell>滤镜</TableCell>
              <TableCell align="right">帧数</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>冲突</TableCell>
              <TableCell>替补 / 原因</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((session) => {
              const conflicts = findConflicts({
                nightId: session.nightId,
                telescopeId: session.telescopeId,
                startTime: session.startTime,
                endTime: session.endTime,
                ignoreSessionId: session.id,
              });
              return (
                <TableRow
                  key={session.id}
                  hover
                  selected={selected.includes(session.id)}
                  sx={session.id === highlightId ? { boxShadow: 'inset 4px 0 0 #d32f2f' } : undefined}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(session.id)}
                      onChange={(event) =>
                        setSelected((prev) => (event.target.checked ? [...prev, session.id] : prev.filter((id) => id !== session.id)))
                      }
                    />
                  </TableCell>
                  <TableCell>{nightById(session.nightId)?.date ?? session.nightId}</TableCell>
                  <TableCell>
                    {session.startTime}-{session.endTime}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {formatMinutes(durationMinutes(session.startTime, session.endTime))}
                    </Typography>
                  </TableCell>
                  <TableCell>{targetById(session.targetId)?.name ?? '未知目标'}</TableCell>
                  <TableCell>
                    {telescopeById(session.telescopeId)?.code ?? '-'} / {instrumentById(session.instrumentId)?.model ?? '-'}
                  </TableCell>
                  <TableCell>{session.filterSlot}</TableCell>
                  <TableCell align="right">{session.plannedFrames}</TableCell>
                  <TableCell>
                    <StatusChip status={session.status} />
                  </TableCell>
                  <TableCell>
                    <ConflictBadge conflicts={conflicts} compact />
                  </TableCell>
                  <TableCell>
                    {session.replanSourceSessionId ? (
                      <Box>
                        <Chip
                          size="small"
                          color="success"
                          variant="outlined"
                          label={`替补自 ${session.replanSourceSessionId}`}
                          onClick={() => setSourceFilter(`src:${session.replanSourceSessionId}`)}
                        />
                        {session.replanNote ? (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                            {session.replanNote}
                          </Typography>
                        ) : null}
                      </Box>
                    ) : session.rescheduleReason ? (
                      <Typography variant="caption">{session.rescheduleReason}</Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        -
                      </Typography>
                    )}
                    <Box sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {session.backupNightId && !session.replanSourceSessionId ? (
                        <Chip size="small" variant="outlined" label={`替补夜 ${nightById(session.backupNightId)?.date ?? session.backupNightId}`} />
                      ) : null}
                      {session.replanOutcome ? <ReplanOutcomeChip outcome={session.replanOutcome} /> : null}
                    </Box>
                    {session.replanDetail ? (
                      <Typography variant="caption" color={session.replanOutcome === '可安排' ? 'text.secondary' : 'error.main'} sx={{ display: 'block', mt: 0.25 }}>
                        {session.replanDetail}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => openEdit(session.id)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => void removeSession(session.id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? '编辑排程段' : '新增排程段'}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          {liveConflicts.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              该望远镜在所选时段已有 {liveConflicts.length} 段排程：
              {liveConflicts.map((conflict) => ` ${conflict.otherId}（${conflict.overlapText}）`).join('；')}
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mb: 1.5 }}>
              时段校验通过，该望远镜此时段空闲
            </Alert>
          )}
          <FieldRow label="观测夜" required>
            <TextField select size="small" fullWidth value={form.nightId} onChange={(event) => setForm({ ...form, nightId: event.target.value })}>
              {nights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.siteName}${night.primary ? '（主夜）' : night.backup ? '（备用夜）' : ''}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="观测目标" required>
            <TextField select size="small" fullWidth value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })}>
              {targets.map((target) => (
                <MenuItem key={target.id} value={target.id}>
                  {`${target.name}（${target.catalog}）· ${target.magnitude} 等`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="开始时刻" required hint="格式 HH:mm，可跨零点">
            <TextField size="small" fullWidth value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} placeholder="20:00" />
          </FieldRow>
          <FieldRow label="结束时刻" required>
            <TextField size="small" fullWidth value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} placeholder="21:30" />
          </FieldRow>
          <FieldRow label="望远镜" required>
            <TextField
              select
              size="small"
              fullWidth
              value={form.telescopeId}
              onChange={(event) => {
                const telescope = telescopes.find((item) => item.id === event.target.value);
                const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
                setForm({ ...form, telescopeId: event.target.value, instrumentId: instrument?.id ?? '' });
              }}
            >
              {telescopes.map((telescope) => (
                <MenuItem key={telescope.id} value={telescope.id}>
                  {`${telescope.code} · ${telescope.apertureMm}mm f/${(telescope.focalLengthMm / telescope.apertureMm).toFixed(1)} · ${telescope.status}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="终端">
            <TextField select size="small" fullWidth value={form.instrumentId} onChange={(event) => setForm({ ...form, instrumentId: event.target.value })}>
              {instruments
                .filter((instrument) => instrument.telescopeCode === telescopeById(form.telescopeId)?.code)
                .map((instrument) => (
                  <MenuItem key={instrument.id} value={instrument.id}>
                    {`${instrument.model} · ${instrument.terminalType}`}
                  </MenuItem>
                ))}
            </TextField>
          </FieldRow>
          <FieldRow label="滤镜轮位">
            <TextField select size="small" fullWidth value={form.filterSlot} onChange={(event) => setForm({ ...form, filterSlot: event.target.value })}>
              {FILTER_NAMES.map((filter) => (
                <MenuItem key={filter} value={filter}>
                  {filter}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="计划帧数" required>
            <TextField size="small" type="number" fullWidth value={form.plannedFrames} onChange={(event) => setForm({ ...form, plannedFrames: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="状态">
            <TextField select size="small" fullWidth value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SessionStatus })}>
              {SESSION_STATUSES.map((status) => (
                <MenuItem key={status} value={status}>
                  {status}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因">
            <TextField size="small" fullWidth multiline minRows={2} value={form.rescheduleReason} onChange={(event) => setForm({ ...form, rescheduleReason: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submit()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={rescheduleOpen} onClose={() => setRescheduleOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>批量改期到备用观测夜</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            已选 {selected.length} 个排程段，改期后状态将置为「因云取消」并记录替补夜与改期原因。
          </Alert>
          <FieldRow label="备用观测夜" required>
            <TextField select size="small" fullWidth value={rescheduleNight} onChange={(event) => setRescheduleNight(event.target.value)}>
              {backupNights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.cloudText} · 月相 ${night.moonPhasePct}% · ${night.dutyOfficer}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因" required hint="例如：夜间云量转多云，目标被云遮挡">
            <TextField size="small" fullWidth multiline minRows={2} value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRescheduleOpen(false)}>取消</Button>
          <Button variant="contained" color="warning" onClick={() => void submitReschedule()}>
            确认改期
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={replanOpen} onClose={() => (applying ? undefined : setReplanOpen(false))} maxWidth="md" fullWidth>
        <DialogTitle>生成可执行的替补安排</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            本次勾选 {selected.length} 段，其中 {selectedCancelled.length} 段「因云取消」参与替补规划
            {selected.length > selectedCancelled.length ? `，其余 ${selected.length - selectedCancelled.length} 段非取消状态会被忽略` : ''}
            。在备用夜按目标最低高度与望远镜占用预演位置；月相偏高时窄带（Ha / OIII / SII）目标优先。确认后可安排的复制为该夜排程并标明来源，冲突与无法安排的段保留取消状态并写明原因。
          </Alert>
          {replanError ? (
            <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setReplanError('')}>
              {replanError}
            </Alert>
          ) : null}
          <FieldRow label="备用观测夜" required labelWidth={110}>
            <TextField select size="small" fullWidth value={replanNight} onChange={(event) => setReplanNight(event.target.value)}>
              {backupNights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.cloudText} · 月相 ${night.moonPhasePct}% · ${night.dutyOfficer}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="云情原因" labelWidth={110} hint="会写回各来源段的改期原因，留空则沿用各段原有原因">
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={replanReason}
              onChange={(event) => setReplanReason(event.target.value)}
              placeholder="例如：夜间云量转多云，目标被云遮挡"
            />
          </FieldRow>

          <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, bgcolor: 'grey.50' }}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip color="success" label={`可安排 ${replanSummary.schedulable} 段`} />
              <Chip color="warning" label={`设备冲突 ${replanSummary.conflict} 段`} />
              <Chip color="error" label={`无法安排 ${replanSummary.infeasible} 段`} />
              <Chip variant="outlined" label={`合计 ${replanSummary.total} 段`} />
            </Stack>
          </Paper>

          <List dense disablePadding>
            {replanPreview.map((evaluation) => {
              const source = evaluation.source;
              const target = targetById(source.targetId);
              const telescope = telescopeById(source.telescopeId);
              return (
                <Box key={source.id}>
                  <ListItem alignItems="flex-start" sx={{ px: 0 }}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body2" component="span">
                            {source.id} · {target?.name ?? '未知目标'}（{target?.filter ?? '-'}）· {telescope?.code ?? '-'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" component="span">
                            原时段 {source.startTime}-{source.endTime}
                          </Typography>
                          <ReplanOutcomeChip outcome={evaluation.outcome} />
                        </Stack>
                      }
                      secondary={
                        evaluation.outcome === '可安排' && evaluation.slot ? (
                          <Typography variant="caption" component="span" color="success.dark">
                            {evaluation.slot.keptOriginal ? '保持原时刻 · ' : ''}
                            替补时段 {evaluation.slot.startTime}-{evaluation.slot.endTime}（可见窗口 {evaluation.slot.windowStart}-
                            {evaluation.slot.windowEnd}，峰值 {evaluation.slot.maxAltitude}°，阈值 {target?.minAltitude ?? '-'}°）
                          </Typography>
                        ) : (
                          <Typography variant="caption" component="span" color={evaluation.outcome === '冲突' ? 'warning.dark' : 'error.main'}>
                            {evaluation.detail}
                          </Typography>
                        )
                      }
                    />
                  </ListItem>
                  <Divider component="li" />
                </Box>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReplanOpen(false)} disabled={applying}>
            取消
          </Button>
          <Button variant="contained" color="success" onClick={() => void confirmReplan()} disabled={applying || replanPreview.length === 0}>
            {applying ? '提交中…' : `确认生成 ${replanSummary.schedulable} 段替补（其余保留取消）`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/** 替补规划结论徽标（表格与确认对话框共用） */
function ReplanOutcomeChip({ outcome }: { outcome: ObsSession['replanOutcome'] }) {
  if (!outcome) return null;
  if (outcome === '可安排') return <Chip size="small" color="success" label="替补已生成" />;
  if (outcome === '冲突') return <Chip size="small" color="warning" label="设备冲突" />;
  return <Chip size="small" color="error" label="无法安排" />;
}
