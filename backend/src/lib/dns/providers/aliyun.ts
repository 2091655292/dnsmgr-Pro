import { Aliyun } from '../../clients/Aliyun.js';
import type { DnsProvider, DomainListResult, RecordListResult, RecordInfo } from '../types.js';

export class AliyunDns implements DnsProvider {
  private client: Aliyun;
  private error = '';
  private domain: string;

  constructor(private config: Record<string, any>) {
    this.client = new Aliyun(config.AccessKeyId, config.AccessKeySecret, 'alidns.aliyuncs.com', '2015-01-09');
    this.domain = config.domain || '';
  }

  getError() {
    return this.error;
  }

  private async request(param: Record<string, any>, throwOnError = false): Promise<any> {
    try {
      const data = await this.client.request({ Action: param.Action, ...param });
      return data;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.getDomainList(null, 1, 20)) !== false;
  }

  async getDomainList(KeyWord: string | null = null, PageNumber = 1, PageSize = 20): Promise<DomainListResult | false> {
    const data = await this.request({ Action: 'DescribeDomains', KeyWord, PageNumber, PageSize });
    if (!data) return false;
    const list = (data.Domains?.Domain || []).map((row: any) => ({
      DomainId: row.DomainId,
      Domain: row.DomainName,
      RecordCount: row.RecordCount,
    }));
    return { total: data.TotalCount || 0, list };
  }

  async getDomainRecords(
    PageNumber = 1,
    PageSize = 20,
    KeyWord: string | null = null,
    SubDomain: string | null = null,
    Value: string | null = null,
    Type: string | null = null,
    Line: string | null = null,
    Status: string | null = null,
  ): Promise<RecordListResult | false> {
    const param: Record<string, any> = { Action: 'DescribeDomainRecords', DomainName: this.domain, PageNumber, PageSize };
    if (SubDomain || Type || Line || Value) {
      param.SearchMode = 'ADVANCED';
      param.RRKeyWord = SubDomain ?? undefined;
      param.ValueKeyWord = Value ?? undefined;
      param.Type = Type ?? undefined;
      param.Line = Line ?? undefined;
    } else if (KeyWord) {
      param.KeyWord = KeyWord;
    }
    if (Status) param.Status = Status === '1' ? 'Enable' : 'Disable';
    const data = await this.request(param);
    if (!data) return false;
    const list = (data.DomainRecords?.Record || []).map((row: any) => ({
      RecordId: row.RecordId,
      Domain: row.DomainName,
      Name: row.RR,
      Type: row.Type,
      Value: row.Value,
      Line: row.Line,
      TTL: row.TTL,
      MX: row.Priority ?? null,
      Status: row.Status === 'ENABLE' ? '1' : '0',
      Weight: row.Weight ?? null,
      Remark: row.Remark ?? null,
      UpdateTime: row.UpdateTimestamp ? new Date(Number(row.UpdateTimestamp)).toISOString().slice(0, 19).replace('T', ' ') : null,
    }));
    return { total: data.TotalCount || 0, list };
  }

  async getDomainRecordInfo(RecordId: string): Promise<RecordInfo | false> {
    const data = await this.request({ Action: 'DescribeDomainRecordInfo', RecordId });
    if (!data) return false;
    return {
      RecordId: data.RecordId,
      Domain: data.DomainName,
      Name: data.RR,
      Type: data.Type,
      Value: data.Value,
      Line: data.Line,
      TTL: data.TTL,
      MX: data.Priority ?? null,
      Status: data.Status === 'ENABLE' ? '1' : '0',
      Weight: data.Weight ?? null,
      Remark: data.Remark ?? null,
      UpdateTime: data.UpdateTimestamp ? new Date(Number(data.UpdateTimestamp)).toISOString().slice(0, 19).replace('T', ' ') : null,
    };
  }

  async addDomainRecord(Name: string, Type: string, Value: string, Line = 'default', TTL = 600, MX: number | null = null, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = { Action: 'AddDomainRecord', DomainName: this.domain, RR: Name, Type, Value, Line, TTL: Number(TTL) };
    if (Type === 'MX') param.Priority = Number(MX ?? 1);
    if (Weight !== null && Weight !== undefined) param.Weight = Number(Weight);
    const data = await this.request(param);
    return data && data.RecordId ? String(data.RecordId) : false;
  }

  async updateDomainRecord(RecordId: string, Name: string, Type: string, Value: string, Line = 'default', TTL = 600, MX: number | null = null, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = { Action: 'UpdateDomainRecord', RecordId, RR: Name, Type, Value, Line, TTL: Number(TTL) };
    if (Type === 'MX') param.Priority = Number(MX ?? 1);
    if (Weight !== null && Weight !== undefined) param.Weight = Number(Weight);
    return (await this.request(param)) !== false;
  }

  async deleteDomainRecord(RecordId: string) {
    return (await this.request({ Action: 'DeleteDomainRecord', RecordId })) !== false;
  }

  async updateDomainRecordRemark(RecordId: string, Remark: string | null): Promise<boolean> {
    return (await this.request({ Action: 'UpdateDomainRecordRemark', RecordId, Remark: Remark ?? '' })) !== false;
  }

  async setDomainRecordStatus(RecordId: string, Status: string) {
    const s = Status === '1' ? 'Enable' : 'Disable';
    return (await this.request({ Action: 'SetDomainRecordStatus', RecordId, Status: s })) !== false;
  }

  async getRecordLine() {
    const data = await this.request({ Action: 'DescribeSupportLines', DomainName: this.domain });
    if (!data) return false;
    const lines: Record<string, string> = {};
    for (const r of data.RecordLines?.RecordLine || []) lines[r.LineName] = r.LineCode;
    return lines;
  }

  async addDomain(Domain: string) {
    return (await this.request({ Action: 'AddDomain', DomainName: Domain })) !== false;
  }
}