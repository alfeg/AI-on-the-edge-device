// Entry point. The page is Vue components (src/ui/), their state and actions (src/app/),
// and the plain modules underneath: device access (device.js), browser storage (store.js),
// labels and readiness, and TensorFlow.js training in a Web Worker (worker.js).
import "./fonts.css";
import "./ui/style.css";
import { createApp } from "vue";
import { LANG } from "./i18n.js";
import App from "./ui/App.vue";

document.documentElement.lang = LANG;
createApp(App).mount("#app");
