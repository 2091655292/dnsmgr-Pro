import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { getDnsProvider } from '../lib/dns/factory.js';
import { getUserPermissions, matchPermission, isRecordInScope, checkLevel, type SubPermission } from '../auth.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

const allRecordsCache = new Map<string, { at: number; list: any[] }>();
const RECORDS_TTL = 60_000;

/** 拉取某域名全部解析记录（带 60s 内存缓存），用于统计子域名记录数 */
async function fetchAllRecords(d: any): Promise<any[]> {
  const cached = allRecordsCache.get(d.name);
  if (cached && Date.now() - cached.at < RECORDS_TTL) return cached.list;
  let list: any[] = [];
  const acct = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [d.aid]);
  if (acct) {
    const provider = getDnsProvider(acct.type, safeJson(acct.config), d.name, d.thirdid);
    if (provider) {
      for (let page = 1; page <= 10; page++) {
        const r = await provider.getDomainRecords(page, 500, null, null, null, null, null, null);
        if (r === false || !r.list || !r.list.length) break;
        list = list.concat(r.list);
        if (list.length >= (r.total || 0)) break;
      }
    }
  }
  allRecordsCache.set(d.name, { at: Date.now(), list });
  return list;
}

async function getUserPerms(req: any): Promise<{ admin: boolean; perms: SubPermission[] }> {
  if (Number(req.user?.level ?? 0) >= 2) return { admin: true, perms: [] };
  return { admin: false, perms: await getUserPermissions(req.user.uid) };
}

/** 写操作权限校验，返回错误信息；为空表示允许 */
function writeErr(acc: { admin: boolean; perms: SubPermission[] }, domainName: string, recordName: string): string | null {
  if (acc.admin) return null;
  const m = matchPermission(acc.perms, domainName, String(recordName ?? ''));
  if (m < 0) return '无权限操作该子域名';
  if (m === 1) return '该子域名仅查看，禁止修改';
  return null;
}

/** 普通用户记录列表过滤：只保留授权子域名树内的记录 */
function filterRecords(acc: { admin: boolean; perms: SubPermission[] }, domainName: string, list: any[]): any[] {
  if (acc.admin) return list;
  const subs = new Set<string>();
  let full = false;
  for (const p of acc.perms) {
    if (p.domain !== domainName) continue;
    if (!p.sub) {
      full = true;
      break;
    }
    subs.add(p.sub);
  }
  if (full) return list;
  return list.filter((r: any) => {
    for (const s of subs) if (isRecordInScope(r.Name, s)) return true;
    return false;
  });
}

/** 返回当前用户对某域名的访问信息，供前端控制写操作按钮 */
function buildAccess(acc: { admin: boolean; perms: SubPermission[] }, domainName: string) {
  if (acc.admin) return { admin: true, readonly: false, writable: true, subs: [] };
  const mine = acc.perms.filter((p) => p.domain === domainName);
  const writable = mine.some((p) => p.readonly !== 1);
  return { admin: false, readonly: !writable, writable, subs: mine.map((p) => p.sub).filter(Boolean) };
}

async function getDomainWithAccount(domainId: number) {
  const d = await queryOne(`SELECT * FROM ${table('domain')} WHERE id = ?`, [domainId]);
  if (!d) return null;
  const acct = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [d.aid]);
  if (!acct) return null;
  return { domain: d, account: acct };
}

