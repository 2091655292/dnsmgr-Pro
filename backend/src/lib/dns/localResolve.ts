import dns from 'node:dns';
import { promisify } from 'node:util';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const resolveCname = promisify(dns.resolveCname);
const resolveMx = promisify(dns.resolveMx);
const resolveTxt = promisify(dns.resolveTxt);
const resolveNs = promisify(dns.resolveNs);
const resolveSrv = promisify(dns.resolveSrv);

const DOH_SERVERS = ['https://dns.alidns.com/resolve', 'https://doh.pub/resolve'];
const TYPE_ID: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2, SOA: 6, PTR: 12, SRV: 33, CAA: 257 };

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

/** 归一化解析值：小写、去尾部点 */
function norm(v: string): string {
  return String(v).trim().toLowerCase().replace(/\.+$/, '');
}

/** 通过 DoH 查询解析记录 */
async function resolveDoh(domain: string, type: string): Promise<string[]> {
  const tid = TYPE_ID[type];
  if (!tid) return [];
  for (const base of DOH_SERVERS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${base}?name=${encodeURIComponent(domain)}&type=${tid}`, {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data: any = await res.json();
      const out: string[] = [];
      for (const row of data.Answer || []) {
        let value: string = String(row.data ?? '');
        if (row.type === 5 || row.type === 2 || row.type === 12) value = norm(value);
        else if (row.type === 16) value = value.replace(/^"|"$/g, '');
        if (value) out.push(value);
      }
      if (out.length) return dedupe(out);
    } catch {
      continue;
    }
  }
  return [];
}

/** 本地解析某域名某类型，返回解析值列表；失败返回空数组 */
export async function localResolve(domain: string, type: string): Promise<string[]> {
  try {
    if (type === 'A') return dedupe(await resolve4(domain));
    if (type === 'AAAA') return dedupe(await resolve6(domain));
    if (type === 'CNAME') return dedupe((await resolveCname(domain)).map(norm));
    if (type === 'MX') return dedupe((await resolveMx(domain)).map((r: any) => norm(r.exchange)));
    if (type === 'TXT') return dedupe((await resolveTxt(domain)).flat().map((s: string) => s));
    if (type === 'NS') return dedupe((await resolveNs(domain)).map(norm));
    if (type === 'SRV') return dedupe((await resolveSrv(domain)).map((r: any) => norm(r.name)));
  } catch {
    // 本地解析失败或返回空，回退 DoH
  }
  return resolveDoh(domain, type);
}

/** 对比期望值与实际解析值，返回是否匹配（含 IP 归一） */
export function recordValueMatches(expected: string, actual: string[]): boolean {
  const e = norm(expected);
  if (!e) return false;
  const list = actual.map(norm);
  if (list.includes(e)) return true;
  // IP 二进制归一比较（IPv4 前导零 / IPv6 压缩格式差异）
  const eIp = toIpBytes(e);
  if (eIp) {
    for (const v of list) {
      const vIp = toIpBytes(v);
      if (vIp && eIp === vIp) return true;
    }
  }
  return false;
}

function toIpBytes(ip: string): string | null {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return v4.slice(1).map((o) => parseInt(o, 10)).join('.');
  }
  // IPv6 简单归一：展开压缩段
  if (ip.includes(':')) {
    const dbl = ip.includes('::') ? ip.split('::') : null;
    if (!dbl) return ip;
    const left = dbl[0] ? dbl[0].split(':') : [];
    const right = dbl[1] ? dbl[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const parts = [...left, ...Array(missing).fill('0'), ...right];
    return parts.map((p) => p.padStart(4, '0')).join(':');
  }
  return null;
}