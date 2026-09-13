<template>
  <div>
    <n-card :bordered="false">
      <template #header>
        <div class="toolbar">
          <span class="title">DNS 劫持检测</span>
          <n-button type="primary" @click="openAdd">
            <template #icon><n-icon :component="AddOutline" /></template>
            添加任务
          </n-button>
        </div>
      </template>
      <n-data-table
        :columns="columns"
        :data="tasks"
        :loading="loading"
        :pagination="{ pageSize: 20 }"
        :bordered="false"
        :row-key="(row: any) => row.id"
      />
      <n-empty class="list-empty" v-if="!loading && !tasks.length" description="暂无检测任务，点击「添加任务」配置自动劫持检测" />
    </n-card>

    <n-modal v-model:show="showEdit" preset="card" title="检测任务" style="max-width: 640px" :mask-closable="false">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="任务名称">
          <n-input v-model:value="form.name" placeholder="可选，便于识别" />
        </n-form-item>
        <n-form-item label="域名">
          <n-select v-model:value="form.did" :options="domainOptions" filterable placeholder="选择要检测的域名" />
        </n-form-item>
        <n-form-item label="检测类型">
          <n-checkbox-group v-model:value="form.types">
            <n-checkbox v-for="t in typeList" :key="t" :value="t" :label="t" style="margin-right: 10px" />
          </n-checkbox-group>
          <n-text depth="3" style="font-size: 12px; display: block; margin-top: 4px">留空表示检测全部类型</n-text>
        </n-form-item>
        <n-form-item label="执行周期">
          <n-radio-group v-model:value="form.cycle">
            <n-radio-button value="daily">每日定时</n-radio-button>
            <n-radio-button value="interval">间隔执行</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item v-if="form.cycle === 'daily'" label="每日时间">
          <n-time-picker v-model:value="form.runTime" format="HH:mm" :clearable="false" />
        </n-form-item>
        <n-form-item v-if="form.cycle === 'interval'" label="间隔分钟">
          <n-input-number v-model:value="form.intervalMin" :min="1" :max="10080" style="width: 200px" />
        </n-form-item>
        <n-form-item label="提醒邮箱">
          <n-input v-model:value="form.noticeEmail" placeholder="留空使用系统默认收件邮箱" />
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="form.active" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEdit = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="showResult" preset="card" title="检测结果" style="max-width: 560px">
      <n-alert
        :type="runningResult.total === 0 || runningResult.issues.length ? 'warning' : 'success'"
        :show-icon="false"
        :title="runningResult.error || (runningResult.issues.length ? `发现 ${runningResult.issues.length} 条异常记录，可能存在劫持！` : `检测完成，共 ${runningResult.total} 条记录，未发现异常`)"
      />
      <n-data-table
        v-if="runningResult.issues && runningResult.issues.length"
        :columns="issueColumns"
        :data="runningResult.issues"
        :bordered="false"
        size="small"
        style="margin-top: 12px"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="showResult = false">关闭</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, reactive, ref } from 'vue';
import { NButton, NSpace, NTag, useMessage, useDialog } from 'naive-ui';
import { AddOutline } from '@vicons/ionicons5';
import { api } from '../api';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const saving = ref(false);
const tasks = ref<any[]>([]);
const domainOptions = ref<any[]>([]);
const showEdit = ref(false);
const editingId = ref<number | null>(null);
const showResult = ref(false);
const runningResult = ref<any>({ total: 0, issues: [], error: '' });
const typeList = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

const form = reactive<any>({ name: '', did: null, types: [], cycle: 'daily', runTime: 4 * 3600000, intervalMin: 60, noticeEmail: '', active: true });

function hmToTs(hm: string): number {
  const [h, m] = String(hm || '04:00').split(':').map((n) => Number(n) || 0);
  return h * 3600000 + m * 60000;
}