export default async function domainRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // ============ 域名管理 ============
  app.get('/api/domains', auth, async (req: any) => {
    const acc = await getUserPerms(req);
    const rows = await query(
      `SELECT A.*, B.type AS account_type, B.name AS account_name FROM ${table('domain')} A LEFT JOIN ${table('account')} B ON A.aid = B.id ORDER BY A.id DESC`,
    );
    const categories = await query(`SELECT id, name FROM ${table('domain_category')} ORDER BY sort ASC`);
    const catMap = Object.fromEntries(categories.map((c: any) => [c.id, c.name]));
    let data = rows.map((r: any) => ({ ...r, category_name: catMap[r.cid] || '' }));
    if (!acc.admin) {
      const byName = new Map(data.map((r: any) => [r.name, r]));
      const out: any[] = [];
      for (const p of acc.perms) {
        const d: any = byName.get(p.domain);
        if (!d) continue;
        const all = await fetchAllRecords(d);
        const cnt = p.sub ? all.filter((r: any) => isRecordInScope(r.Name, p.sub)).length : (all.length || Number(d.recordcount || 0));
        out.push({
          ...d,
          recordcount: cnt,
          expiretime: p.expiretime || d.expiretime || null,
          checkstatus: p.expiretime ? 1 : d.checkstatus,
          _key: `${d.id}:${p.sub || ''}`,
          _sub: p.sub || '',
          _readonly: Number(p.readonly || 0),
          _base_name: d.name,
          name: p.sub ? `${p.sub}.${d.name}` : d.name,
        });
      }
      data = out;
    }
    return { code: 0, data };
  });

  app.get('/api/domains/categories', auth, async () => {
    const rows = await query(`SELECT * FROM ${table('domain_category')} ORDER BY sort ASC, id ASC`);
    return { code: 0, data: rows };
  });

  app.post('/api/domains/categories', auth, async (req: any) => {
    const { name, remark } = req.body || {};
    if (!name) return { code: -1, msg: '分类名不能为空' };
    await query(`INSERT INTO ${table('domain_category')} (name, remark, sort, addtime) VALUES (?, ?, 0, NOW())`, [name, remark || '']);
    return { code: 0, msg: '添加分类成功' };
  });

  // 从 DNS 账户拉取云端域名列表（用于添加）
  app.get('/api/dns/accounts/:aid/pull', auth, async (req: any) => {
    const { aid } = req.params as any;
    const acct = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [aid]);
    if (!acct) return { code: -1, msg: '账户不存在' };
    const provider = getDnsProvider(acct.type, safeJson(acct.config), '', null);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    const res = await provider.getDomainList(null, 1, 100);
    if (res === false) return { code: -1, msg: provider.getError() };
    return { code: 0, data: res.list };
  });

  // 导入域名
  app.post('/api/domains', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const { aid, domain, thirdid, recordcount } = req.body || {};
    if (!aid || !domain) return { code: -1, msg: '参数不完整' };
    const exists = await queryOne(`SELECT id FROM ${table('domain')} WHERE name = ?`, [domain]);
    if (exists) return { code: -1, msg: '域名已存在' };
    const acct = await queryOne(`SELECT type FROM ${table('account')} WHERE id = ?`, [aid]);
    if (!acct) return { code: -1, msg: '账户不存在' };
    const id = await query(`INSERT INTO ${table('domain')} (aid, name, thirdid, recordcount, addtime) VALUES (?, ?, ?, ?, NOW())`, [
      aid, domain, thirdid || '', recordcount || 0,
    ]).then((r: any) => r.insertId || 0);
    return { code: 0, msg: '添加域名成功', data: id };
  });

  app.delete('/api/domains/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const { id } = req.params as any;
    await query(`DELETE FROM ${table('domain')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });

  // ============ 解析记录 ============
  app.get('/api/domains/:id/records', auth, async (req: any) => {
    const { id } = req.params as any;
    const q = req.query || {};
    const acc = await getUserPerms(req);
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    const res = await provider.getDomainRecords(
      Number(q.page || 1),
      Number(q.pagesize || 20),
      q.keyword || null,
      q.subdomain || null,
      q.value || null,
      q.type || null,
      q.line || null,
      q.status || null,
    );
    if (res === false) return { code: -1, msg: provider.getError() };
    if (!acc.admin) {
      res.list = filterRecords(acc, info.domain.name, res.list);
    }
    (res as any)._access = buildAccess(acc, info.domain.name);
    return { code: 0, data: res };
  });

  app.get('/api/domains/:id/lines', auth, async (req: any) => {
    const { id } = req.params as any;
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    const lines = await provider.getRecordLine();
    if (lines === false) return { code: -1, msg: provider.getError() };
    return { code: 0, data: lines };
  });

  app.post('/api/domains/:id/records', auth, async (req: any) => {
    const { id } = req.params as any;
    const { name, type, value, line, ttl, mx, weight, remark } = req.body || {};
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    {
      const acc = await getUserPerms(req);
      const err = writeErr(acc, info.domain.name, name);
      if (err) return { code: -1, msg: err };
    }
    const recordId = await provider.addDomainRecord(name, type, value, line || 'default', Number(ttl || 600), Number(mx || 1), weight ?? null, remark || null);
    if (!recordId) return { code: -1, msg: provider.getError() };
    if (remark && typeof (provider as any).updateDomainRecordRemark === 'function') {
      await (provider as any).updateDomainRecordRemark(recordId, remark);
    }
    await bumpRecordCount(id, 1);
    return { code: 0, msg: '添加记录成功', data: recordId };
  });

  app.post('/api/domains/:id/records/:recordId/remark', auth, async (req: any) => {
    const { id, recordId } = req.params as any;
    const remark = (req.body || {}).remark ?? null;
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider: any = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    {
      const acc = await getUserPerms(req);
      if (!acc.admin) {
        const cur = await provider.getDomainRecordInfo(recordId);
        if (!cur) return { code: -1, msg: '无权限操作该记录' };
        const err = writeErr(acc, info.domain.name, cur.Name);
        if (err) return { code: -1, msg: err };
      }
    }
    if (typeof provider.updateDomainRecordRemark === 'function') {
      const ok = await provider.updateDomainRecordRemark(recordId, remark);
      if (!ok) return { code: -1, msg: provider.getError() };
      return { code: 0, msg: '备注修改成功' };
    }
    const cur = await provider.getDomainRecordInfo(recordId);
    if (!cur) return { code: -1, msg: provider.getError?.() || '获取记录信息失败' };
    const ok = await provider.updateDomainRecord(recordId, cur.Name, cur.Type, cur.Value, cur.Line, cur.TTL, cur.MX, cur.Weight, remark);
    if (!ok) return { code: -1, msg: provider.getError?.() || '备注修改失败' };
    return { code: 0, msg: '备注修改成功' };
  });

  app.put('/api/domains/:id/records/:recordId', auth, async (req: any) => {
    const { id, recordId } = req.params as any;
    const { name, type, value, line, ttl, mx, weight, remark } = req.body || {};
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    {
      const acc = await getUserPerms(req);
      if (!acc.admin) {
        const cur = await (provider as any).getDomainRecordInfo(recordId);
        if (!cur) return { code: -1, msg: '无权限操作该记录' };
        let e = writeErr(acc, info.domain.name, cur.Name);
        if (e) return { code: -1, msg: e };
        e = writeErr(acc, info.domain.name, name);
        if (e) return { code: -1, msg: '新记录超出授权子域名范围' };
      }
    }
    const ok = await provider.updateDomainRecord(recordId, name, type, value, line || 'default', Number(ttl || 600), Number(mx || 1), weight ?? null, remark || null);
    if (!ok) return { code: -1, msg: provider.getError() };
    return { code: 0, msg: '修改记录成功' };
  });

  app.delete('/api/domains/:id/records/:recordId', auth, async (req: any) => {
    const { id, recordId } = req.params as any;
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    {
      const acc = await getUserPerms(req);
      if (!acc.admin) {
        const cur = await (provider as any).getDomainRecordInfo(recordId);
        if (!cur) return { code: -1, msg: '无权限操作该记录' };
        const e = writeErr(acc, info.domain.name, cur.Name);
        if (e) return { code: -1, msg: e };
      }
    }
    const ok = await provider.deleteDomainRecord(recordId);
    if (!ok) return { code: -1, msg: provider.getError() };
    await bumpRecordCount(id, -1);
    return { code: 0, msg: '删除成功' };
  });

  app.post('/api/domains/:id/records/:recordId/status', auth, async (req: any) => {
    const { id, recordId } = req.params as any;
    const { status } = req.body || {};
    const info = await getDomainWithAccount(id);
    if (!info) return { code: -1, msg: '域名或账户不存在' };
    const provider = getDnsProvider(info.account.type, safeJson(info.account.config), info.domain.name, info.domain.thirdid);
    if (!provider) return { code: -1, msg: '该厂商暂未支持' };
    {
      const acc = await getUserPerms(req);
      if (!acc.admin) {
        const cur = await (provider as any).getDomainRecordInfo(recordId);
        if (!cur) return { code: -1, msg: '无权限操作该记录' };
        const e = writeErr(acc, info.domain.name, cur.Name);
        if (e) return { code: -1, msg: e };
      }
    }
    const ok = await provider.setDomainRecordStatus(recordId, status);
    if (!ok) return { code: -1, msg: provider.getError() };
    return { code: 0, msg: '状态更新成功' };
  });
}

async function bumpRecordCount(domainId: number, delta: number) {
  await query(`UPDATE ${table('domain')} SET recordcount = GREATEST(recordcount + ?, 0) WHERE id = ?`, [delta, domainId]);
}