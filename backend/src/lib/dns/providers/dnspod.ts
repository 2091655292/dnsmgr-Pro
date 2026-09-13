import { TencentCloud } from '../../clients/TencentCloud.js';
import type { DnsProvider, DomainListResult, RecordListResult, RecordInfo } from '../types.js';

const lineCode: Record<string, string> = {
  default: '0',
  unicom: '10=1',
  telecom: '10=0',
  mobile: '10=3',
  edu: '10=2',
  oversea: '3=0',
  btvn: '10=22',
  search: '80=0',
  internal: '7=0',
};

export class Dnspod implements DnsProvider {
  private client: TencentCloud;
  private error = '';
  private domain: string;

  constructor(private config: Record<string, any>) {
    this.client = new TencentCloud(
      config.SecretId,
      config.SecretKey,
      'dnspod.tencentcloudapi.com',
      'dnspod',
      '2021-03-23',
    );
    this.domain = config.domain || '';
  }

  getError() {
    return this.error;
  }

  private async send(action: string, param: Record<string, any>): Promise<any> {
    try {
      return await this.client.request(action, param);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.getDomainList(null, 1, 20)) !== false;
  }

  async getDomainList(KeyWord: string | null = null, PageNumber = 1, PageSize = 20): Promise<DomainListResult | false> {
    const offset = (PageNumber - 1) * PageSize;
    const data = await this.send('DescribeDomainList', { Offset: offset, Limit: PageSize, Keyword: KeyWord ?? undefined });
    if (!data) return false;
    const list = (data.DomainList || []).map((row: any) => ({
      DomainId: row.DomainId,
      Domain: row.Name,
      RecordCount: row.RecordCount,
    }));
    return { total: data.DomainCountInfo?.DomainTotal || 0, list };
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
    const offset = (PageNumber - 1) * PageSize;
    const param: Record<string, any> = {
      Domain: this.domain,
      Offset: offset,
      Limit: PageSize,
      Keyword: KeyWord ?? undefined,
      Subdomain: SubDomain ?? undefined,
      RecordType: Type ? this.convertType(Type) : undefined,
      RecordLineId: Line ?? undefined,
    };
    const data = await this.send('DescribeRecordList', param);
    if (!data) {
      if (this.error === '记录列表为空。' || this.error === 'No records on the list.') return { total: 0, list: [] };
      return false;
    }
    const list = (data.RecordList || []).map((row: any) => ({
      RecordId: String(row.RecordId),
      Domain: this.domain,
      Name: row.Name,
      Type: this.convertTypeId(row.Type),
      Value: row.Value,
      Line: row.LineId,
      TTL: row.TTL,
      MX: row.MX ?? null,
      Status: row.Status === 'ENABLE' ? '1' : '0',
      Weight: row.Weight ?? null,
      Remark: row.Remark ?? null,
      UpdateTime: row.UpdatedOn ?? null,
    }));
    return { total: data.RecordCountInfo?.TotalCount || 0, list };
  }

  async getDomainRecordInfo(RecordId: string): Promise<RecordInfo | false> {
    const data = await this.send('DescribeRecord', { Domain: this.domain, RecordId: Number(RecordId) });
    if (!data) return false;
    const r = data.RecordInfo || {};
    return {
      RecordId: String(r.Id),
      Domain: this.domain,
      Name: r.SubDomain,
      Type: this.convertTypeId(r.RecordType),
      Value: r.Value,
      Line: r.RecordLineId,
      TTL: r.TTL,
      MX: r.MX ?? null,
      Status: r.Enabled == 1 ? '1' : '0',
      Weight: r.Weight ?? null,
      Remark: r.Remark ?? null,
      UpdateTime: r.UpdatedOn ?? null,
    };
  }

  async addDomainRecord(Name: string, Type: string, Value: string, Line = '0', TTL = 600, MX = 1, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = {
      Domain: this.domain,
      SubDomain: Name,
      RecordType: this.convertType(Type),
      Value,
      RecordLine: Line,
      RecordLineId: lineCode[Line] ?? Line,
      TTL: Number(TTL),
      Weight: Weight ?? undefined,
    };
    if (Type === 'MX') param.MX = Number(MX);
    if (Remark != null) param.Remark = Remark;
    const data = await this.send('CreateRecord', param);
    return data && data.RecordId ? String(data.RecordId) : false;
  }

  async updateDomainRecord(RecordId: string, Name: string, Type: string, Value: string, Line = '0', TTL = 600, MX = 1, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = {
      Domain: this.domain,
      RecordId: Number(RecordId),
      SubDomain: Name,
      RecordType: this.convertType(Type),
      Value,
      RecordLine: Line,
      RecordLineId: lineCode[Line] ?? Line,
      TTL: Number(TTL),
      Weight: Weight ?? undefined,
    };
    if (Type === 'MX') param.MX = Number(MX);
    if (Remark != null) param.Remark = Remark;
    return this.send('ModifyRecord', param) !== false;
  }

  async updateDomainRecordRemark(RecordId: string, Remark: string | null): Promise<boolean> {
    return this.send('ModifyRecordRemark', { Domain: this.domain, RecordId: Number(RecordId), Remark: Remark ?? '' }) !== false;
  }

  async deleteDomainRecord(RecordId: string) {
    return this.send('DeleteRecord', { Domain: this.domain, RecordId: Number(RecordId) }) !== false;
  }

  async setDomainRecordStatus(RecordId: string, Status: string) {
    const s = Status === '1' ? 'ENABLE' : 'DISABLE';
    return this.send('ModifyRecordStatus', { Domain: this.domain, RecordId: Number(RecordId), Status: s }) !== false;
  }

  async getRecordLine() {
    const data = await this.send('DescribeRecordLineList', { Domain: this.domain });
    if (!data) return false;
    const lines: Record<string, string> = {};
    for (const line of data.LineList || []) lines[line.Name] = line.LineId;
    for (const group of data.LineGroupList || []) lines[group.Name] = group.LineId;
    return lines;
  }

  async addDomain(Domain: string) {
    return this.send('CreateDomain', { Domain }) !== false;
  }

  private convertType(type: string): string {
    return type === 'REDIRECT_URL' ? '显性URL' : type === 'FORWARD_URL' ? '隐性URL' : type;
  }
  private convertTypeId(type: string): string {
    return type === '显性URL' ? 'REDIRECT_URL' : type === '隐性URL' ? 'FORWARD_URL' : type;
  }
}