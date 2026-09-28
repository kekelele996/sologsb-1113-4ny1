import { useEffect, useMemo, useState } from 'react';
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
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import ConflictBadge from '../components/common/ConflictBadge';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { BackupPlanAbortError, useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { BACKUP_OUTCOME_COLOR, FILTER_NAMES, SESSION_STATUSES, type SessionStatus } from '../types';
import { axisMinutes, durationMinutes, formatMinutes } from '../utils/astro';
import { buildBackupPlan } from '../utils/backupPlan';

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
  const applyBackupPlan = useSessionStore((s) => s.applyBackupPlan);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const { findConflicts, conflictIds } = useConflictCheck();

  /** 支持从设备分配视图一键跳转：?night=<夜ID>&highlight=<排程段ID>；?source=<原取消段ID> 按来源追溯 */
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight') ?? '';
  const nightParam = searchParams.get('night') ?? '';
  const sourceParam = searchParams.get('source') ?? '';
  const [nightFilter, setNightFilter] = useState(nightParam || '全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [onlyConflict, setOnlyConflict] = useState(false);
  const [sourceFilter, setSourceFilter] = useState(sourceParam);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleNight, setRescheduleNight] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupNight, setBackupNight] = useState('');
  const [backupError, setBackupError] = useState('');
  const [applying, setApplying] = useState(false);
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

  const visible = useMemo(() => {
    return [...sessions]
      .filter((session) => {
        if (sourceFilter && session.sourceSessionId !== sourceFilter && session.id !== sourceFilter) return false;
        if (!sourceFilter && nightFilter !== '全部' && session.nightId !== nightFilter) return false;
        if (!sourceFilter && statusFilter !== '全部' && session.status !== statusFilter) return false;
        if (!sourceFilter && onlyConflict && !conflictSet.has(session.id)) return false;
        return true;
      })
      .sort((a, b) => a.nightId.localeCompare(b.nightId) || axisMinutes(a.startTime) - axisMinutes(b.startTime));
  }, [sessions, nightFilter, statusFilter, onlyConflict, conflictSet, sourceFilter]);

  const selectedSessions = useMemo(() => sessions.filter((session) => selected.includes(session.id)), [sessions, selected]);
  const selectedCanceled = useMemo(() => selectedSessions.filter((session) => session.status === '因云取消'), [selectedSessions]);

  /** 替补试算（纯计算，确认前不写数据；备用夜或勾选变化时自动重算） */
  const backupPlan = useMemo(() => {
    if (!backupOpen || !backupNight || selectedCanceled.length === 0) return null;
    return buildBackupPlan(
      selectedCanceled.map((session) => session.id),
      backupNight,
      { sessions, nights, targets, telescopes, instruments },
    );
  }, [backupOpen, backupNight, selectedCanceled, sessions, nights, targets, telescopes, instruments]);

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

  /** 打开「生成替补安排」：只有「因云取消」段进入试算 */
  function openBackup() {
    const invalid = selectedSessions.filter((session) => session.status !== '因云取消');
    if (invalid.length > 0) {
      setError(`生成替补安排仅处理「因云取消」段，已选中的 ${invalid.map((session) => session.id).join('、')} 不适合处理，请取消勾选`);
      return;
    }
    if (selectedCanceled.length === 0) {
      setError('请勾选至少一段「因云取消」的排程段');
      return;
    }
    setError('');
    setBackupError('');
    // 默认取勾选段共同的替补夜；不统一时取第一个备用夜
    const preferred = selectedCanceled[0]?.backupNightId;
    const common = preferred && backupNights.some((night) => night.id === preferred) ? preferred : backupNights[0]?.id ?? '';
    setBackupNight(common);
    setBackupOpen(true);
  }

  /** 确认替补安排：可安排的复制成替补段，不能安排的回写原因；任何一段失败先停止并整体回滚 */
  async function submitBackup() {
    if (!backupPlan) return;
    if (backupPlan.errors.length > 0) {
      setBackupError(`试算数据有误，已停止：${backupPlan.errors.join('；')}`);
      return;
    }
    setApplying(true);
    try {
      const { placed, blocked } = await applyBackupPlan(backupPlan);
      setNotice(`替补安排已确认：新增 ${placed.length} 段可执行替补排程，${blocked} 段保留取消并写明原因（可安排 ${backupPlan.placedCount} / 冲突 ${backupPlan.conflictCount} / 无法安排 ${backupPlan.blockedCount}）`);
      setBackupOpen(false);
      setSelected([]);
    } catch (reason) {
      // 事务已回滚：页面与本地数据均为确认前状态
      if (reason instanceof BackupPlanAbortError) {
        setBackupError(`处理失败，已在「${reason.sourceId}」停止整批操作，未写入任何替补段：${reason.message}`);
      } else {
        setBackupError(`写入本地数据失败，已停止并保留确认前状态：${(reason as Error).message}`);
      }
    } finally {
      setApplying(false);
    }
  }

  /** 按来源查回：原取消段与其替补段一起过滤显示 */
  function traceSource(id: string) {
    setSourceFilter(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('source', id);
      return next;
    });
  }

  function clearSourceFilter() {
    setSourceFilter('');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('source');
      return next;
    });
  }

  // 浏览器前进 / 后退时同步来源筛选
  useEffect(() => {
    setSourceFilter(searchParams.get('source') ?? '');
  }, [searchParams]);

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        排程段列表与冲突检测
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        同一时段同一望远镜重复排入即进入冲突列表；支持勾选多个排程段批量改期到备用观测夜并填写改期原因。
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

      {sourceFilter ? (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          onClose={clearSourceFilter}
          action={
            <Button color="inherit" size="small" onClick={clearSourceFilter}>
              退出追溯
            </Button>
          }
        >
          正在按来源追溯：原取消段 <strong>{sourceFilter}</strong> 与其新增替补段（{visible.length} 条）。替补段带有「来源」标记，取消段带有上次试算的高度 / 月相 / 设备原因。
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增排程段
        </Button>
        <Button variant="outlined" color="warning" disabled={selected.length === 0} onClick={() => setRescheduleOpen(true)}>
          批量改期到备用夜（已选 {selected.length}）
        </Button>
        <Tooltip title="为勾选的「因云取消」段按最低高度、月相与望远镜占用在备用夜试算，确认后复制成可执行替补段">
          <Button variant="contained" color="success" disabled={selected.length === 0} onClick={openBackup}>
            生成替补安排（已选 {selected.length}）
          </Button>
        </Tooltip>
        {!sourceFilter ? (
          <TextField select size="small" label="观测夜" value={nightFilter} onChange={(event) => setNightFilter(event.target.value)} sx={{ minWidth: 200 }}>
            {['全部', ...nights.map((night) => night.id)].map((id) => (
              <MenuItem key={id} value={id}>
                {id === '全部' ? '全部' : `${nightById(id)?.date ?? id}${nightById(id)?.primary ? '（主夜）' : '（备用夜）'}`}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        {!sourceFilter ? (
          <TextField select size="small" label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 140 }}>
            {['全部', ...SESSION_STATUSES].map((status) => (
              <MenuItem key={status} value={status}>
                {status}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        {!sourceFilter ? (
          <Button variant={onlyConflict ? 'contained' : 'outlined'} color="error" onClick={() => setOnlyConflict((value) => !value)}>
            仅看冲突（{conflictSet.size} 段）
          </Button>
        ) : null}
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
              <TableCell>改期原因 / 替补结果与来源</TableCell>
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
                    {session.rescheduleReason ? (
                      <Typography variant="caption" display="block">
                        {session.rescheduleReason}
                      </Typography>
                    ) : null}
                    {session.backupOutcome && session.status === '因云取消' ? (
                      <Tooltip title={session.backupReason ?? ''}>
                        <Chip
                          size="small"
                          color={BACKUP_OUTCOME_COLOR[session.backupOutcome]}
                          label={session.backupOutcome === '已替补' ? `已替补 → ${nightById(session.backupNightId ?? '')?.date ?? session.backupNightId ?? ''}` : `替补：${session.backupOutcome}`}
                          sx={{ mt: session.rescheduleReason ? 0.5 : 0 }}
                          onClick={() => traceSource(session.id)}
                        />
                      </Tooltip>
                    ) : null}
                    {session.backupReason && session.backupOutcome && session.backupOutcome !== '已替补' ? (
                      <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.25, maxWidth: 280 }}>
                        {session.backupReason}
                      </Typography>
                    ) : null}
                    {session.sourceSessionId ? (
                      <Tooltip title="按来源查回原取消段与全部替补段">
                        <Chip
                          size="small"
                          variant="outlined"
                          color="success"
                          label={`来源：${session.sourceNote ?? session.sourceSessionId}`}
                          sx={{ mt: 0.5 }}
                          onClick={() => traceSource(session.sourceSessionId as string)}
                        />
                      </Tooltip>
                    ) : null}
                    {!session.sourceSessionId && session.backupNightId && !session.backupOutcome ? (
                      <Chip size="small" variant="outlined" label={`替补夜 ${nightById(session.backupNightId)?.date ?? session.backupNightId}`} sx={{ mt: 0.5 }} onClick={() => traceSource(session.id)} />
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

      <Dialog open={backupOpen} onClose={() => (applying ? undefined : setBackupOpen(false))} maxWidth="md" fullWidth>
        <DialogTitle>为因云取消段生成替补安排</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            已选 {selectedCanceled.length} 段「因云取消」排程段。按目标最低地平高度找可见区间、再按望远镜占用找最早空档；
            月相 ≥ 60% 时只安排窄带（Ha/OIII/SII）目标。确认前不写入任何数据。
          </Alert>
          {backupError ? (
            <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setBackupError('')}>
              {backupError}
            </Alert>
          ) : null}
          <FieldRow label="替补观测夜" required>
            <TextField select size="small" fullWidth value={backupNight} onChange={(event) => setBackupNight(event.target.value)}>
              {backupNights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.cloudText} · 月相 ${night.moonPhasePct}%${night.moonPhasePct >= 60 ? '（偏高，窄带优先）' : ''} · ${night.dutyOfficer}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>

          {backupPlan ? (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: 1.5, mt: 0.5 }} flexWrap="wrap" useFlexGap>
                <Chip color="success" label={`可安排 ${backupPlan.placedCount} 段`} />
                <Chip color="error" label={`冲突（设备占用）${backupPlan.conflictCount} 段`} />
                <Chip color="warning" label={`无法安排 ${backupPlan.blockedCount} 段`} />
                {backupPlan.highMoon ? <Chip color="info" variant="outlined" label="本夜月相偏高，已将窄带目标排在前面找位" /> : null}
                <Chip variant="outlined" label={`合计 ${backupPlan.items.length} 段`} />
              </Stack>
              {backupPlan.errors.length > 0 ? (
                <Alert severity="error" sx={{ mb: 1.5 }}>
                  {backupPlan.errors.join('；')}
                </Alert>
              ) : null}
              <Divider sx={{ mb: 1 }} />
              <List dense disablePadding>
                {backupPlan.items.map((item) => {
                  const source = sessions.find((session) => session.id === item.sourceId);
                  const target = targetById(source?.targetId ?? '');
                  const telescope = item.telescopeId ? telescopeById(item.telescopeId) : undefined;
                  return (
                    <ListItem key={item.sourceId} disableGutters divider alignItems="flex-start">
                      <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ width: 1 }}>
                        <Chip size="small" color={BACKUP_OUTCOME_COLOR[item.outcome]} label={item.outcome} sx={{ mt: 0.25, minWidth: 72 }} />
                        <Box sx={{ flex: 1 }}>
                          <Typography variant="body2">
                            <strong>{item.sourceId}</strong> · {target?.name ?? '未知目标'}（{target?.filter}，阈值 {target?.minAltitude}°）
                            {item.startTime ? ` · 建议 ${item.startTime}-${item.endTime}` : ''}
                            {telescope ? ` · ${telescope.code}` : ''}
                          </Typography>
                          <Typography variant="caption" color={item.outcome === '已替补' ? 'success.main' : 'text.secondary'}>
                            {item.detail}
                          </Typography>
                        </Box>
                      </Stack>
                    </ListItem>
                  );
                })}
              </List>
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                确认后：可安排的段会复制为该备用夜上的待执行排程并标明来源；无法安排的段保留「因云取消」，原因（高度 / 月相 / 设备）写回原段。
                任何一段处理失败都会立即停止并整体回滚，页面与本地数据保持确认前状态。
              </Alert>
            </>
          ) : (
            <Alert severity="info" sx={{ mt: 1 }}>
              请选择一个备用观测夜进行试算。
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBackupOpen(false)} disabled={applying}>
            取消
          </Button>
          <Button
            variant="contained"
            color="success"
            disabled={!backupPlan || backupPlan.items.length === 0 || backupPlan.errors.length > 0 || applying}
            onClick={() => void submitBackup()}
          >
            {applying ? '正在写入…' : `确认替补安排（可安排 ${backupPlan?.placedCount ?? 0} / 冲突 ${backupPlan?.conflictCount ?? 0} / 无法安排 ${backupPlan?.blockedCount ?? 0}）`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
