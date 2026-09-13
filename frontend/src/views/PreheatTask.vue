<template>
  <div>
    <n-card :bordered="false">
      <template #header>
        <div class="toolbar">
          <span class="title">自动预热</span>
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
      <n-empty class="list-empty" v-if="!loading && !tasks.length" description="暂无预热任务，点击「添加任务」配置自动预热" />
    </n-card>

    <n-modal v-model:show="showEdit" preset="card" title="预热任务" style="max-width: 640px" :mask-closable="false">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="任务名称">
          <n-input v-model:value="form.name" placeholder="可选，便于识别" />
        </n-form-item>
        <n-form-item label="预热链接">
          <n-input v-model:value="form.urls" type="textarea" :rows="6" placeholder="每行一个 URL，例如：&#10;https://www.example.com/index.html&#10;https://www.example.com/style.css" />
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
const showEdit = ref(false);
const editingId = ref<number | null>(null);
const form = reactive<any>({ name: '', urls: '', cycle: 'daily', runTime: 3 * 3600000 + 30 * 60000, intervalMin: 60, active: true });

function fmtRunTime(v: number | null): string {
  if (v === null || v === undefined) return '-';
  const d = new Date(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', width: 150, render: (row: any) => row.name || '-' },
  {
    title: '预热链接',
    key: 'urls',
    ellipsis: { tooltip: true },
    render: (row: any) => {
      const list = String(row.urls || '').split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
      return `${list.length} 条`;
    },
  },
  {
    title: '执行周期',
    key: 'cycle',
    width: 140,
    render: (row: any) => {
      if (row.cycle === 'interval') return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => `每 ${row.interval_min} 分钟` });
      return h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => `每日 ${row.run_time || '-'}` });
    },
  },
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
          h(NButton, { size: 'small', type: 'primary', onClick: () => runNow(row) }, { default: () => '立即执行' }),
          h(NButton, { size: 'small', onClick: () => toggle(row) }, { default: () => (row.active ? '停用' : '启用') }),
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NButton, { size: 'small', type: 'error', onClick: () => del(row) }, { default: () => '删除' }),
        ],
      });
    },
  },
];

async function load() {
  loading.value = true;
  try {
    const res = await api<any>('GET', '/cdn/preheat-tasks');
    if (res.code === 0) tasks.value = res.data || [];
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  editingId.value = null;
  form.name = '';
  form.urls = '';
  form.cycle = 'daily';
  form.runTime = 3 * 3600000 + 30 * 60000;
  form.intervalMin = 60;
  form.active = true;
  showEdit.value = true;
}

function hmToTimestamp(hm: string): number {
  const [h, m] = String(hm || '03:30').split(':').map((n) => Number(n) || 0);
  return h * 3600000 + m * 60000;
}

function openEdit(row: any) {
  editingId.value = row.id;
  form.name = row.name || '';
  form.urls = row.urls || '';
  form.cycle = row.cycle === 'interval' ? 'interval' : 'daily';
  form.runTime = hmToTimestamp(row.run_time);
  form.intervalMin = Number(row.interval_min) || 60;
  form.active = row.active == 1;
  showEdit.value = true;
}

async function save() {
  if (!form.urls.trim()) return message.warning('请填写预热链接');
  if (form.cycle === 'interval' && (!form.intervalMin || form.intervalMin < 1)) return message.warning('请填写间隔分钟数');
  saving.value = true;
  try {
    const runTime = form.cycle === 'daily' ? fmtRunTime(form.runTime) : null;
    const body: any = { name: form.name, urls: form.urls, cycle: form.cycle, active: form.active ? 1 : 0 };
    if (form.cycle === 'interval') body.interval_min = form.intervalMin;
    else body.run_time = runTime;
    const res = editingId.value
      ? await api('PUT', `/cdn/preheat-tasks/${editingId.value}`, body)
      : await api('POST', '/cdn/preheat-tasks', body);
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
  const res = await api<any>('POST', `/cdn/preheat-tasks/${row.id}/run`);
  if (res.code === 0) {
    message.success(`执行完成：成功 ${res.success || 0} 个，失败 ${res.failed || 0} 个`);
    load();
  } else message.error(res.msg);
}

async function toggle(row: any) {
  const res = await api('POST', `/cdn/preheat-tasks/${row.id}/toggle`, { active: row.active == 1 ? 0 : 1 });
  if (res.code === 0) {
    message.success(res.msg);
    load();
  } else message.error(res.msg);
}

function del(row: any) {
  dialog.warning({
    title: '删除任务',
    content: `确定删除预热任务「${row.name || 'ID ' + row.id}」吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const res = await api('DELETE', `/cdn/preheat-tasks/${row.id}`);
      if (res.code === 0) {
        message.success('删除成功');
        load();
      } else message.error(res.msg);
    },
  });
}

onMounted(load);
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