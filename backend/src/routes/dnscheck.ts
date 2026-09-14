import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { checkLevel, getUserPermissions } from '../auth.js';
import { checkDomainRecords, calcNextRun, listSubDomains } from '../lib/dns/checkService.js';
import { fmtDateTime } from '../lib/util.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

export default async function dnsCheckRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // 任务列表：管理员看全部，普通用户只看自己的
  app.get('/api/dns-check/tasks', auth, async (req: any) => {
    const isAdmin = checkLevel(req.user, 2);
    const rows = isAdmin
      ? await query(`SELECT * FROM ${table('dns_check_task')} ORDER BY id DESC`)
      : await query(`SELECT * FROM ${table('dns_check_task')} WHERE uid = ? ORDER BY id DESC`, [req.user.uid]);
    const domains: any[] = await query(`SELECT id, name FROM ${table('domain')} ORDER BY id DESC`);
    const nameMap = Object.fromEntries(domains.map((d: any) => [d.id, d.name]));
    const data = rows.map((r: any) => ({ ...r, domain_name: nameMap[r.did] || '' }));
    return { code: 0, data };
  });

  // 普通用户可选的域名（其授权范围内的域名）
  app.get('/api/dns-check/domains', auth, async (req: any) => {
    if (checkLevel(req.user, 2)) {
      const rows = await query(`SELECT id, name FROM ${table('domain')} ORDER BY id DESC`);
      return { code: 0, data: rows };
    }
    const perms = await getUserPermissions(req.user.uid);
    const names = [...new Set(perms.map((p: any) => p.domain))];
    if (!names.length) return { code: 0, data: [] };
    const rows: any[] = await query(
      `SELECT id, name FROM ${table('domain')} WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY id DESC`,
      names,
    );
    return { code: 0, data: rows };
  });

  // 某域名的可选检测子域名：管理员返回记录中的子域名前缀，普通用户返回其接入子域名
  app.get('/api/dns-check/domains/:id/subs', auth, async (req: any) => {
    const did = Number(req.params.id);
    if (!did) return { code: -1, msg: '参数错误' };
    if (checkLevel(req.user, 2)) {
      const subs = await listSubDomains(did);
      return { code: 0, data: subs };
    }
    const d: any = await queryOne(`SELECT name FROM ${table('domain')} WHERE id = ?`, [did]);
    if (!d) return { code: 0, data: [] };
    const perms = await getUserPermissions(req.user.uid);
    const subs = perms
      .filter((p: any) => p.domain === d.name && p.sub)
      .map((p: any) => String(p.sub).toLowerCase().replace(/\.+$/, ''));
    return { code: 0, data: [...new Set(subs)] };
  });

  app.post('/api/dns-check/tasks', auth, async (req: any) => {
    const b = req.body || {};
    const did = Number(b.did) || 0;
    if (!did) return { code: -1, msg: '请选择域名' };
    if (!(await canAccessDomain(req.user, did))) return { code: -1, msg: '无权限检测该域名' };
    const sub = String(b.sub || '').trim() || null;
    if (sub && !(await canAccessSub(req.user, did, sub))) return { code: -1, msg: '无权限检测该子域名' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写检测间隔的分钟数' };
    const nextRun = fmtDateTime(calcNextRun(cycle, intervalMin, runTime));
    const id: number = await query(
      `INSERT INTO ${table('dns_check_task')} (name, did, uid, sub, types, cycle, interval_min, run_time, notice_email, active, next_run, addtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [String(b.name || ''), did, req.user.uid, sub, String(b.types || ''), cycle, intervalMin, runTime, String(b.notice_email || ''), b.active == 0 ? 0 : 1, nextRun],
    ).then((r: any) => r.insertId || 0);
    return { code: 0, msg: '创建成功', data: id };
  });

  app.put('/api/dns-check/tasks/:id', auth, async (req: any) => {
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    if (!checkLevel(req.user, 2) && Number(row.uid) !== req.user.uid) return { code: -1, msg: '无权限' };
    const b = req.body || {};
    const did = Number(b.did) || 0;
    if (!did) return { code: -1, msg: '请选择域名' };
    if (!(await canAccessDomain(req.user, did))) return { code: -1, msg: '无权限检测该域名' };
    const sub = String(b.sub || '').trim() || null;
    if (sub && !(await canAccessSub(req.user, did, sub))) return { code: -1, msg: '无权限检测该子域名' };
    const cycle = b.cycle === 'interval' ? 'interval' : 'daily';
    const intervalMin = b.cycle === 'interval' ? Number(b.interval_min) || 0 : 0;
    const runTime = cycle === 'daily' ? String(b.run_time || '00:00') : null;
    if (cycle === 'interval' && intervalMin <= 0) return { code: -1, msg: '请填写检测间隔的分钟数' };
    await query(
      `UPDATE ${table('dns_check_task')} SET name = ?, did = ?, sub = ?, types = ?, cycle = ?, interval_min = ?, run_time = ?, notice_email = ?, active = ? WHERE id = ?`,
      [String(b.name || ''), did, sub, String(b.types || ''), cycle, intervalMin, runTime, String(b.notice_email || ''), b.active == 0 ? 0 : 1, id],
    );
    return { code: 0, msg: '保存成功' };
  });

  app.post('/api/dns-check/tasks/:id/toggle', auth, async (req: any) => {
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT uid FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    if (!checkLevel(req.user, 2) && Number(row.uid) !== req.user.uid) return { code: -1, msg: '无权限' };
    const active = (req.body || {}).active == 1 ? 1 : 0;
    await query(`UPDATE ${table('dns_check_task')} SET active = ? WHERE id = ?`, [active, id]);
    return { code: 0, msg: active ? '已启用' : '已停用' };
  });

  app.post('/api/dns-check/tasks/:id/run', auth, async (req: any) => {
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT * FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    if (!checkLevel(req.user, 2) && Number(row.uid) !== req.user.uid) return { code: -1, msg: '无权限' };
    const types = String(row.types || '').split(/[,;，；]/).map((x: string) => x.trim().toUpperCase()).filter(Boolean);
    const result = await checkDomainRecords(row.did, types.length ? types : undefined, row.uid, row.sub);
    const next = fmtDateTime(calcNextRun(row.cycle, row.interval_min, row.run_time));
    await query(`UPDATE ${table('dns_check_task')} SET last_run = NOW(), next_run = ? WHERE id = ?`, [next, id]);
    return { code: 0, ...result };
  });

  app.delete('/api/dns-check/tasks/:id', auth, async (req: any) => {
    const id = Number(req.params.id);
    const row: any = await queryOne(`SELECT uid FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '任务不存在' };
    if (!checkLevel(req.user, 2) && Number(row.uid) !== req.user.uid) return { code: -1, msg: '无权限' };
    await query(`DELETE FROM ${table('dns_check_task')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });
}

async function canAccessDomain(user: any, did: number): Promise<boolean> {
  if (checkLevel(user, 2)) return true;
  const d: any = await queryOne(`SELECT name FROM ${table('domain')} WHERE id = ?`, [did]);
  if (!d) return false;
  const perms = await getUserPermissions(user.uid);
  return perms.some((p: any) => p.domain === d.name);
}

/** 校验普通用户选择的子域名是否落在其接入域名范围内 */
async function canAccessSub(user: any, did: number, sub: string): Promise<boolean> {
  if (checkLevel(user, 2)) return true;
  const d: any = await queryOne(`SELECT name FROM ${table('domain')} WHERE id = ?`, [did]);
  if (!d) return false;
  const perms = await getUserPermissions(user.uid);
  const access = perms
    .filter((p: any) => p.domain === d.name)
    .map((p: any) => (p.sub ? `${p.sub}.${d.name}` : d.name).toLowerCase());
  const s = sub.trim().toLowerCase().replace(/\.+$/, '');
  const target = `${s}.${d.name}`.toLowerCase();
  return access.some((a: string) => target === a || target.endsWith('.' + a));
}