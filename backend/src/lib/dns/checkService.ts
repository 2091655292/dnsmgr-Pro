import { query, queryOne, table } from '../../db.js';
import { getDnsProvider } from './factory.js';
import { localResolve, recordValueMatches } from './localResolve.js';
import { getUserPermissions } from '../../auth.js';
import { configGet } from '../../config.js';
import { sendMail } from '../monitor/msgNotice.js';
import { fmtDateTime } from '../util.js';

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

export interface CheckIssue {
  name: string;
  type: string;
  value: string;
  status: 'not_found' | 'mismatch';
  actual: string[];
}

/** 拉取某域名全部记录（分页） */
async function fetchAllRecords(provider: any): Promise<any[]> {
  let list: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await provider.getDomainRecords(page, 500, null, null, null, null, null, null);
    if (res === false || !res.list || !res.list.length) break;
    list = list.concat(res.list);
    if (res.total && list.length >= res.total) break;
  }
  return list;
}

/** 某域名的可选检测子域名（记录中的非 @ 子域名前缀） */
export async function listSubDomains(did: number): Promise<string[]> {
  const d: any = await queryOne(`SELECT * FROM ${table('domain')} WHERE id = ?`, [did]);
  if (!d) return [];
  const acct: any = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [d.aid]);
  if (!acct) return [];
  const provider: any = getDnsProvider(acct.type, safeJson(acct.config), d.name, d.thirdid);
  if (!provider) return [];
  const list = await fetchAllRecords(provider);
  const subs = new Set<string>();
  for (const r of list) {
    const name = String(r.Name ?? '').trim();
    if (!name || name === '@' || name.startsWith('*')) continue;
    subs.add(name.toLowerCase().replace(/\.+$/, ''));
  }
  return [...subs].sort();
}

/** 本地检测某域名记录，返回异常项 */
export async function checkDomainRecords(
  did: number,
  types?: string[],
  uid?: number,
  sub?: string | null,
): Promise<{ total: number; issues: CheckIssue[]; error?: string }> {
  const d: any = await queryOne(`SELECT * FROM ${table('domain')} WHERE id = ?`, [did]);
  if (!d) return { total: 0, issues: [], error: '域名不存在' };
  const acct: any = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [d.aid]);
  if (!acct) return { total: 0, issues: [], error: '账户不存在' };
  const provider: any = getDnsProvider(acct.type, safeJson(acct.config), d.name, d.thirdid);
  if (!provider) return { total: 0, issues: [], error: '该厂商暂未支持' };

  // 权限范围：未传 uid 视为管理员（默认全量），否则按用户是否为管理员/是否开启检测整个域名决定
  let scopeAdmin = true;
  if (uid != null) {
    const u: any = await queryOne(`SELECT level, check_whole FROM ${table('user')} WHERE id = ?`, [uid]);
    const isAdmin = Number(u?.level ?? 0) >= 2;
    const whole = Number(u?.check_whole ?? 0) === 1;
    scopeAdmin = isAdmin || whole;
  }

  const list = await fetchAllRecords(provider);

  const subNorm = sub ? String(sub).trim().toLowerCase().replace(/\.+$/, '') : '';
  // 检测目标域名集合：普通用户未选子域名时为其所有接入域名，否则为指定子域名
  let targets: string[] = [];
  if (scopeAdmin) {
    if (subNorm) targets = [`${subNorm}.${d.name}`.toLowerCase()];
    else targets = [];
  } else {
    const perms = await getUserPermissions(uid as number);
    const access = perms
      .filter((p) => p.domain === d.name)
      .map((p) => (p.sub ? `${p.sub}.${d.name}` : d.name).toLowerCase());
    if (subNorm) targets = [`${subNorm}.${d.name}`.toLowerCase()];
    else targets = access;
  }
  const wholeDomain = scopeAdmin && !subNorm;

  const typeSet = types && types.length ? new Set(types) : null;
  const issues: CheckIssue[] = [];
  let checked = 0;
  for (const r of list) {
    if (typeSet && !typeSet.has(r.Type)) continue;
    if (r.Status === '0') continue;
    const value = Array.isArray(r.Value) ? r.Value[0] : r.Value;
    if (value === undefined || value === null || value === '') continue;
    const fullDomain = (r.Name === '@' ? d.name : `${r.Name}.${d.name}`).toLowerCase();
    // 校验层级：管理员未选子域名→整个域名；否则目标域名的严格子域名（比目标多至少一层）
    if (!wholeDomain && !targets.some((t) => fullDomain.endsWith('.' + t))) continue;
    checked++;
    const actual = await localResolve(fullDomain, r.Type);
    if (!actual.length) {
      issues.push({ name: r.Name, type: r.Type, value: String(value), status: 'not_found', actual: [] });
      continue;
    }
    if (!recordValueMatches(String(value), actual)) {
      issues.push({ name: r.Name, type: r.Type, value: String(value), status: 'mismatch', actual });
    }
  }
  return { total: checked, issues };
}

/** 根据任务配置计算下一次执行时间 */
export function calcNextRun(cycle: string, intervalMin: number, runTime: string | null): Date {
  const now = new Date();
  if (cycle === 'interval' && intervalMin > 0) {
    return new Date(now.getTime() + intervalMin * 60000);
  }
  const [h, m] = String(runTime || '00:00').split(':').map((x) => Number(x) || 0);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function splitTypes(s: string | null): string[] | undefined {
  const arr = String(s || '').split(/[,;，；]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  return arr.length ? arr : undefined;
}

/** 调度器入口：执行到期检测任务，发现劫持发邮件提醒 */
export async function executeCheckTasks(): Promise<number> {
  const rows: any[] = await query(
    `SELECT * FROM ${table('dns_check_task')} WHERE active = 1 AND (next_run IS NULL OR next_run <= NOW())`,
  );
  let run = 0;
  for (const t of rows) {
    const { issues } = await checkDomainRecords(t.did, splitTypes(t.types), t.uid, t.sub);
    if (issues && issues.length) {
      await notifyHijack(t, issues);
    }
    const next = calcNextRun(t.cycle, t.interval_min, t.run_time);
    await query(`UPDATE ${table('dns_check_task')} SET last_run = NOW(), next_run = ? WHERE id = ?`, [fmtDateTime(next), t.id]);
    run++;
  }
  return run;
}

async function notifyHijack(task: any, issues: CheckIssue[]): Promise<void> {
  const d: any = await queryOne(`SELECT name FROM ${table('domain')} WHERE id = ?`, [task.did]);
  const domain = d?.name || '';
  const to = String(task.notice_email || '').trim() || (await configGet('mail_recv')) || (await configGet('mail_name')) || '';
  if (!to) return;
  const title = `【DNS劫持告警】域名 ${domain} 部分解析记录异常`;
  let content = `尊敬的用户，您好：<br/>检测到域名 <b>${domain}</b> 的以下解析记录与本地解析结果不一致，可能存在 DNS 劫持：<br/><br/>`;
  content += `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse"><tr><th>主机记录</th><th>类型</th><th>期望值</th><th>本地解析值</th><th>状态</th></tr>`;
  for (const it of issues) {
    const status = it.status === 'not_found' ? '未查询到' : '不匹配';
    content += `<tr><td>${it.name}</td><td>${it.type}</td><td>${it.value}</td><td>${it.actual.join('<br/>') || '-'}</td><td><font color="red">${status}</font></td></tr>`;
  }
  content += `</table><br/><font color="grey">聚合DNS管理系统</font><br/><font color="grey">${fmtDateTime()}</font>`;
  await sendMail(to, title, content);
}