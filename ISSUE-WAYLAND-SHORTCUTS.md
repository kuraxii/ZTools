# Wayland 方案整合讨论

## 背景

Electron 在原生 Wayland 后端下有多个功能不可用：

- `globalShortcut.register()` 全部失败
- `BrowserWindow.setPosition()` / `getPosition()` 空操作
- `BrowserWindow.setAlwaysOnTop()` 失效
- `Tray` 部分事件不触发

目前存在两套方案试图解决这些问题，核心分歧在于：**运行在 XWayland 还是原生 Wayland**。

---

## PR #682 的方案：退回 XWayland

提交 `ce9a057`（feat: 支持在 Linux (Wayland) 上运行）。

### 核心理念

检测到 Wayland 会话后，以 `--ozone-platform=x11` 重新 spawn 自身，让整个应用跑在 XWayland 下。X11 下 Electron 所有 API 恢复正常，只需要单独处理全局快捷键。

### 完整改动列表

**Wayland→XWayland 回退**

- `src/main/index.ts`：启动时检测 Wayland 会话，用 spawn 以 `--ozone-platform=x11` 重新 exec，然后 `app.exit(0)`
- 环境变量 `ZTOOLS_NATIVE_WAYLAND=1` 可跳过回退（功能降级）
- 重 exec 必须在 `requestSingleInstanceLock()` 之前执行，否则本进程先持锁

**全局快捷键（GNOME gsettings）**

- `src/main/core/linuxShortcutIntegration.ts`：通过 `gsettings` 写入 GNOME 自定义快捷键
- 提供 `installGnomeShortcut()` 把 Electron 快捷键转换为 GNOME 格式并绑定
- 触发时执行 `ztools --toggle`，走 second-instance 路径切换窗口
- 托盘菜单新增"安装系统唤出快捷键…"入口
- `isGnomeDesktop()` 检测限 GNOME/Ubuntu；非 GNOME 环境只打印提示
- `src/main/appMain.ts`：second-instance 事件新增 `--toggle` 处理分支
- `src/main/managers/windowManager.ts`：新增 `toggleWindowVisibility()` 入口、`shortcutRegistrationError` 字段、Wayland 下注册失败的提示

**应用扫描与缓存**

- `src/main/core/commandScanner/linuxScanner.ts`：按 XDG 优先级以 desktop-file ID 去重
- 补充 `OnlyShowIn` / `NotShowIn` / `TryExec` 过滤
- 修正 `NoDisplay` / `Hidden` 大小写处理
- 遵循 `LANGUAGE` 优先级列表；补充 `GenericName` 别名；图标 URL 编码
- `Terminal=true` / `DBusActivatable=true` 条目改走 `gio launch`，避免启动后消失
- 扫描器上报真实完整性信息，解析失败时不再用空列表覆盖已有缓存
- 修复图标缓存格式校验在 Linux 上永久失败导致每次启动全量重扫的问题

**应用目录监听**

- `src/main/appWatcher.ts`：新增 Linux 分支，用 chokidar 监听 `.desktop` 文件增删改
- 静默期（5s）过滤 chokidar 启动时的初始扫描事件，避免每次启动白跑全量重扫
- `getLinuxApplicationPaths()` 成为扫描与监听共用的唯一来源，补充 XDG_DATA_HOME 与 Flatpak 导出目录

**全局输入模块**

- `src/main/core/globalInputManager.ts`：uiohook-napi 改为惰性 require，加载失败只降级全局输入功能，不再导致主进程启动即崩溃
- 提供 `setUiohookModuleForTesting()` 测试注入

**窗口管理**

- `src/main/managers/windowManager.ts`：
  - Linux 下删除 `type: 'panel'`（X11 下 panel 类型启用 focus-follows-mouse，导致鼠标移出窗口即触发 blur 隐藏）
  - 新增 blur 延迟隐藏定时器，解决 Linux 下失焦竞态
  - `shortcutRegistrationError`：仅在 Wayland 原生后端下区分快捷键注册失败原因
  - Linux 托盘用 `setContextMenu`（StatusNotifierItem 必须），新增左键 `click` 事件
  - 快捷键注册失败时保留旧快捷键的回滚逻辑

**终端启动器**

- `src/main/utils/terminalLauncher.ts`：改用 Ubuntu 26.04 上实际存在的 `xdg-terminal-exec` / `ptyxis` 等
- 托盘补充 `Terminal=true` 条目的支持

**Electron Builder 配置**

- `electron-builder.yml`：Linux 包元信息（maintainer、description、synopsis）
- 固定可执行文件名 `ztools`、`desktopName`
- 补充 deb 依赖 `libayatana-appindicator3-1`, `libnotify4`, `libxtst6`, `libnss3`
- icon 目录指定为 `build/icons/`

