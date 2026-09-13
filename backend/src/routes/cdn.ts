import type { FastifyInstance } from 'fastify';
import { query, queryOne, table } from '../db.js';
import { getCdnProvider, cdnConfig } from '../lib/cdn/factory.js';
import { getDnsProvider } from '../lib/dns/factory.js';
import type { CdnProvider } from '../lib/cdn/types.js';
import { queryByRoute, hasCdnStatistics, type StatisticsDomain } from '../lib/cdn/statistics/index.js';
import { ensureSections, mergeResult } from '../lib/cdn/statistics/util.js';

const authenticate = (app: FastifyInstance) => ({ preHandler: (app as any).authenticate });

function parseStatTime(v: any): Date | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

function calcRecordName(accelDomain: string, dnsDomain: string): string {
  if (accelDomain === dnsDomain) return '@';
  return accelDomain.slice(0, accelDomain.length - dnsDomain.length - 1);
}

function zoneSettingDiff(current: Record<string, any>, target: Record<string, any>): Record<string, any> {
  const diff: Record<string, any> = {};
  for (const key of Object.keys(target)) {
    const value = target[key];
    const cur = current[key];
    if (Array.isArray(value) && Array.isArray(cur)) {
      const a: any = value;
      const b: any = cur;
      if (Array.isArray(a) && a.Algorithms) a.Algorithms.sort();
      if (Array.isArray(b) && b.Algorithms) b.Algorithms.sort();
      if (Array.isArray(a) && a.Version) a.Version.sort();
      if (Array.isArray(b) && b.Version) b.Version.sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) diff[key] = value;
    } else if (JSON.stringify(value) !== JSON.stringify(cur)) {
      diff[key] = value;
    }
  }
  return diff;
}

const areaMap: Record<string, string> = { mainland: 'mainland_china', domestic: 'mainland_china', overseas: 'overseas', global: 'global' };

