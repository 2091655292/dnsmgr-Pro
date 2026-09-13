import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { checkLevel } from '../auth.js';
import { checkDomainRecords, calcNextRun } from '../lib/dns/checkService.js';
import { fmtDateTime } from '../lib/util.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

export default async function dnsCheckRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  app.get('/api/dns-check/tasks', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const rows = await query(`SELECT * FROM ${table('dns_check_task')} ORDER BY id DESC`);
    const domains: any[] = await query(`SELECT id, name FROM ${table('domain')} ORDER BY id DESC`);
    const nameMap = Object.fromEntries(domains.map((d: any) => [d.id, d.name]));
    const data = rows.map((r: any) => ({ ...r, domain_name: nameMap[r.did] || '' }));
    return { code: 0, data };
  });

  app.post('/api/dns-check/tasks', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const b = req.body || {};
    const did = Number(b.did) || 0;
    if (!did) return { code: -1, msg: '请选择域名' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写检测间隔的分钟数' };
    const nextRun = fmtDateTime(calcNextRun(cycle, intervalMin, runTime));
    const id: number = await query(
      `INSERT INTO ${table('dns_check_task')} (name, did, types, cycle, interval_min, run_time, notice_email, active, next_run, addtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [String(b.name || ''), did, String(b.types || ''), cycle, intervalMin, runTime, String(b.notice_email || ''), b.active == 0 ? 0 : 1, nextRun],
    ).then((r: any) => r.insertId || 0);
    return { code: 0, msg: '创建成功', data: id };
  });

  app.put('/api/dns-check/tasks/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    const b = req.body || {};
    const did = Number(b.did) || 0;
    if (!did) return { code: -1, msg: '请选择域名' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写检测间隔的分钟数' };
    await query(
      `UPDATE ${table('dns_check_task')} SET name = ?, did = ?, types = ?, cycle = ?, interval_min = ?, run_time = ?, notice_email = ?, active = ? WHERE id = ?`,
      [String(b.name || ''), did, String(b.types || ''), cycle, intervalMin, runTime, String(b.notice_email || ''), b.active == 0 ? 0 : 1, id],
    );
    return { code: 0, msg: '保存成功' };
  });

  app.post('/api/dns-check/tasks/:id/toggle', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const active = (req.body || {}).active == 1 ? 1 : 0;
    await query(`UPDATE ${table('dns_check_task')} SET active = ? WHERE id = ?`, [active, id]);
    return { code: 0, msg: active ? '已启用' : '已停用' };
  });

  app.post('/api/dns-check/tasks/:id/run', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    const types = String(row.types || '').split(/[,;，；]/).map((x: string) => x.trim().toUpperCase()).filter(Boolean);
    const result = await checkDomainRecords(row.did, types.length ? types : undefined);
    const next = fmtDateTime(calcNextRun(row.cycle, row.interval_min, row.run_time));
    await query(`UPDATE ${table('dns_check_task')} SET last_run = NOW(), next_run = ? WHERE id = ?`, [next, id]);
    return { code: 0, ...result };
  });

  app.delete('/api/dns-check/tasks/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    await query(`DELETE FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });
}