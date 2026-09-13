import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { checkLevel } from '../auth.js';
import { preheatUrls, purgeUrls, calcNextRun, loadUrls } from '../lib/cdn/preheatService.js';
import { fmtDateTime } from '../lib/util.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

export default async function preheatRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // 任务列表
  app.get('/api/cdn/preheat-tasks', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const rows = await query(`SELECT * FROM ${table('cdn_preheat_task')} ORDER BY id DESC`);
    return { code: 0, data: rows };
  });

  // 新建任务
  app.post('/api/cdn/preheat-tasks', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const b = req.body || {};
    const urls = String(b.urls || '').trim();
    if (!urls) return { code: -1, msg: '请填写需要预热的链接' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    const op = b.op === 'purge' ? 'purge' : 'preheat';
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写预热间隔的分钟数' };
    const nextRun = fmtDateTime(calcNextRun(cycle, intervalMin, runTime));
    const id: number = await query(
      `INSERT INTO ${table('cdn_preheat_task')} (name, urls, op, cycle, interval_min, run_time, active, next_run, addtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [String(b.name || ''), urls, op, cycle, intervalMin, runTime, b.active == 0 ? 0 : 1, nextRun],
    ).then((r: any) => r.insertId || 0);
    return { code: 0, msg: '创建成功', data: id };
  });

  // 编辑任务
  app.put('/api/cdn/preheat-tasks/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('cdn_preheat_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    const b = req.body || {};
    const urls = String(b.urls ?? row.urls).trim();
    if (!urls) return { code: -1, msg: '请填写需要预热的链接' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    const op = b.op === 'purge' ? 'purge' : 'preheat';
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写预热间隔的分钟数' };
    await query(
      `UPDATE ${table('cdn_preheat_task')} SET name = ?, urls = ?, op = ?, cycle = ?, interval_min = ?, run_time = ?, active = ? WHERE id = ?`,
      [String(b.name || ''), urls, op, cycle, intervalMin, runTime, b.active == 0 ? 0 : 1, id],
    );
    return { code: 0, msg: '保存成功' };
  });

  // 启用 / 停用
  app.post('/api/cdn/preheat-tasks/:id/toggle', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const active = (req.body || {}).active == 1 ? 1 : 0;
    await query(`UPDATE ${table('cdn_preheat_task')} SET active = ? WHERE id = ?`, [active, id]);
    return { code: 0, msg: active ? '已启用' : '已停用' };
  });

  // 立即执行
  app.post('/api/cdn/preheat-tasks/:id/run', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('cdn_preheat_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    const urls = loadUrls(row.urls);
    const result = row.op === 'purge' ? await purgeUrls(urls) : await preheatUrls(urls);
    const next = fmtDateTime(calcNextRun(row.cycle, row.interval_min, row.run_time));
    await query(`UPDATE ${table('cdn_preheat_task')} SET last_run = NOW(), next_run = ? WHERE id = ?`, [next, id]);
    return { code: 0, ...result };
  });

  // 删除任务
  app.delete('/api/cdn/preheat-tasks/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    await query(`DELETE FROM ${table('cdn_preheat_task')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });
}