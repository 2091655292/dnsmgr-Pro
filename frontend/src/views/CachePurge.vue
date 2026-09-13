<template>
  <div>
    <n-card :bordered="false" title="缓存刷新与预热">
      <n-space vertical size="16">
        <n-radio-group v-model:value="opType">
          <n-radio-button value="url">URL 刷新</n-radio-button>
          <n-radio-button value="dir">目录刷新</n-radio-button>
          <n-radio-button value="preheat">缓存预热</n-radio-button>
        </n-radio-group>

        <n-input
          v-model:value="urlText"
          type="textarea"
          :rows="6"
          :placeholder="placeholderText"
        />

        <n-space align="center">
          <n-button type="primary" :loading="submitting" @click="submit">提交</n-button>
          <n-text depth="3" style="font-size:12px">每行一个 URL；刷新缓存让最新内容立即生效，预热用于提前回源取回常用资源。</n-text>
        </n-space>

        <n-alert v-if="result.msg" :type="result.ok ? 'success' : 'warning'" :show-icon="false" :title="result.msg">
          <div v-for="(f, i) in result.failed" :key="i" style="font-size:12px">{{ f.url }}：{{ f.msg }}</div>
        </n-alert>
      </n-space>
    </n-card>

    <n-card :bordered="false" title="任务历史" style="margin-top:12px">
      <n-data-table
        :columns="columns"
        :data="tasks"
        :loading="loadingTasks"
        :pagination="{ pageSize: 20 }"
        :bordered="false"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NTag } from 'naive-ui';
import { api } from '../api';

const opType = ref<'url' | 'dir' | 'preheat'>('url');
const urlText = ref('');
const submitting = ref(false);
const loadingTasks = ref(false);
const tasks = ref<any[]>([]);
const result = ref<{ ok: boolean; msg: string; failed: { url: string; msg: string }[] }>({ ok: true, msg: '', failed: [] });

const placeholderText = computed(() => {
  if (opType.value === 'dir') return '每行一个目录 URL，例如：\nhttps://www.example.com/images/\nhttps://www.example.com/css/';
  return '每行一个 URL，例如：\nhttps://www.example.com/index.html\nhttps://www.example.com/style.css';
});

const typeName: Record<string, string> = { url: 'URL 刷新', dir: '目录刷新', preheat: '预热', preheat_: '预热' };
const typeTag: Record<string, string> = { url: 'info', dir: 'warning', preheat: 'success', preheat_: 'success' };

const columns = [
  { title: 'URL', key: 'url', ellipsis: { tooltip: true } },
  {
    title: '类型',
    key: 'type',
    width: 110,
    render: (row: any) => h(NTag, { size: 'small', type: (typeTag[row.type] || 'default') as any, bordered: false }, { default: () => typeName[row.type] || row.type }),
  },
  { title: '服务商', key: 'provider', width: 140 },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row: any) => h(NTag, { size: 'small', type: row.status ? 'error' : 'success', bordered: false }, { default: () => (row.status ? '失败' : '成功') }),
  },
  { title: '说明', key: 'msg', width: 160, ellipsis: { tooltip: true } },
  { title: '时间', key: 'addtime', width: 180 },
];

async function submit() {
  const urls = urlText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) {
    result.value = { ok: false, msg: '请填写至少一个 URL', failed: [] };
    return;
  }
  submitting.value = true;
  result.value = { ok: true, msg: '', failed: [] };
  try {
    let res: any;
    if (opType.value === 'preheat') {
      res = await api<any>('POST', '/cdn/preheat', { urls });
    } else {
      res = await api<any>('POST', '/cdn/purge', { type: opType.value, urls });
    }
    if (res.code !== 0) {
      result.value = { ok: false, msg: res.msg || '提交失败', failed: [] };
      return;
    }
    const success = res.success?.length || 0;
    const failed = res.failed || [];
    const action = opType.value === 'preheat' ? '预热' : opType.value === 'dir' ? '目录刷新' : 'URL 刷新';
    if (failed.length) {
      result.value = { ok: false, msg: `${action}完成：成功 ${success} 个，失败 ${failed.length} 个`, failed };
    } else {
      result.value = { ok: true, msg: `${action}已提交，共 ${success} 个 URL`, failed: [] };
      urlText.value = '';
    }
    loadTasks();
  } finally {
    submitting.value = false;
  }
}

async function loadTasks() {
  loadingTasks.value = true;
  try {
    const res = await api<any>('GET', '/cdn/cache-tasks');
    if (res.code === 0) tasks.value = res.data || [];
  } finally {
    loadingTasks.value = false;
  }
}

onMounted(loadTasks);
</script>