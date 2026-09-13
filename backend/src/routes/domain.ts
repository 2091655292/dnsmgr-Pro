import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { getDnsProvider } from '../lib/dns/factory.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
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
    const rows = await query(
      `SELECT A.*, B.type AS account_type, B.name AS account_name FROM ${table('domain')} A LEFT JOIN ${table('account')} B ON A.aid = B.id ORDER BY A.id DESC`,
    );
    const categories = await query(`SELECT id, name FROM ${table('domain_category')} ORDER BY sort ASC`);
    const catMap = Object.fromEntries(categories.map((c: any) => [c.id, c.name]));
    const data = rows.map((r: any) => ({ ...r, category_name: catMap[r.cid] || '' }));
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
    const { id } = req.params as any;
    await query(`DELETE FROM ${table('domain')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });

  // ============ 解析记录 ============
  app.get('/api/domains/:id/records', auth, async (req: any) => {
    const { id } = req.params as any;
    const q = req.query || {};
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
    const ok = await provider.setDomainRecordStatus(recordId, status);
    if (!ok) return { code: -1, msg: provider.getError() };
    return { code: 0, msg: '状态更新成功' };
  });
}

async function bumpRecordCount(domainId: number, delta: number) {
  await query(`UPDATE ${table('domain')} SET recordcount = GREATEST(recordcount + ?, 0) WHERE id = ?`, [delta, domainId]);
}