export default async function cdnRoutes(app: FastifyInstance) {
  const auth = authenticate(app);

  async function loadCdnDomain(id: number): Promise<any> {
    const row = await queryOne(`SELECT * FROM ${table('cdn_domain')} WHERE id = ?`, [id]);
    if (!row) return null;
    const acct = await queryOne(`SELECT * FROM ${table('cdn_account')} WHERE id = ?`, [row.aid]);
    if (!acct) return null;
    row._config = acct.config;
    return row;
  }

  async function cdnForRow(row: any): Promise<CdnProvider | false> {
    return cdnForZone(row.aid, row.zone_id);
  }

  async function cdnForZone(aid: number, zoneId: string | null): Promise<CdnProvider | false> {
    const acct = await queryOne(`SELECT * FROM ${table('cdn_account')} WHERE id = ?`, [aid]);
    if (!acct) return false;
    const provider: any = getCdnProvider(acct.type, safeJson(acct.config));
    if (!provider) return false;
    if (zoneId && typeof provider.setZoneId === 'function') provider.setZoneId(zoneId);
    if (zoneId && typeof provider.setSiteId === 'function') provider.setSiteId(zoneId);
    return provider;
  }

  // 列表
  app.get('/api/cdn/domains', auth, async (req: any) => {
    const q = req.query || {};
    const rows = await query(`SELECT * FROM ${table('cdn_domain')} ORDER BY id DESC`);
    const typeNames = Object.fromEntries(Object.entries(cdnConfig).map(([k, v]) => [k, v.name]));
    const data = rows.map((r: any) => ({ ...r, routename: typeNames[r.route] || r.route }));
    return { code: 0, data };
  });

  // 站点列表（按账户 + 站点聚合）
  app.get('/api/cdn/zones', auth, async () => {
    const rows = await query(
      `SELECT aid, zone_id, route,
              MIN(name) AS primary_name,
              COUNT(*) AS domain_count,
              GROUP_CONCAT(name ORDER BY id ASC SEPARATOR ',') AS domains
       FROM ${table('cdn_domain')}
       WHERE zone_id IS NOT NULL AND zone_id != ''
       GROUP BY aid, zone_id
       ORDER BY aid ASC, zone_id ASC`,
    );
    const typeNames = Object.fromEntries(Object.entries(cdnConfig).map(([k, v]) => [k, v.name]));
    const data = rows.map((r: any) => ({
      aid: r.aid,
      zone_id: r.zone_id,
      route: r.route,
      routename: typeNames[r.route] || r.route,
      name: r.primary_name,
      domain_count: Number(r.domain_count),
      domains: String(r.domains || '').split(',').filter(Boolean),
    }));
    return { code: 0, data };
  });

  // 站点配置读取
  app.get('/api/cdn/zones/setting', auth, async (req: any) => {
    const aid = Number(req.query.aid || 0);
    const zoneId = String(req.query.zone_id || '').trim();
    if (!aid || !zoneId) return { code: -1, msg: '参数不完整' };
    const provider: any = await cdnForZone(aid, zoneId);
    if (!provider || typeof provider.getZoneSetting !== 'function') return { code: -1, msg: '该站点不支持站点级配置' };
    const zs = await provider.getZoneSetting(zoneId);
    if (zs === false) return { code: -1, msg: '获取站点配置失败，' + provider.getError() };
    return { code: 0, data: { zoneSetting: zs } };
  });

  // 站点配置保存
  app.post('/api/cdn/zones/setting', auth, async (req: any) => {
    const { aid, zone_id, setting } = req.body || {};
    const zoneId = String(zone_id || '').trim();
    if (!aid || !zoneId) return { code: -1, msg: '参数不完整' };
    const provider: any = await cdnForZone(Number(aid), zoneId);
    if (!provider || typeof provider.getZoneSetting !== 'function' || typeof provider.updateZoneSetting !== 'function') {
      return { code: -1, msg: '该站点不支持站点级配置' };
    }
    if (!setting || typeof setting !== 'object') return { code: -1, msg: '配置数据无效' };
    const current = await provider.getZoneSetting(zoneId);
    if (current === false) return { code: -1, msg: '获取当前站点配置失败，' + provider.getError() };
    const diff = zoneSettingDiff(current, setting);
    if (!Object.keys(diff).length) return { code: 0, msg: '未检测到配置变化' };
    if (!(await provider.updateZoneSetting(zoneId, diff))) return { code: -1, msg: '站点配置更新失败，' + provider.getError() };
    return { code: 0, msg: '站点配置更新成功' };
  });

  // 详情（域名级配置）
  app.get('/api/cdn/domains/:id', auth, async (req: any) => {
    const { id } = req.params as any;
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    const cacheRules = await query(`SELECT * FROM ${table('cdn_cache_rule')} WHERE did = ? ORDER BY id ASC`, [id]);
    return { code: 0, data: { info: row, cacheRules } };
  });

  // 接入域名 + 联动 DNS + 自动同步
  app.post('/api/cdn/domains', auth, async (req: any) => {
    const { aid, did, name, origin, origin_type, service_area, zone_id } = req.body || {};
    if (!aid || !name || !origin) return { code: -1, msg: '必填参数不能为空' };
    const dnsDomain = await queryOne(`SELECT * FROM ${table('domain')} WHERE id = ?`, [did]);
    if (!dnsDomain) return { code: -1, msg: '请选择要联动解析的域名' };
    const suffix = '.' + dnsDomain.name;
    if (name !== dnsDomain.name && !name.endsWith(suffix)) {
      return { code: -1, msg: `加速域名必须属于所选域名 ${dnsDomain.name} 的子域名` };
    }
    if (await queryOne(`SELECT id FROM ${table('cdn_domain')} WHERE name = ?`, [name])) {
      return { code: -1, msg: '该加速域名已接入' };
    }
    const acct = await queryOne(`SELECT * FROM ${table('cdn_account')} WHERE id = ?`, [aid]);
    if (!acct) return { code: -1, msg: 'CDN账户不存在' };
    const provider: any = getCdnProvider(acct.type, safeJson(acct.config));
    if (!provider) return { code: -1, msg: 'CDN模块不存在' };
    const cname = await provider.createDomain(name, origin, origin_type || 'ipaddr', service_area || 'mainland_china', zone_id || null);
    if (!cname) return { code: -1, msg: '接入加速域名失败，' + provider.getError() };

    const recordName = calcRecordName(name, dnsDomain.name);
    let dnsRecord: string | null = null;
    let dnsError = '';
    const dnsAcct = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [dnsDomain.aid]);
    if (dnsAcct) {
      const dns = getDnsProvider(dnsAcct.type, safeJson(dnsAcct.config), dnsDomain.name, dnsDomain.thirdid);
      if (dns) {
        const recordId = await dns.addDomainRecord(recordName, 'CNAME', cname, 'default', 600);
        if (recordId) dnsRecord = String(recordId);
        else dnsError = dns.getError();
      } else dnsError = 'DNS模块不存在';
    } else dnsError = 'DNS账户不存在';

    await query(
      `INSERT INTO ${table('cdn_domain')} (aid, did, name, route, zone_id, origin, origin_type, service_area, cname, dns_record, status, addtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', NOW())`,
      [aid, did, name, acct.type, zone_id || null, origin, origin_type || 'ipaddr', service_area || 'mainland_china', cname, dnsRecord],
    );

    let msg = dnsRecord
      ? `接入成功，已自动添加 CNAME 解析记录 ${recordName} → ${cname}`
      : `接入成功，但自动添加解析失败（${dnsError}），请手动添加 CNAME ${recordName} → ${cname}`;

    const sync = await syncFromCloud(aid, did);
    if (sync.code === 0 && sync.added > 0) msg += `；同时从云端同步了 ${sync.added} 个已有加速域名`;

    return { code: 0, msg };
  });

  // 删除
  app.delete('/api/cdn/domains/:id', auth, async (req: any) => {
    const { id } = req.params as any;
    const row = await queryOne(`SELECT * FROM ${table('cdn_domain')} WHERE id = ?`, [id]);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    const provider = await cdnForRow(row);
    if (provider) await provider.deleteDomain(row.name);
    await query(`DELETE FROM ${table('cdn_domain')} WHERE id = ?`, [id]);
    return { code: 0, msg: '删除成功（若已联动解析，请手动删除对应 CNAME 记录）' };
  });

  // 状态
  app.post('/api/cdn/domains/:id/status', auth, async (req: any) => {
    const { id } = req.params as any;
    const { status } = req.body || {};
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    const provider = await cdnForRow(row);
    if (!provider) return { code: -1, msg: 'CDN账户不存在' };
    const target = status === 'offline' ? 'offline' : 'online';
    if (!(await provider.setDomainStatus(row.name, target))) return { code: -1, msg: '状态更新失败，' + provider.getError() };
    await query(`UPDATE ${table('cdn_domain')} SET status = ? WHERE id = ?`, [target, id]);
    return { code: 0, msg: '状态更新成功' };
  });

  // 回源
  app.post('/api/cdn/domains/:id/origin', auth, async (req: any) => {
    const { id } = req.params as any;
    const { origin, origin_type, origin_host, origin_protocol, http_port, https_port } = req.body || {};
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    if (!origin) return { code: -1, msg: '源站不能为空' };
    const provider = await cdnForRow(row);
    if (!provider) return { code: -1, msg: 'CDN账户不存在' };
    if (!(await provider.updateOrigin(row.name, origin, origin_type || 'ipaddr', origin_host || '', origin_protocol || 'follow', Number(http_port || 80), Number(https_port || 443)))) {
      return { code: -1, msg: '回源配置更新失败，' + provider.getError() };
    }
    await query(
      `UPDATE ${table('cdn_domain')} SET origin = ?, origin_type = ?, origin_host = ?, origin_protocol = ?, http_port = ?, https_port = ? WHERE id = ?`,
      [origin, origin_type || 'ipaddr', origin_host || '', origin_protocol || 'follow', Number(http_port || 80), Number(https_port || 443), id],
    );
    return { code: 0, msg: '回源配置更新成功' };
  });

  // 缓存规则
  app.post('/api/cdn/domains/:id/cache', auth, async (req: any) => {
    const { id } = req.params as any;
    const { rules } = req.body || {};
    const ruleList = Array.isArray(rules) ? rules : [];
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    const provider = await cdnForRow(row);
    if (!provider) return { code: -1, msg: 'CDN账户不存在' };
    if (!(await provider.setCacheRules(row.name, ruleList))) return { code: -1, msg: '缓存规则更新失败，' + provider.getError() };
    await query(`DELETE FROM ${table('cdn_cache_rule')} WHERE did = ?`, [id]);
    for (const r of ruleList) {
      const path = (r.path || '').trim();
      if (!path) continue;
      await query(`INSERT INTO ${table('cdn_cache_rule')} (did, path, ttl, addtime) VALUES (?, ?, ?, NOW())`, [id, path, Number(r.ttl || 0)]);
    }
    return { code: 0, msg: '缓存规则更新成功' };
  });

  // HTTPS
  app.post('/api/cdn/domains/:id/https', auth, async (req: any) => {
    const { id } = req.params as any;
    const { https_enabled, force_redirect } = req.body || {};
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    const provider = await cdnForRow(row);
    if (!provider) return { code: -1, msg: 'CDN账户不存在' };
    if (!(await provider.setHttps(row.name, !!https_enabled, !!force_redirect))) return { code: -1, msg: 'HTTPS 配置更新失败，' + provider.getError() };
    await query(`UPDATE ${table('cdn_domain')} SET https_enabled = ?, force_redirect = ? WHERE id = ?`, [https_enabled ? 1 : 0, force_redirect ? 1 : 0, id]);
    return { code: 0, msg: 'HTTPS 配置更新成功' };
  });

  // 同步云端
  app.post('/api/cdn/sync', auth, async (req: any) => {
    const { aid, did } = req.body || {};
    return syncFromCloud(Number(aid || 0), Number(did || 0));
  });

  // 站点全局配置保存
  app.post('/api/cdn/domains/:id/zone_setting', auth, async (req: any) => {
    const { id } = req.params as any;
    const { setting } = req.body || {};
    const row = await loadCdnDomain(id);
    if (!row) return { code: -1, msg: '加速域名不存在' };
    if (!row.zone_id) return { code: -1, msg: '该加速域名无站点信息' };
    const provider: any = await cdnForRow(row);
    if (!provider || typeof provider.getZoneSetting !== 'function' || typeof provider.updateZoneSetting !== 'function') {
      return { code: -1, msg: '该厂商不支持站点级配置' };
    }
    if (!setting || typeof setting !== 'object') return { code: -1, msg: '配置数据无效' };
    const current = await provider.getZoneSetting(row.zone_id);
    if (current === false) return { code: -1, msg: '获取当前站点配置失败，' + provider.getError() };
    const diff = zoneSettingDiff(current, setting);
    if (!Object.keys(diff).length) return { code: 0, msg: '未检测到配置变化' };
    if (!(await provider.updateZoneSetting(row.zone_id, diff))) return { code: -1, msg: '站点配置更新失败，' + provider.getError() };
    return { code: 0, msg: '站点配置更新成功' };
  });

  // CDN 数据统计（加速流量 / 带宽 / 请求数 / 缓存命中 / 状态码）
  app.get('/api/cdn/statistics', auth, async (req: any) => {
    const q = req.query || {};
    const type = ['Resource', 'Visits', 'HttpCodeStatus', 'All'].includes(String(q.type)) ? String(q.type) : 'All';
    const start = parseStatTime(q.startTime);
    const end = parseStatTime(q.endTime);
    if (!start || !end) return { code: -1, msg: '时间参数无效，格式：2026-01-01 00:00:00' };
    if (end.getTime() <= start.getTime()) return { code: -1, msg: '结束时间需大于开始时间' };

    const domainNames = String(q.domains || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const aid = Number(q.aid || 0);

    const where: string[] = [];
    const params: any[] = [];
    if (domainNames.length) {
      where.push(`name IN (${domainNames.map(() => '?').join(',')})`);
      params.push(...domainNames);
    }
    if (aid) {
      where.push('aid = ?');
      params.push(aid);
    }
    const sql = `SELECT * FROM ${table('cdn_domain')}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    const rows = await query(sql, params);
    if (!rows.length) return { code: 0, data: { labels: [] } };

    const accounts: Record<number, any> = {};
    const groups: Record<string, { route: string; config: Record<string, any>; domains: StatisticsDomain[] }> = {};
    for (const row of rows as any[]) {
      if (!hasCdnStatistics(row.route)) continue;
      if (!accounts[row.aid]) accounts[row.aid] = await queryOne(`SELECT * FROM ${table('cdn_account')} WHERE id = ?`, [row.aid]);
      const acct = accounts[row.aid];
      if (!acct) continue;
      const groupKey = `${row.route}#${row.aid}`;
      if (!groups[groupKey]) groups[groupKey] = { route: row.route, config: safeJson(acct.config), domains: [] };
      groups[groupKey].domains.push({ name: row.name, route: row.route, zoneId: row.zone_id, serviceArea: row.service_area });
    }

    let merged: any = null;
    const errors: string[] = [];
    for (const key of Object.keys(groups)) {
      const group = groups[key];
      try {
        const part = await queryByRoute(group.route, group.config, group.domains, start, end, type);
        if (!part.labels.length) continue;
        merged = merged ? mergeResult(merged, part) : part;
      } catch (e: any) {
        errors.push(`${group.route}: ${e?.message || e}`);
      }
    }
    if (!merged) return { code: 0, data: { labels: [], _errors: errors } };
    ensureSections(merged, type, merged.labels.length);
    if (errors.length) (merged as any)._errors = errors;
    return { code: 0, data: merged };
  });
}

