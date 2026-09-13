import { TencentCloud } from '../../clients/TencentCloud.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule, splitRuleValues, wildcardToRegex } from '../pathRule.js';
import type { PathRuleType } from '../pathRule.js';

export class TencentEdgeOne implements CdnProvider {
  private client: TencentCloud;
  private error = '';
  private zoneId: string | null = null;
  private zoneErrors: string[] = [];

  constructor(config: Record<string, any>) {
    this.client = new TencentCloud(config.SecretId, config.SecretKey, 'teo.tencentcloudapi.com', 'teo', '2022-09-01');
  }

  getError() {
    return this.error;
  }

  setZoneId(zoneId: string) {
    this.zoneId = zoneId;
  }

  getZoneErrors() {
    return this.zoneErrors;
  }

  private async send(action: string, param: Record<string, any>): Promise<any> {
    try {
      return await this.client.request(action, param);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async getZones() {
    const data = await this.send('DescribeZones', { Limit: 100 });
    if (!data) return [];
    return (data.Zones || []).map((z: any) => ({
      zoneId: z.ZoneId,
      zoneName: z.ZoneName,
      status: z.Status,
      area: z.Area,
    }));
  }

  async check() {
    return (await this.send('DescribeZones', { Limit: 1 })) !== false;
  }

  private getRootDomain(domain: string): string {
    const parts = domain.split('.');
    return parts.length <= 2 ? domain : parts.slice(-2).join('.');
  }

  private async findZone(domain: string): Promise<string | false> {
    if (this.zoneId) return this.zoneId;
    const root = this.getRootDomain(domain);
    const data = await this.send('DescribeZones', { Limit: 100 });
    if (!data) return false;
    for (const zone of data.Zones || []) {
      if (zone.ZoneName === root && zone.ZoneId) return zone.ZoneId;
    }
    return false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string, specifiedZoneId?: string | null): Promise<string | false> {
    if (specifiedZoneId) this.zoneId = specifiedZoneId;
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点（Zone），请先在腾讯云 EdgeOne 控制台创建站点后再接入';
      return false;
    }
    const param = {
      ZoneId: zoneId,
      DomainName: domain,
      OriginInfo: { OriginType: 'IP_DOMAIN', Origin: origin.trim() },
      OriginProtocol: 'FOLLOW',
    };
    if (!(await this.send('CreateAccelerationDomain', param))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const zoneId = await this.findZone(domain);
    if (!zoneId) return false;
    const data = await this.send('DescribeAccelerationDomains', { ZoneId: zoneId, Limit: 100 });
    if (!data) return false;
    for (const d of data.AccelerationDomains || []) {
      if (d.DomainName === domain && d.Cname) return d.Cname;
    }
    return false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    this.zoneErrors = [];
    const zonesData = await this.send('DescribeZones', { Limit: 100, Offset: 0 });
    if (!zonesData) return false;
    for (const z of zonesData.Zones || []) {
      const zoneId = z.ZoneId || '';
      if (!zoneId) continue;
      let zoneForceRedirect = false;
      const zs = await this.send('DescribeL7AccSetting', { ZoneId: zoneId });
      if (zs) zoneForceRedirect = zs.ZoneSetting?.ZoneConfig?.ForceRedirectHTTPS?.Switch === 'on';
      const dr = await this.send('DescribeAccelerationDomains', { ZoneId: zoneId, Offset: 0, Limit: 100 });
      if (!dr) {
        this.zoneErrors.push(z.ZoneName + ': ' + this.error);
        continue;
      }
      for (const d of dr.AccelerationDomains || []) {
        const originDetail = d.OriginDetail || {};
        const originVal = originDetail.Origin || '';
        const originType = originVal && /^\d+\.\d+\.\d+\.\d+/.test(originVal) ? 'ipaddr' : 'domain';
        const protoMap: Record<string, string> = { HTTP: 'http', HTTPS: 'https', FOLLOW: 'follow' };
        const cert = d.Certificate || {};
        const mode = cert.Mode || '';
        const httpsEnabled = (mode && mode !== 'disable') || cert.ClientCertInfo?.Switch === 'on';
        list.push({
          domain: d.DomainName,
          cname: d.Cname || '',
          status: d.DomainStatus === 'offline' ? 'offline' : 'online',
          zoneId,
          origin: originVal,
          origin_type: originType,
          origin_host: originDetail.HostHeader || '',
          origin_protocol: protoMap[d.OriginProtocol] ?? 'follow',
          http_port: d.HttpOriginPort || 80,
          https_port: d.HttpsOriginPort || 443,
          https_enabled: httpsEnabled,
          force_redirect: zoneForceRedirect,
        });
      }
    }
    return list;
  }

  async deleteDomain(domain: string) {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    return (await this.send('DeleteAccelerationDomain', { ZoneId: zoneId, DomainNames: [domain] })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    return (
      (await this.send('ModifyAccelerationDomainStatus', {
        ZoneId: zoneId,
        DomainName: domain,
        Status: status === 'offline' ? 'offline' : 'online',
      })) !== false
    );
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    const protoMap: Record<string, string> = { http: 'HTTP', https: 'HTTPS', follow: 'FOLLOW' };
    const OriginInfo: Record<string, any> = { OriginType: 'IP_DOMAIN', Origin: origin.trim() };
    if (originHost) OriginInfo.HostHeader = originHost;
    return (
      (await this.send('ModifyAccelerationDomain', {
        ZoneId: zoneId,
        DomainName: domain,
        OriginInfo,
        OriginProtocol: protoMap[originProtocol] ?? 'FOLLOW',
      })) !== false
    );
  }

  async setCacheRules(domain: string, rules: any[]) {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    try {
      const list = Array.isArray(rules) ? rules : [];
      // 全局规则（path 为 * 或空）：站点级全局缓存配置（移植自 saveCacheRules 的 globalRule 分支）
      const globalRule = list.find((r) => parsePathRule(r?.path).type === 'global');
      if (globalRule) {
        const ttl = Math.max(0, Number(globalRule.ttl) || 0);
        const followOrigin = { Switch: 'off', DefaultCache: 'off', DefaultCacheStrategy: 'off', DefaultCacheTime: 0 };
        const cache =
          ttl > 0
            ? { FollowOrigin: followOrigin, CustomTime: { Switch: 'on', IgnoreCacheControl: 'on', CacheTime: ttl }, NoCache: { Switch: 'off' } }
            : { FollowOrigin: followOrigin, CustomTime: { Switch: 'off' }, NoCache: { Switch: 'on' } };
        await this.client.request('ModifyL7AccSetting', { ZoneId: zoneId, ZoneConfig: { Cache: cache } });
      }
      // 非全局规则：通过 L7 加速规则（规则引擎）下发（移植自 saveEdgeOneCacheRule）
      const specific = list
        .map((r) => ({ path: normalizeValue(r?.path), ttl: Math.max(0, Number(r?.ttl) || 0) }))
        .filter((r) => r.path !== '' && r.path !== '*');
      const ruleName = this.edgeOneCacheRuleName(domain);
      const existing = await this.findEdgeOneL7Rule(zoneId, ruleName);
      if (!specific.length) {
        if (existing?.RuleId) {
          await this.client.request('DeleteL7AccRules', { ZoneId: zoneId, RuleIds: [existing.RuleId] });
        }
        return true;
      }
      const item = this.buildCacheRuleEngineItem(domain, specific);
      if (existing?.RuleId) {
        // RulePriority 由 DescribeL7AccRules 返回但对 ModifyL7AccRule 只读
        await this.client.request('ModifyL7AccRule', { ZoneId: zoneId, Rule: { ...item, RuleId: existing.RuleId } });
      } else {
        await this.client.request('CreateL7AccRules', { ZoneId: zoneId, Rules: [item] });
      }
      return true;
    } catch (e: any) {
      this.error = '修改腾讯云 EdgeOne 缓存规则失败：' + (e.message || String(e));
      return false;
    }
  }

  // ===== EdgeOne 规则引擎（移植自 multi-cloud-cdn TencentEdgeOneDomainServiceImpl）=====

  private normalize(value: any): string {
    return normalizeValue(value);
  }

  private edgeOneCacheRuleName(domain: string): string {
    return 'dnsmgr_cache_' + this.normalize(domain).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  private async findEdgeOneL7Rule(zoneId: string, ruleName: string): Promise<any | null> {
    let offset = 0;
    const limit = 200;
    for (;;) {
      const resp = await this.client.request('DescribeL7AccRules', { ZoneId: zoneId, Offset: offset, Limit: limit });
      const rules = resp.Rules || [];
      if (!rules.length) return null;
      for (const rule of rules) {
        if (rule?.RuleName === ruleName) return rule;
      }
      if (rules.length < limit || (resp.TotalCount != null && offset + rules.length >= resp.TotalCount)) return null;
      offset += rules.length;
    }
  }

  private escapeConditionValue(value: string): string {
    return this.normalize(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private toConditionList(values: string[]): string {
    return '[' + values.map((v) => `'${this.escapeConditionValue(v)}'`).join(', ') + ']';
  }

  private regexQuotePath(path: string): string {
    let out = '';
    for (const c of this.normalize(path)) {
      if ('\\.^$|()[]{}+*?'.includes(c)) out += '\\';
      out += c;
    }
    return out;
  }

  private buildPathMatchesCondition(regex: string): string {
    return "${http.request.uri.path} matches '" + this.escapeConditionValue(regex) + "'";
  }

  private buildCacheRuleCondition(rule: { type: PathRuleType; value: string }): string {
    if (rule.type === 'file_extension') {
      const extensions = fileExtensions(rule.value);
      if (!extensions.length) throw new Error('文件后缀缓存规则内容不能为空');
      return '${http.request.file_extension} in ' + this.toConditionList(extensions);
    }
    if (rule.type === 'catalog') {
      const expressions = splitRuleValues(rule.value).map((value) => {
        const path = catalogPath(value);
        if (path === '/') return this.buildPathMatchesCondition('^/.*$');
        return this.buildPathMatchesCondition('^' + this.regexQuotePath(path) + '(/.*)?$');
      });
      if (!expressions.length) throw new Error('目录路径缓存规则内容不能为空');
      return expressions.length === 1 ? expressions[0] : '(' + expressions.join(' or ') + ')';
    }
    if (rule.type === 'global') {
      return '${http.request.host} in [\'\']';
    }
    const values = splitRuleValues(rule.value);
    if (!values.length) throw new Error('全路径缓存规则内容不能为空');
    const exactValues: string[] = [];
    const wildcardValues: string[] = [];
    for (const value of values) {
      if (value.includes('*') || value.includes('?')) wildcardValues.push(value);
      else exactValues.push(value);
    }
    const expressions: string[] = [];
    if (exactValues.length) expressions.push('${http.request.uri.path} in ' + this.toConditionList(exactValues));
    for (const w of wildcardValues) expressions.push(this.buildPathMatchesCondition(wildcardToRegex(w)));
    return expressions.length === 1 ? expressions[0] : '(' + expressions.join(' or ') + ')';
  }

  private buildRuleCacheParameters(ttl: number): Record<string, any> {
    if (ttl > 0) {
      return { CustomTime: { Switch: 'on', IgnoreCacheControl: 'on', CacheTime: ttl } };
    }
    return { NoCache: { Switch: 'on' } };
  }

  private buildCacheRuleEngineItem(domain: string, rules: { path: string; ttl: number }[]): Record<string, any> {
    const subRules = rules.map((r) => ({
      Branches: [
        {
          Condition: this.buildCacheRuleCondition(parsePathRule(r.path)),
          Actions: [{ Name: 'Cache', CacheParameters: this.buildRuleCacheParameters(r.ttl) }],
        },
      ],
      Description: [JSON.stringify({ path: normalizeValue(r.path), ttl: r.ttl })],
    }));
    return {
      Status: 'enable',
      RuleName: this.edgeOneCacheRuleName(domain),
      Description: ['dnsmgr cache rules for ' + domain],
      Branches: [
        {
          Condition: "${http.request.host} in ['" + this.escapeConditionValue(domain) + "']",
          SubRules: subRules,
        },
      ],
    };
  }

  // 移植自 multi-cloud-cdn TencentEdgeOneDomainServiceImpl.httpsConfiguration / forcedToJump：
  // 关闭 HTTPS 时禁用域名证书（ModifyHostsCertificate Mode=disable，开启需要证书内容，请在控制台配置）；
  // 强制跳转为站点级 ZoneConfig.ForceRedirectHTTPS
  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    try {
      if (!enabled) {
        await this.client.request('ModifyHostsCertificate', { ZoneId: zoneId, Hosts: [domain], Mode: 'disable' });
      }
      await this.client.request('ModifyL7AccSetting', {
        ZoneId: zoneId,
        ZoneConfig: { ForceRedirectHTTPS: { Switch: forceRedirect ? 'on' : 'off', RedirectStatusCode: 302 } },
      });
      return true;
    } catch (e: any) {
      this.error = '修改腾讯云 EdgeOne HTTPS 配置失败：' + (e.message || String(e));
      return false;
    }
  }

  async getZoneSetting(zoneId: string) {
    const data = await this.send('DescribeL7AccSetting', { ZoneId: zoneId });
    if (!data) return false;
    return data.ZoneSetting?.ZoneConfig || {};
  }

  async updateZoneSetting(zoneId: string, zoneConfig: Record<string, any>) {
    return (await this.send('ModifyL7AccSetting', { ZoneId: zoneId, ZoneConfig: zoneConfig })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const zoneId = await this.findZone(urls[0] || '');
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    const data = await this.send('CreatePurgeTask', {
      ZoneId: zoneId,
      Type: type === 'dir' ? 'purge_prefix' : 'purge_url',
      Targets: urls,
      EncodeUrl: false,
    });
    if (!data) return false;
    return data.TaskId || data.JobId || 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const zoneId = await this.findZone(urls[0] || '');
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    const data = await this.send('CreatePrefetchTask', { ZoneId: zoneId, Targets: urls, EncodeUrl: false });
    if (!data) return false;
    return data.TaskId || data.JobId || 'ok';
  }

  private async describeSecurityPolicy(domain: string): Promise<any[] | false> {
    const zoneId = await this.findZone(domain);
    if (!zoneId) return false;
    const data = await this.send('DescribeSecurityPolicy', { ZoneId: zoneId, Entity: 'ZoneDefaultPolicy' });
    if (!data) return false;
    return data.SecurityPolicy?.CustomRules?.Rules || [];
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const rules = await this.describeSecurityPolicy(domain);
    if (rules === false) return false;
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    for (const r of rules) {
      const name = r?.Name;
      const condition = String(r?.Condition || '');
      if (name === 'dnsmgr_ip_acl') {
        out.ip_mode = condition.includes('not') ? 'whitelist' : 'blacklist';
        out.ip_list = this.parseConditionList(condition);
      } else if (name === 'dnsmgr_referer') {
        out.referer_mode = condition.includes('not') ? 'whitelist' : 'blacklist';
        out.referer_list = this.parseConditionList(condition);
      } else if (name === 'dnsmgr_user_agent') {
        out.ua_list = this.parseConditionList(condition);
      }
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const zoneId = await this.findZone(domain);
    if (!zoneId) {
      this.error = '未找到该域名的 EdgeOne 站点';
      return false;
    }
    const data = await this.send('DescribeSecurityPolicy', { ZoneId: zoneId, Entity: 'ZoneDefaultPolicy' });
    if (data === false) return false;
    const existing = data?.SecurityPolicy?.CustomRules?.Rules || [];
    const keep = existing
      .filter((r: any) => !String(r?.Name || '').startsWith('dnsmgr_'))
      .map((r: any) => this.copyCustomRule(r));
    const additions = this.buildAccessRules(config);
    const ok = await this.send('ModifySecurityPolicy', {
      ZoneId: zoneId,
      Entity: 'ZoneDefaultPolicy',
      SecurityPolicy: { CustomRules: { Rules: [...keep, ...additions] } },
    });
    return ok !== false;
  }

  private copyCustomRule(r: any): any {
    return {
      Id: r?.Id,
      Name: r?.Name,
      Condition: r?.Condition,
      Enabled: r?.Enabled ?? 'on',
      RuleType: r?.RuleType,
      Priority: r?.Priority,
      Action: r?.Action ? { Name: r.Action.Name } : undefined,
    };
  }

  private buildAccessRules(config: Record<string, any>): any[] {
    const rules: any[] = [];
    const refererMode = config.referer_mode || 'off';
    if (refererMode === 'whitelist' || refererMode === 'blacklist') {
      const cond = `\${http.request.headers['referer']} like ${this.conditionList(config.referer_list || [])}`;
      rules.push({
        Name: 'dnsmgr_referer',
        Condition: refererMode === 'whitelist' ? `not (${cond})` : cond,
        Enabled: 'on',
        RuleType: 'PreciseMatchRule',
        Priority: 10,
        Action: { Name: 'Deny' },
      });
    }
    const ipMode = config.ip_mode || 'off';
    if (ipMode === 'whitelist' || ipMode === 'blacklist') {
      const cond = `\${http.request.ip} in ${this.conditionList(config.ip_list || [])}`;
      rules.push({
        Name: 'dnsmgr_ip_acl',
        Condition: ipMode === 'whitelist' ? `not (${cond})` : cond,
        Enabled: 'on',
        RuleType: 'BasicAccessRule',
        Action: { Name: 'Deny' },
      });
    }
    if ((config.ua_list || []).length) {
      rules.push({
        Name: 'dnsmgr_user_agent',
        Condition: `\${http.request.headers['user-agent']} like ${this.conditionList(config.ua_list || [])}`,
        Enabled: 'on',
        RuleType: 'PreciseMatchRule',
        Priority: 12,
        Action: { Name: 'Deny' },
      });
    }
    return rules;
  }

  private conditionList(values: string[]): string {
    const escaped = values.map((v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    return `[${escaped.join(', ')}]`;
  }

  private parseConditionList(condition: string): string[] {
    const m = condition.match(/\[([^\]]*)\]/);
    if (!m) return [];
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, '').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
      .filter(Boolean);
  }
}