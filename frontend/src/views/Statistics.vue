<template>
  <div>
    <n-card :bordered="false">
      <template #header>
        <div class="toolbar">
          <span class="title">数据统计</span>
          <n-button size="small" @click="load" :loading="loading">
            <template #icon><n-icon :component="RefreshOutline" /></template>
            刷新
          </n-button>
        </div>
      </template>

      <n-space style="margin-bottom: 16px" align="center">
        <n-radio-group v-model:value="range" @update:value="onRangeChange">
          <n-radio-button value="24h">近24小时</n-radio-button>
          <n-radio-button value="today">今天</n-radio-button>
          <n-radio-button value="7d">近7天</n-radio-button>
          <n-radio-button value="30d">近30天</n-radio-button>
          <n-radio-button value="custom">自定义</n-radio-button>
        </n-radio-group>
        <n-date-picker
          v-if="range === 'custom'"
          v-model:value="customRange"
          type="datetimerange"
          format="yyyy-MM-dd HH:mm:ss"
          style="width: 340px"
          clearable
        />
        <n-select
          v-model:value="selectedAid"
          :options="accountOptions"
          placeholder="全部 CDN 账户"
          clearable
          style="width: 200px"
        />
        <n-select
          v-model:value="selectedDomains"
          :options="domainOptions"
          placeholder="全部加速域名"
          multiple
          clearable
          filterable
          style="width: 260px"
        />
      </n-space>

      <n-alert v-if="errors.length" type="warning" :show-icon="false" style="margin-bottom: 16px">
        部分服务商统计获取失败：{{ errors.join('；') }}
      </n-alert>

      <n-grid :cols="isMobile ? 2 : 5" :x-gap="12" :y-gap="12">
        <n-grid-item>
          <n-card size="small" class="stat-card">
            <n-statistic label="加速流量" :value="summary.fluxText">
              <template #prefix><n-icon :component="CloudOutline" color="#3b6df0" /></template>
            </n-statistic>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" class="stat-card">
            <n-statistic label="峰值带宽" :value="summary.bwText" />
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" class="stat-card">
            <n-statistic label="回源流量" :value="summary.bsFluxText" />
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" class="stat-card">
            <n-statistic label="请求总数" :value="summary.reqText" />
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" class="stat-card">
            <n-statistic label="缓存命中率" :value="summary.hitRateText" />
          </n-card>
        </n-grid-item>
      </n-grid>
    </n-card>

    <n-grid :cols="1" :x-gap="12" :y-gap="12" style="margin-top: 12px">
      <n-grid-item>
        <n-card title="流量趋势" size="small">
          <div ref="fluxRef" class="chart"></div>
        </n-card>
      </n-grid-item>
      <n-grid-item>
        <n-card title="带宽趋势（Mbps）" size="small">
          <div ref="bwRef" class="chart"></div>
        </n-card>
      </n-grid-item>
      <n-grid-item>
        <n-card title="请求趋势" size="small">
          <div ref="reqRef" class="chart"></div>
        </n-card>
      </n-grid-item>
      <n-grid-item>
        <n-card title="状态码分布" size="small">
          <div ref="statusRef" class="chart"></div>
        </n-card>
      </n-grid-item>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { CloudOutline, RefreshOutline } from '@vicons/ionicons5';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api } from '../api';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const isMobile = ref(window.innerWidth < 768);
const loading = ref(false);
const range = ref('24h');
const customRange = ref<[number, number] | null>(null);
const accountOptions = ref<{ label: string; value: number }[]>([]);
const domainOptions = ref<{ label: string; value: string }[]>([]);
const selectedAid = ref<number | null>(null);
const selectedDomains = ref<string[]>([]);
const errors = ref<string[]>([]);

const fluxRef = ref<HTMLDivElement>();
const bwRef = ref<HTMLDivElement>();
const reqRef = ref<HTMLDivElement>();
const statusRef = ref<HTMLDivElement>();
const charts: echarts.ECharts[] = [];