**其他**

- 构建图标：`build/icons/` 下 8 个尺寸的 PNG
- 文档：`docs/linux-support.md` 说明实现方式与受 Wayland 限制无法实现的功能
- 测试：`platformIsolation.test.ts`、`linuxShortcutIntegration.test.ts`、`doubleTapManager.test.ts`、`windowManagerMacActivation.test.ts`
- `package.json` 新增 `desktopName` 字段
- 原生输入模块惰性 require 覆盖

---

## feat/wayland-global-shortcuts-portal 的方案：运行在原生 Wayland

提交 `0ad25cc`（feat: Linux KDE Wayland 下通过 GlobalShortcuts portal 注册全局快捷键），在 PR #682 之上构建。

### 核心理念

不退回 XWayland，直接在原生 Wayland 下运行。Wayland 上哪些 API 不可用，就逐个找替代方案。这个方案先把全局快捷键的问题解掉，剩余视觉问题可选修复。

### 完整改动

**快捷键分发层**

- `src/main/core/shortcutBackend.ts`：启动时探测一次桌面环境，选择后端
  - KDE + Wayland → portal 后端
  - 其余 → 回退原生 `globalShortcut`（在 XWayland 下仍有效）
- `src/main/managers/windowManager.ts`：快捷键注册通过分发层路由

**KDE GlobalShortcuts portal 后端**

- `src/main/core/portalGlobalShortcuts.ts`（约 1450 行）：
  - 通过 D-Bus 连接 `org.kde.kglobalaccel`
  - 用 `Registry.Register` 注册应用身份（portal ≥ 1.21）
  - 预注册动作与键位；`BindShortcuts` 不传 `preferred_trigger` 静默沿用
  - 改键走 `forceSetKeys` 覆盖实现零弹窗
  - 依赖 `@jellybrick/dbus-next`

**electron-builder 配置调整**：适配 KDE portal 的额外配置项

**设置页联动**：`src/main/api/renderer/settings.ts` 新增 portal 后端的状态读写

---

## 核心冲突：XWayland vs 原生 Wayland

### 根本分歧

| 维度              | PR #682（XWayland）                       | feat/wayland 分支（原生 Wayland） |
| ----------------- | ----------------------------------------- | --------------------------------- |
| 运行模式          | `--ozone-platform=x11` re-exec            | 原生 Wayland，不 exec             |
| 全局快捷键        | GNOME gsettings                           | KDE D-Bus kglobalaccel            |
| 窗口定位          | X11 `setPosition` 正常工作                | Wayland 下空操作，需另寻方案      |
| 全局输入(uiohook) | X11 正常                                  | 原生 Wayland 下可能失效           |
| setAlwaysOnTop    | X11 正常                                  | Wayland 下空操作                  |
| 视觉渲染          | XWayland 合成层（有拖影、无阴影、无圆角） | 原生 Wayland（无合成层缝隙）      |
| 依赖              | 无额外运行时依赖                          | `@jellybrick/dbus-next` npm 包    |
| 适配范围          | GNOME（其他 DE 回退到无效的 XWayland）    | KDE（其他 DE 待补充）             |

### 争议点

1. **XWayland 是降级而非适配**。XWayland 相比原生 Wayland 有多个已知问题（拖影、阴影、圆角），且 XWayland 可能在未来 Electron 版本中被废弃。PR #682 用重新 exec 的方式绕过 Wayland 限制，本质上是逃避问题而不是解决问题。

2. **但 XWayland 是一次性解决多个问题的捷径**。一旦退回 X11，`setPosition`、`alwaysOnTop`、`globalShortcut`、`uiohook` 全部恢复正常。而原生 Wayland 路线需要逐个功能找替代方案，工作量大且部分功能（如窗口定位）在 Wayland 协议层上就没有标准实现。

3. **两套方案可以共存吗？** 不能让用户同时拥有两种模式。需要决定启动时如何选择后端，以及是否要提供切换开关。

4. **测试覆盖**。PR #682 主要在 GNOME 上测试，KDE 存在拖影、无阴影等问题。原生 Wayland 方案在 KDE 上运行正常，但在 GNOME 上未经测试。

### 后续建议

需要在以下方向上达成一致：

1. 默认走 XWayland 还是原生 Wayland？
2. 如果默认走原生 Wayland，缺失的功能（窗口定位、alwaysOnTop、全局输入）是否都有可接受的替代方案？
3. 是否提供一个运行时开关（`ZTOOLS_NATIVE_WAYLAND`），让用户自行选择？
4. 两个快捷键后端（gsettings / D-Bus portal）能否合为一个统一的 `shortcutBackend` 分发层？
5. 测试矩阵是否要同时覆盖 GNOME + KDE 两个桌面环境？
