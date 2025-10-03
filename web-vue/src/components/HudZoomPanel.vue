<template>
  <div id="hud-zoom" v-show="visible">
    <label for="view-zoom" class="muted" style="min-width:72px">画面缩放%</label>
    <input
      type="range"
      id="view-zoom"
      min="50"
      max="200"
      step="5"
      :value="modelValue"
      @input="onInput"
    />
    <span class="val" id="view-zoom-val">{{ label }}</span>
  </div>
</template>

<script setup>
const props = defineProps({
  visible: { type: Boolean, default: false },
  modelValue: { type: Number, default: 100 },
  label: { type: [Number, String], default: '' },
});

const emit = defineEmits(['update:modelValue']);

function onInput(event) {
  const next = Number(event.target.value);
  emit('update:modelValue', Number.isFinite(next) ? next : props.modelValue);
}
</script>
