<template>
  <div id="appium-panel" v-show="visible">
    <h4 class="panel-title">Appium MJPEG 设置</h4>
    <div class="row">
      <label class="label">缩放%</label>
      <input type="range" min="30" max="100" step="1" id="ap-scale" v-model.number="model.scale" />
      <span class="val" id="ap-scale-val">{{ model.scale }}</span>
    </div>
    <div class="row">
      <label class="label">帧率</label>
      <input type="range" min="1" max="60" step="1" id="ap-fps" v-model.number="model.fps" />
      <span class="val" id="ap-fps-val">{{ model.fps }}</span>
    </div>
    <div class="row">
      <label class="label">质量</label>
      <input type="range" min="5" max="50" step="1" id="ap-quality" v-model.number="model.quality" />
      <span class="val" id="ap-quality-val">{{ model.quality }}</span>
    </div>
    <div class="actions">
      <button class="btn" id="ap-apply" @click="$emit('apply')">应用</button>
      <button class="btn" id="ap-close" @click="$emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  modelValue: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(['update:modelValue', 'apply', 'close']);

const model = computed({
  get: () => props.modelValue,
  set: (next) => emit('update:modelValue', next),
});
</script>

<style scoped>
#appium-panel {
  position: absolute;
  right: 16px;
  bottom: 80px;
  width: 260px;
  padding: 16px;
  background: rgba(15, 15, 18, 0.96);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(12px);
  color: var(--fg);
  z-index: 160;
}

.panel-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.row input[type='range'] {
  flex: 1;
  min-width: 0;
}

.label {
  width: 74px;
  flex-shrink: 0;
}

.val {
  flex: 0 0 44px;
  text-align: right;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
