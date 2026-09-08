// pi-mode-switcher · 单一扩展入口（包根 index.ts，横幅显示为包名）
// 内部组合模式管理（命令）与模式切换（事件）两个模块
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runManager from "./extensions/mode-manager.ts";
import runSwitcher from "./extensions/mode-switcher.ts";

export default function (pi: ExtensionAPI) {
  runManager(pi);   // 先注册 /mode、/link 等管理命令
  runSwitcher(pi);  // 再注册 session_start / before_agent_start 等事件
}
