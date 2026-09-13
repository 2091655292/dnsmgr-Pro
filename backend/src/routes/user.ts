import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { query, queryOne, table } from '../db.js';
import { checkLevel } from '../auth.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

function isNullOrEmpty(v: any): boolean {
  return v === null || v === undefined || v === '';
}

function insertAndGetId(sql: string, params: any[]): Promise<number> {
  return query(sql, params).then((r: any) => r.insertId || 0);
}

interface PermItem {
  domain: string;
  sub: string | null;
  readonly: number;
}

function normalizePermission(input: any[]): PermItem[] {
  const out: PermItem[] = [];
  for (const item of input || []) {
    if (typeof item === 'string') {
      out.push({ domain: item, sub: null, readonly: 0 });
    } else if (item && typeof item === 'object' && item.domain) {
      out.push({ domain: item.domain, sub: item.sub || null, readonly: Number(item.readonly || 0) });
    }
  }
  return out;
}

async function savePermissions(uid: number, input: any[]) {
  await query(`DELETE FROM ${table('permission')} WHERE uid = ?`, [uid]);
  for (const p of normalizePermission(input)) {
    await query(`INSERT INTO ${table('permission')} (uid, domain, sub, readonly) VALUES (?, ?, ?, ?)`, [uid, p.domain, p.sub, p.readonly]);
  }
}