const resource = ref<any>(null);
const visits = ref<any>(null);
const status = ref<any>(null);
const labels = ref<string[]>([]);

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}
function fmt(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function computeRange(): { startTime: string; endTime: string } {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range.value === 'today') {
    const tomorrow = new Date(t.getTime() + 86400000);
    return { startTime: fmt(t), endTime: fmt(tomorrow) };
  }
  if (range.value === '7d') {
    const start = new Date(t.getTime() - 6 * 86400000);
    const end = new Date(t.getTime() + 86400000);
    return { startTime: fmt(start), endTime: fmt(end) };
  }
  if (range.value === '30d') {
    const start = new Date(t.getTime() - 29 * 86400000);
    const end = new Date(t.getTime() + 86400000);
    return { startTime: fmt(start), endTime: fmt(end) };
  }
  if (range.value === 'custom' && customRange.value && customRange.value.length === 2) {
    return { startTime: fmt(new Date(customRange.value[0])), endTime: fmt(new Date(customRange.value[1])) };
  }
  return { startTime: fmt(new Date(now.getTime() - 86400000)), endTime: fmt(now) };
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${units[i]}`;
}

function formatBitRate(bps: number): string {
  if (!bps || bps <= 0) return '0 Mbps';
  const mbps = bps / 1024 / 1024;
  return mbps >= 100 ? `${mbps.toFixed(0)} Mbps` : `${mbps.toFixed(2)} Mbps`;
}

const summary = computed(() => {
  const rs = resource.value?.resource_summary || {};
  const vs = visits.value?.visits_summary || {};
  const flux = Number(rs.flux || 0);
  const hitFlux = Number(vs.hit_flux || 0);
  const hitRate = flux > 0 ? (hitFlux / flux) * 100 : 0;
  return {
    fluxText: formatBytes(flux),
    bwText: formatBitRate(Number(rs.bw || 0)),
    bsFluxText: formatBytes(Number(rs.bs_flux || 0)),
    reqText: String(Number(vs.req_num || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    hitRateText: `${hitRate.toFixed(1)}%`,
  };
});

function baseOption(): any {
  return {
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    xAxis: { type: 'category', data: labels.value, boundaryGap: false },
  };
}

function renderChart(el: HTMLDivElement | undefined, option: any, seriesData: any) {
  if (!el) return;
  let chart = echarts.getInstanceByDom(el);
  if (!chart) {
    chart = echarts.init(el);
    charts.push(chart);
  }
  chart.setOption(option, true);
  void seriesData;
}

function renderCharts() {
  const x = labels.value;
  const rs = resource.value?.resource_detail || {};
  const vs = visits.value?.visits_detail || {};
  const st = status.value || {};

  renderChart(fluxRef.value, {
    ...baseOption(),
    series: [
      { name: '访问流量', type: 'line', smooth: true, areaStyle: { opacity: 0.1 }, data: rs.flux || [], tooltip: { valueFormatter: (v: any) => formatBytes(Number(v)) } },
      { name: '回源流量', type: 'line', smooth: true, data: rs.bs_flux || [] },
    ],
  }, null);

  renderChart(bwRef.value, {
    ...baseOption(),
    series: [
      { name: '访问带宽', type: 'line', smooth: true, areaStyle: { opacity: 0.1 }, data: (rs.bw || []).map((v: number) => Math.round((v || 0) / 1024 / 1024)) },
      { name: '回源带宽', type: 'line', smooth: true, data: (rs.bs_bw || []).map((v: number) => Math.round((v || 0) / 1024 / 1024)) },
    ],
  }, null);

  renderChart(reqRef.value, {
    ...baseOption(),
    series: [
      { name: '请求数', type: 'line', smooth: true, areaStyle: { opacity: 0.1 }, data: vs.req_num || [] },
      { name: '命中次数', type: 'line', smooth: true, data: vs.hit_num || [] },
      { name: '回源请求', type: 'line', smooth: true, data: vs.bs_num || [] },
    ],
  }, null);

  const codeNames = ['2xx', '3xx', '4xx', '5xx'];
  renderChart(statusRef.value, {
    ...baseOption(),
    legend: { top: 0 },
    series: codeNames.map((name, i) => ({
      name,
      type: 'bar',
      stack: 'total',
      data: st.status_detail?.[i] || [],
    })),
  }, null);
  void x;
}

async function load() {
  loading.value = true;
  try {
    const { startTime, endTime } = computeRange();
    const res = await api<any>('GET', '/cdn/statistics', {
      startTime,
      endTime,
      type: 'All',
      domains: selectedDomains.value.length ? selectedDomains.value.join(',') : undefined,
      aid: selectedAid.value || undefined,
    });
    if (res.code !== 0) throw new Error(res.msg || '查询失败');
    const data = res.data || {};
    labels.value = data.labels || [];
    resource.value = data.resource || null;
    visits.value = data.visits || null;
    status.value = data.status || null;
    errors.value = (data._errors || []).map((e: string) => e.split(':').pop());
    await nextTick();
    renderCharts();
  } catch (e: any) {
    errors.value = [e?.message || String(e)];
  } finally {
    loading.value = false;
  }
}

function onRangeChange() {
  load();
}

async function loadOptions() {
  const [a, d] = await Promise.all([
    api<any>('GET', '/cdn/accounts').catch(() => ({ code: -1, data: [] })),
    api<any>('GET', '/cdn/domains').catch(() => ({ code: -1, data: [] })),
  ]);
  accountOptions.value = (a.data || []).map((x: any) => ({ label: `${x.name}（${x.typename || x.type}）`, value: x.id }));
  domainOptions.value = (d.data || []).map((x: any) => ({ label: x.name, value: x.name }));
}

function handleResize() {
  isMobile.value = window.innerWidth < 768;
  charts.forEach((c) => c.resize());
}

onMounted(() => {
  loadOptions();
  load();
  window.addEventListener('resize', handleResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  charts.forEach((c) => c.dispose());
});
</script>

<style scoped>
.stat-card {
  text-align: center;
}
.chart {
  width: 100%;
  height: 280px;
}
</style>