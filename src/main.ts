import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { installTauriApi } from './platform/tauriApi'

// 화면 코드보다 먼저 플랫폼 API(window.electronApi 호환)를 설치한다
installTauriApi()

const app = createApp(App)

app.use(router)

app.mount('#app')