export default async function userRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  // 域名列表（供权限选择）
  app.get('/api/user/domains', auth, async () => {
    const rows = await query(`SELECT id, name FROM ${table('domain')} ORDER BY id DESC`);
    return { code: 0, data: rows.map((r: any) => r.name) };
  });

  // 用户列表
  app.get('/api/users', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const q = req.query || {};
    const kw = (q.kw || '').trim();
    const offset = Number(q.offset || 0);
    const limit = Number(q.limit || 10);
    const sort = q.sortName || '';
    const orderDir = String(q.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let where = '';
    const params: any[] = [];
    if (kw) {
      where = ' WHERE (username LIKE ? OR id LIKE ?)';
      params.push('%' + kw + '%', '%' + kw + '%');
    }

    const totalRow = await queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table('user')}${where}`, params);
    const total = totalRow?.c ?? 0;

    const allowedSort: Record<string, string> = { id: 'id', username: 'username', level: 'level', is_api: 'is_api', regtime: 'regtime', lasttime: 'lasttime', status: 'status' };
    const orderBy = allowedSort[sort] ? `${allowedSort[sort]} ${orderDir}` : 'id DESC';

    const list = await query(
      `SELECT id, username, is_api, level, regtime, lasttime, status, totp_open FROM ${table('user')}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { code: 0, data: { total, list } };
  });

  // 获取单个用户 + 权限
  app.get('/api/users/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row = await queryOne(`SELECT id, username, is_api, apikey, level, status, totp_open FROM ${table('user')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '用户不存在' };
    const perms = await query(`SELECT domain, sub, readonly FROM ${table('permission')} WHERE uid = ?`, [id]);
    row.permission = perms.map((p: any) => ({ domain: p.domain, sub: p.sub || null, readonly: Number(p.readonly || 0) }));
    return { code: 0, data: row };
  });

  // 添加用户
  app.post('/api/users', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const b = req.body || {};
    const username = (b.username || '').trim();
    const password = (b.password || '').trim();
    const isApi = Number(b.is_api || 0);
    const apikey = (b.apikey || '').trim();
    const level = Number(b.level || 1);
    const permission = Array.isArray(b.permission) ? b.permission : [];

    if (!username || !password) return { code: -1, msg: '用户名或密码不能为空' };
    if (isApi === 1 && !apikey) return { code: -1, msg: 'API密钥不能为空' };
    const exists = await queryOne(`SELECT id FROM ${table('user')} WHERE username = ?`, [username]);
    if (exists) return { code: -1, msg: '用户名已存在' };

    const uid = await insertAndGetId(
      `INSERT INTO ${table('user')} (username, password, is_api, apikey, level, regtime, status) VALUES (?, ?, ?, ?, ?, NOW(), 1)`,
      [username, bcrypt.hashSync(password, 10), isApi, apikey, level]
    );
    if (level === 1) {
      await savePermissions(uid, permission);
    }
    return { code: 0, msg: '添加用户成功！' };
  });

  // 编辑用户
  app.put('/api/users/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const row = await queryOne(`SELECT id FROM ${table('user')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '用户不存在' };

    const b = req.body || {};
    const username = (b.username || '').trim();
    const isApi = Number(b.is_api || 0);
    const apikey = (b.apikey || '').trim();
    let level = Number(b.level || 1);
    const repwd = (b.repwd || '').trim();
    const permission = Array.isArray(b.permission) ? b.permission : [];

    if (!username) return { code: -1, msg: '用户名不能为空' };
    if (isApi === 1 && !apikey) return { code: -1, msg: 'API密钥不能为空' };
    const exists = await queryOne(`SELECT id FROM ${table('user')} WHERE username = ? AND id <> ?`, [username, id]);
    if (exists) return { code: -1, msg: '用户名已存在' };
    if (level === 1 && (id === 1000 || id === req.user.uid)) {
      level = 2;
    }

    await query(`UPDATE ${table('user')} SET username = ?, is_api = ?, apikey = ?, level = ? WHERE id = ?`, [username, isApi, apikey, level, id]);
    if (level === 1) {
      await savePermissions(id, permission);
    } else {
      await query(`DELETE FROM ${table('permission')} WHERE uid = ?`, [id]);
    }
    if (repwd) {
      await query(`UPDATE ${table('user')} SET password = ? WHERE id = ?`, [bcrypt.hashSync(repwd, 10), id]);
    }
    return { code: 0, msg: '修改用户成功！' };
  });

  // 状态切换
  app.post('/api/users/:id/status', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    const status = Number((req.body || {}).status);
    if (id === 1000) return { code: -1, msg: '此用户无法修改状态' };
    if (id === req.user.uid) return { code: -1, msg: '当前登录用户无法修改状态' };
    await query(`UPDATE ${table('user')} SET status = ? WHERE id = ?`, [status, id]);
    return { code: 0, msg: '设置成功' };
  });

  // 删除用户
  app.delete('/api/users/:id', auth, async (req: any) => {
    if (!checkLevel(req.user, 2)) return { code: -1, msg: '无权限' };
    const id = Number(req.params.id);
    if (id === 1000) return { code: -1, msg: '此用户无法删除' };
    if (id === req.user.uid) return { code: -1, msg: '当前登录用户无法删除' };
    await query(`DELETE FROM ${table('user')} WHERE id = ?`, [id]);
    await query(`DELETE FROM ${table('permission')} WHERE uid = ?`, [id]);
    return { code: 0, msg: '删除成功' };
  });

  // 操作日志列表
  app.get('/api/logs', auth, async (req: any) => {
    const q = req.query || {};
    const uid = (q.uid || '').trim();
    const domain = (q.domain || '').trim();
    const kw = (q.kw || '').trim();
    const offset = Number(q.offset || 0);
    const limit = Number(q.limit || 10);

    let where = ' WHERE 1=1';
    const params: any[] = [];
    if (req.user.level === 1) {
      where += ' AND uid = ?';
      params.push(req.user.uid);
    } else if (req.user.level >= 2) {
      if (!isNullOrEmpty(uid)) {
        where += ' AND uid = ?';
        params.push(Number(uid));
      }
    }
    if (kw) {
      where += ' AND (action LIKE ? OR data LIKE ?)';
      params.push('%' + kw + '%', '%' + kw + '%');
    }
    if (domain) {
      where += ' AND domain = ?';
      params.push(domain);
    }

    const totalRow = await queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table('log')}${where}`, params);
    const total = totalRow?.c ?? 0;
    const rows = await query(`SELECT * FROM ${table('log')}${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { code: 0, data: { total, list: rows } };
  });
}