async function syncFromCloud(aid: number, did: number): Promise<any> {
  const account = await queryOne(`SELECT * FROM ${table('cdn_account')} WHERE id = ?`, [aid]);
  if (!account) return { code: -1, msg: 'CDN账户不存在', added: 0, skipped: 0, updated: 0 };
  const provider: any = getCdnProvider(account.type, safeJson(account.config));
  if (!provider) return { code: -1, msg: 'CDN模块不存在', added: 0, skipped: 0, updated: 0 };

  const list = await provider.listDomains();
  if (list === false) return { code: -1, msg: '获取云端加速域名失败，' + provider.getError(), added: 0, skipped: 0, updated: 0 };

  const dnsRows = await query(`SELECT * FROM ${table('domain')}`);
  const dnsMap: Record<string, any> = {};
  for (const d of dnsRows) dnsMap[d.name] = d;

  let filterDnsName: string | null = null;
  for (const d of dnsRows as any[]) if (d.id == did) filterDnsName = d.name;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let dnsOk = 0;
  let dnsFail = 0;

  for (const item of list) {
    const name = (item.domain || '').trim();
    if (!name) continue;
    if (filterDnsName !== null) {
      const suffix = '.' + filterDnsName;
      if (name !== filterDnsName && !name.endsWith(suffix)) continue;
    }
    const exists = await queryOne(`SELECT * FROM ${table('cdn_domain')} WHERE name = ?`, [name]);
    if (exists) {
      const upd: Record<string, any> = {};
      if (!exists.origin && item.origin) {
        upd.origin = item.origin;
        upd.origin_type = item.origin_type || 'ipaddr';
        upd.origin_host = item.origin_host || '';
        upd.origin_protocol = item.origin_protocol || 'follow';
        upd.http_port = Number(item.http_port || 80);
        upd.https_port = Number(item.https_port || 443);
        if (item.cname) upd.cname = item.cname;
      }
      if ('https_enabled' in item) {
        const cloudHttps = !!item.https_enabled;
        const cloudForce = !!item.force_redirect;
        if (cloudHttps !== !!exists.https_enabled || cloudForce !== !!exists.force_redirect) {
          upd.https_enabled = cloudHttps ? 1 : 0;
          upd.force_redirect = cloudForce ? 1 : 0;
        }
      }
      if (Object.keys(upd).length) {
        const fields = Object.keys(upd).map((k) => `${k} = ?`).join(', ');
        await query(`UPDATE ${table('cdn_domain')} SET ${fields} WHERE id = ?`, [...Object.values(upd), exists.id]);
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    let belongDomain: any = null;
    let recordName = '@';
    for (const dnsName of Object.keys(dnsMap)) {
      const d = dnsMap[dnsName];
      if (name === dnsName) {
        belongDomain = d;
        break;
      }
      const suffix = '.' + dnsName;
      if (name.endsWith(suffix)) {
        belongDomain = d;
        recordName = name.slice(0, name.length - suffix.length);
        break;
      }
    }

    const cname = item.cname || '';
    let dnsRecord: string | null = null;
    if (belongDomain && cname) {
      const dnsAcct = await queryOne(`SELECT * FROM ${table('account')} WHERE id = ?`, [belongDomain.aid]);
      if (dnsAcct) {
        const dns = getDnsProvider(dnsAcct.type, safeJson(dnsAcct.config), belongDomain.name, belongDomain.thirdid);
        if (dns) {
          const recordId = await dns.addDomainRecord(recordName, 'CNAME', cname, 'default', 600);
          if (recordId) {
            dnsRecord = String(recordId);
            dnsOk++;
          } else dnsFail++;
        } else dnsFail++;
      } else dnsFail++;
    }

    await query(
      `INSERT INTO ${table('cdn_domain')} (aid, did, name, route, zone_id, origin, origin_type, origin_host, origin_protocol, http_port, https_port, service_area, cname, dns_record, status, https_enabled, force_redirect, addtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        aid,
        belongDomain ? belongDomain.id : 0,
        name,
        account.type,
        item.zoneId || null,
        item.origin || '',
        item.origin_type || 'ipaddr',
        item.origin_host || '',
        item.origin_protocol || 'follow',
        Number(item.http_port || 80),
        Number(item.https_port || 443),
        areaMap[item.area || ''] || 'mainland_china',
        cname || null,
        dnsRecord,
        item.status === 'offline' ? 'offline' : 'online',
        item.https_enabled ? 1 : 0,
        item.force_redirect ? 1 : 0,
      ],
    );
    added++;
  }

  let msg = `同步完成：新增 ${added} 个，已存在 ${skipped} 个`;
  if (updated > 0) msg += `，补全云端配置 ${updated} 个`;
  if (added > 0 && (dnsOk > 0 || dnsFail > 0)) {
    msg += `；自动添加 CNAME 解析成功 ${dnsOk} 个`;
    if (dnsFail > 0) msg += `，失败 ${dnsFail} 个，请手动添加解析`;
  }
  return { code: 0, msg, added, skipped, updated, dnsOk, dnsFail };
}