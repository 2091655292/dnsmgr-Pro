import { lookup } from 'whois';
import { query, table } from '../../db.js';
import { configGet, configSet } from '../../config.js';
import { sendExpireNotice } from '../monitor/msgNotice.js';
import { fmtDateTime } from '../util.js';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function whoisLookup(domain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(domain, { follow: 2, timeout: 20000 }, (err: any, data: string) => {
      if (err) reject(new Error(err?.message || 'whois查询失败'));
      else resolve(data);
    });
  });
}

/** RDAP 查询（HTTPS），作为 whois(43端口) 受限时的备用方案 */
async function rdapLookup(domain: string): Promise<{ creationDate: string | null; expirationDate: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'dnsmgr-pro' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('rdap查询失败');
    const data: any = await res.json();
    let expiration: string | null = null;
    let creation: string | null = null;
    for (const e of data.events || []) {
      if (e.eventAction === 'expiration' && !expiration) expiration = e.eventDate;
      if (e.eventAction === 'registration' && !creation) creation = e.eventDate;
    }
    return {
      creationDate: creation ? parseDateValue(String(creation)) : null,
      expirationDate: expiration ? parseDateValue(String(expiration)) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseDateValue(raw: string): string | null {
  let s = (raw || '').trim();
  if (!s) return null;
  s = s.split(/\s+/)[0];
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2}):(\d{1,2}))?/);
  if (iso) {
    const [y, mo, d, h = '00', mi = '00', se = '00'] = iso.slice(1);
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${se.padStart(2, '0')}`;
  }
  const beta = s.match(/^(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4})$/i);
  if (beta) {
    const [, d, m, y] = beta;
    return `${y}-${MONTHS[m.toLowerCase()]}-${d.padStart(2, '0')} 00:00:00`;
  }
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} 00:00:00`;
  }
  const plain = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (plain) {
    const [, y, mo, d] = plain;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} 00:00:00`;
  }
  return null;
}

const EXPIRY_RE =
  /(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|Expiration Time|Registry Expiration Date|Registrant Registration Expiration Date|Expires On|Expires|Paid-till|Expiration|到期时间)\s*:\s*(.+)$/i;
const CREATION_RE =
  /(?:Creation Date|Created Date|Created On|Created|Registration Time|Registration Date|Registered|Creation|创建时间|注册时间)\s*:\s*(.+)$/i;

function parseWhoisData(raw: string): { creationDate: string | null; expirationDate: string | null } {
  const lines = raw.split(/\r?\n/);
  let expiration: string | null = null;
  let creation: string | null = null;
  for (const line of lines) {
    const e = line.match(EXPIRY_RE);
    if (e && !expiration) expiration = parseDateValue(e[1]);
    const c = line.match(CREATION_RE);
    if (c && !creation) creation = parseDateValue(c[1]);
    if (expiration && creation) break;
  }
  return { creationDate: creation, expirationDate: expiration };
}

export async function getDomainDate(domain: string): Promise<{ regTime: string | null; expireTime: string }> {
  try {
    const raw = await whoisLookup(domain);
    const { creationDate, expirationDate } = parseWhoisData(raw);
    if (expirationDate) return { regTime: creationDate, expireTime: expirationDate };
  } catch {
    // whois(43端口) 受限，改用 RDAP
  }
  const { creationDate, expirationDate } = await rdapLookup(domain);
  if (!expirationDate) throw new Error('域名到期时间未知');
  return { regTime: creationDate, expireTime: expirationDate };
}

export async function updateDomainDate(id: number, domain: string) {
  try {
    const { regTime, expireTime } = await getDomainDate(domain);
    await query(
      `UPDATE ${table('domain')} SET regtime = ?, expiretime = ?, checktime = ?, checkstatus = 1 WHERE id = ?`,
      [regTime, expireTime, fmtDateTime(), id],
    );
    return { code: 0, regTime, expireTime, msg: 'Success' };
  } catch (e: any) {
    await query(`UPDATE ${table('domain')} SET checktime = ?, checkstatus = 2 WHERE id = ?`, [fmtDateTime(), id]);
    return { code: -1, msg: e?.message || '查询失败' };
  }
}

export async function refreshDomainList(): Promise<number> {
  const rows: any[] = await query(`SELECT id, name FROM ${table('domain')} WHERE checkstatus = 0`);
  let count = 0;
  for (const row of rows) {
    const res = await updateDomainDate(row.id, row.name);
    if (res.code === 0) console.log(`[expire] 域名: ${row.name} 注册时间: ${res.regTime ?? '-'} 到期时间: ${res.expireTime}`);
    else console.log(`[expire] 域名: ${row.name} 更新失败，${res.msg}`);
    count++;
    if (count >= 5) break;
    await sleep(1000);
  }
  return count;
}

export async function refreshExpiringDomainList(maxDay: number): Promise<number> {
  const rows: any[] = await query(
    `SELECT id, name FROM ${table('domain')} WHERE expiretime >= (NOW() - INTERVAL 5 DAY) AND expiretime <= (NOW() + INTERVAL ${maxDay} DAY) AND checktime <= (NOW() - INTERVAL 1 DAY)`,
  );
  let count = 0;
  for (const row of rows) {
    const res = await updateDomainDate(row.id, row.name);
    if (res.code === 0) console.log(`[expire] 域名: ${row.name} 注册时间: ${res.regTime ?? '-'} 到期时间: ${res.expireTime}`);
    else console.log(`[expire] 域名: ${row.name} 更新失败，${res.msg}`);
    count++;
    if (count >= 5) break;
    await sleep(1000);
  }
  return count;
}

async function noticeExpiringDomainList(maxDay: number, days: number[]): Promise<void> {
  const rows: any[] = await query(
    `SELECT id, name, expiretime FROM ${table('domain')} WHERE expiretime >= NOW() AND expiretime <= (NOW() + INTERVAL ${maxDay} DAY) AND is_notice = 1 AND (noticetime IS NULL OR noticetime <= (NOW() - INTERVAL 20 HOUR)) ORDER BY expiretime ASC`,
  );
  const noticeMap: Record<number, { id: number; name: string; expiretime: string }[]> = {};
  for (const row of rows) {
    const expireDay = Math.floor((new Date(row.expiretime).getTime() - Date.now()) / 86400000);
    if (days.includes(expireDay)) {
      (noticeMap[expireDay] ||= []).push({ id: row.id, name: row.name, expiretime: fmtDateTime(new Date(row.expiretime)) });
    }
  }
  for (const [day, list] of Object.entries(noticeMap)) {
    const ids = list.map((x) => x.id);
    await query(`UPDATE ${table('domain')} SET noticetime = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [fmtDateTime(), ...ids]);
    await sendExpireNotice(Number(day), list);
    console.log(`[expire] 域名到期提醒: ${day}天内到期的${ids.length}个域名已发送`);
  }
}

export async function expireNoticeTask(): Promise<void> {
  console.log('[expire] 开始执行域名到期提醒任务...');
  await configSet('domain_expire_time', fmtDateTime());

  let count = await refreshDomainList();
  if (count > 0) return;

  let daysStr = (await configGet('expire_noticedays', '')) || '';
  let maxDay = 30;
  let days: number[] = [];
  if (daysStr) {
    days = daysStr.split(',').map((s) => parseInt(s)).filter((n) => !isNaN(n));
    maxDay = (days.length ? Math.max(...days) : 30) + 1;
  }
  count = await refreshExpiringDomainList(maxDay);
  if (count > 0) return;

  const nowHour = new Date().getHours();
  const anyOn = ['expire_notice_mail', 'expire_notice_wxtpl', 'expire_notice_tgbot', 'expire_notice_webhook', 'expire_notice_custom_webhook'];
  let enabled = false;
  for (const k of anyOn) {
    if ((await configGet(k)) === '1') { enabled = true; break; }
  }
  if (daysStr && enabled && nowHour >= 9) {
    await noticeExpiringDomainList(maxDay, days);
  }
}