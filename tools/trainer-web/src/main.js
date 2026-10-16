// Entry point: mounts App.vue with the hint tooltip. Layout of src/ in README.md.
import "@/assets/fonts.css";
import "@/assets/main.css";
import { createApp } from "vue";
import { LANG } from "@/i18n/index.js";
import App from "@/App.vue";
import hintTooltip from "@/plugins/hintTooltip.js";

document.documentElement.lang = LANG;
createApp(App).use(hintTooltip).mount("#app");