function fmtTs(v: number | null): string {
  if (v === null || v === undefined) return '-';
  const d = new Date(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', width: 150, render: (row: any) => row.name || '-' },
  { title: '域名', key: 'domain_name', width: 180 },
  {
    title: '检测类型',
    key: 'types',
    width: 160,
    render: (row: any) => {
      const t = String(row.types || '').trim();
      return t ? t : '全部';
    },
  },
  {
    title: '周期',
    key: 'cycle',
    width: 130,
    render: (row: any) => {
      if (row.cycle === 'interval') return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => `每 ${row.interval_min} 分钟` });
      return h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => `每日 ${row.run_time || '-'}` });
    },
  },
  { title: '提醒邮箱', key: 'notice_email', width: 160, render: (row: any) => row.notice_email || '系统默认' },
  {
    title: '状态',
    key: 'active',
    width: 80,
    render: (row: any) => h(NTag, { size: 'small', type: row.active ? 'success' : 'default', bordered: false }, { default: () => (row.active ? '启用' : '停用') }),
  },
  { title: '上次执行', key: 'last_run', width: 170, render: (row: any) => row.last_run || '-' },
  { title: '下次执行', key: 'next_run', width: 170, render: (row: any) => row.next_run || '-' },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    render(row: any) {
      return h(NSpace, null, {
        default: () => [
          h(NButton, { size: 'small', type: 'primary', onClick: () => runNow(row) }, { default: () => '立即检测' }),
          h(NButton, { size: 'small', onClick: () => toggle(row) }, { default: () => (row.active ? '停用' : '启用') }),
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NButton, { size: 'small', type: 'error', onClick: () => del(row) }, { default: () => '删除' }),
        ],
      });
    },
  },
];

const issueColumns = [
  { title: '主机记录', key: 'name', width: 120 },
  { title: '类型', key: 'type', width: 70 },
  { title: '期望值', key: 'value', width: 150, ellipsis: { tooltip: true } },
  {
    title: '本地解析值',
    key: 'actual',
    render: (row: any) => (row.actual && row.actual.length ? row.actual.join(', ') : '未查询到'),
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row: any) => h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => (row.status === 'not_found' ? '未查询到' : '不匹配') }),
  },
];

async function load() {
  loading.value = true;
  try {
    const res = await api<any>('GET', '/dns-check/tasks');
    if (res.code === 0) tasks.value = res.data || [];
  } finally {
    loading.value = false;
  }
}

async function loadDomains() {
  const res = await api<any>('GET', '/domains');
  if (res.code === 0) {
    domainOptions.value = (res.data || []).map((d: any) => ({ label: d.name, value: d.id }));
  }
}

function openAdd() {
  editingId.value = null;
  Object.assign(form, { name: '', did: null, types: [], cycle: 'daily', runTime: 4 * 3600000, intervalMin: 60, noticeEmail: '', active: true });
  showEdit.value = true;
}

function openEdit(row: any) {
  editingId.value = row.id;
  form.name = row.name || '';
  form.did = row.did;
  form.types = String(row.types || '').split(/[,;，；]/).map((x: string) => x.trim()).filter(Boolean);
  form.cycle = row.cycle === 'interval' ? 'interval' : 'daily';
  form.runTime = hmToTs(row.run_time);
  form.intervalMin = Number(row.interval_min) || 60;
  form.noticeEmail = row.notice_email || '';
  form.active = row.active == 1;
  showEdit.value = true;
}

async function save() {
  if (!form.did) return message.warning('请选择域名');
  if (form.cycle === 'interval' && (!form.intervalMin || form.intervalMin < 1)) return message.warning('请填写间隔分钟数');
  saving.value = true;
  try {
    const runTime = form.cycle === 'daily' ? fmtTs(form.runTime) : null;
    const body: any = {
      name: form.name,
      did: form.did,
      types: form.types.join(','),
      cycle: form.cycle,
      notice_email: form.noticeEmail,
      active: form.active ? 1 : 0,
    };
    if (form.cycle === 'interval') body.interval_min = form.intervalMin;
    else body.run_time = runTime;
    const res = editingId.value
      ? await api('PUT', `/dns-check/tasks/${editingId.value}`, body)
      : await api('POST', '/dns-check/tasks', body);
    if (res.code === 0) {
      message.success(editingId.value ? '保存成功' : '创建成功');
      showEdit.value = false;
      load();
    } else message.error(res.msg);
  } finally {
    saving.value = false;
  }
}

async function runNow(row: any) {
  const res = await api<any>('POST', `/dns-check/tasks/${row.id}/run`);
  if (res.code === 0) {
    runningResult.value = res;
    showResult.value = true;
    load();
  } else message.error(res.msg);
}

async function toggle(row: any) {
  const res = await api('POST', `/dns-check/tasks/${row.id}/toggle`, { active: row.active == 1 ? 0 : 1 });
  if (res.code === 0) {
    message.success(res.msg);
    load();
  } else message.error(res.msg);
}

function del(row: any) {
  dialog.warning({
    title: '删除任务',
    content: `确定删除检测任务「${row.name || 'ID ' + row.id}」吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const res = await api('DELETE', `/dns-check/tasks/${row.id}`);
      if (res.code === 0) {
        message.success('删除成功');
        load();
      } else message.error(res.msg);
    },
  });
}

onMounted(() => {
  load();
  loadDomains();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: 16px;
  font-weight: 600;
}
</style>