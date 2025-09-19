<template>
  <div class="toast-host">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="toast.intent === 'ok' ? 'ok' : 'err'"
    >
      <span class="title">{{ toast.intent === 'ok' ? '提示' : '错误' }}</span>
      <span class="msg">{{ toast.message }}</span>
      <span class="close" role="button" @click="removeToast(toast.id)">✕</span>
    </div>
  </div>
</template>

<script setup>
import { useToastStore } from '../stores/toastStore';

const { toasts, removeToast } = useToastStore();
</script>

<style scoped>
.toast-host {
  position: fixed;
  right: 12px;
  top: 64px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 9999;
}
.toast {
  position: static;
}
</style>
