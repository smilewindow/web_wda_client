<template>
  <div id="hud-ws-config" v-show="visible">
    <label for="ws-host-port" class="muted">WS 地址</label>
    <input
      type="text"
      id="ws-host-port"
      :value="value"
      placeholder="host:port 或 ws://地址"
      @input="onInput"
    />
    <button class="btn" id="ws-apply" @click="$emit('apply')">应用</button>
  </div>
</template>

<script setup>
const props = defineProps({
  visible: { type: Boolean, default: false },
  value: { type: String, default: '' },
});

const emit = defineEmits(['update:value', 'apply']);

function onInput(event) {
  emit('update:value', event.target.value);
}
</script>
