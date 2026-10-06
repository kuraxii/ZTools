import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * Linux 全局快捷键 Portal 管理器（实验性，仅用于 KDE Wayland 环境）
 *
 * 通过 xdg-desktop-portal 的 org.freedesktop.portal.GlobalShortcuts D-Bus 接口注册全局快捷键，
 * 解决 Electron globalShortcut 在 Wayland 会话下失效的问题。
 * 是否启用 portal 由 shortcutBackend.ts 在启动时分发：仅 KDE Wayland 走本模块，其余回退原生流程。
 *
 * 版本兼容策略（按 portal 版本自动降级）：portal >= 1.21 需先 Registry.Register 注册应用身份；
 * 1.7 ~ 1.20 身份注册失败仅记录并继续；< 1.7 无 GlobalShortcuts 接口，注册返回失败。
 *
 * 双路径注册：KDE 环境（存在 kglobalaccel）先直连预注册动作与键位，BindShortcuts 不传
 * preferred_trigger 静默沿用（零弹窗）；不覆盖用户在系统设置中的改键，仅 forceSetKeys 时覆盖。
 * 非 KDE 环境（分发层已保证不会进入）兜底传入 preferred_trigger，首次绑定弹授权对话框。
 *
 * 会话语义：一个 session 只能 BindShortcuts 一次，任何变更走"关旧会话 → 新建 → 全量重绑"；
 * 应用身份每个 D-Bus 连接只能 Register 一次，portal 重启后重新注册。
 *
 * 信号：Activated/Deactivated/ShortcutsChanged 为广播信号需显式 AddMatch；
 * Response 由 portal 单播；NameOwnerChanged 用于 portal 重启检测。
 */

const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop'
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop'
const GLOBAL_SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts'
const REGISTRY_IFACE = 'org.freedesktop.host.portal.Registry'
const SESSION_IFACE = 'org.freedesktop.portal.Session'
const REQUEST_IFACE = 'org.freedesktop.portal.Request'
const DBUS_SERVICE_NAME = 'org.freedesktop.DBus'
const DBUS_OBJECT_PATH = '/org/freedesktop/DBus'

/** KDE kglobalaccel 服务（预注册路径专用，非 KDE 环境自动跳过） */
const KGA_NAME = 'org.kde.kglobalaccel'
const KGA_PATH = '/kglobalaccel'
const KGA_IFACE = 'org.kde.KGlobalAccel'
/** kglobalaccel Component 接口（读取组件现有动作） */
const KGA_COMPONENT_IFACE = 'org.kde.kglobalaccel.Component'
/** setShortcutKeys 的 flags：SetPresent(2) | NoAutoloading(4)，即用传入键且立即生效 */
const KGA_SET_FLAGS = 6
/**
 * QKeySequence 在 D-Bus 上的和弦位数组固定长度
 * kglobalaccel 6.7.x 及更早版本的反序列化会无条件读取 4 个元素（KDE Bug 524700），
 * 不足 4 个会导致 kwin_wayland 越界 abort 崩溃，因此发送前必须补齐到 4 位
 */
const QT_KEYSEQUENCE_CHORD_LENGTH = 4

/** 生产环境 app_id（必须与 electron-builder 安装的 top.z-tools.desktop 文件名一致） */
const PROD_APP_ID = 'top.z-tools'
/** 开发环境 app_id（独立身份，避免 ~/.local 下的 dev desktop 文件遮蔽生产安装的同名文件） */
const DEV_APP_ID = 'ztools-dev'

/** D-Bus 连接名称等待超时 */
const BUS_NAME_TIMEOUT_MS = 3000
/** CreateSession 的 Response 信号超时（无用户交互，可较短） */
const CREATE_SESSION_TIMEOUT_MS = 10000
/** BindShortcuts 的 Response 信号超时（KDE 新快捷键首次绑定会弹确认对话框，需等待用户操作） */
const BIND_RESPONSE_TIMEOUT_MS = 60000
/** BindShortcuts 超时后迟到响应的追加监听窗口（用户可能很久才处理对话框） */
const LATE_RESPONSE_GRACE_MS = 300000
/** portal 服务重启后延迟重绑，给新 portal 实例初始化留时间 */
const PORTAL_RESTART_REBIND_DELAY_MS = 1500

/** D-Bus 信号消息类型常量（对应 dbus MessageType.SIGNAL） */
const DBUS_MESSAGE_TYPE_SIGNAL = 4

/**
 * Portal 快捷键绑定定义
 */
export interface PortalShortcutBinding {
  /** 应用内唯一快捷键 ID（同时作为 portal 侧的 shortcut_id） */
  id: string
  /** Electron 格式加速键（如 "Option+Z"） */
  accelerator: string
  /** 展示给用户的快捷键描述（出现在授权对话框与 KDE 系统设置中） */
  description: string
  /** 快捷键触发时的回调 */
  callback: () => void
}

/**
 * 单个快捷键的注册结果
 */
export interface PortalShortcutResult {
  id: string
  success: boolean
  error?: string
  /** portal 返回的触发描述（如 KDE 实际绑定的组合键文本） */
  triggerDescription?: string
  /** Response 超时但绑定请求已提交：等待用户在系统对话框中确认（KDE 新快捷键首次绑定的场景） */
  pendingConfirm?: boolean
  /** 已注册 ID 沿用旧绑定且与本次传入的占位键不一致（用户可能在系统设置中改过键） */
  triggerMismatch?: boolean
}

/**
 * Electron 修饰键名 → XDG shortcuts-spec 修饰键名
 * spec 修饰键仅五种（源自 xkbcommon-names.h 的 XKB_MOD_NAME_*）
 */
const ELECTRON_TO_XDG_MODIFIERS: Record<string, string> = {
  command: 'LOGO',
  cmd: 'LOGO',
  super: 'LOGO',
  meta: 'LOGO',
  commandorcontrol: 'CTRL',
  cmdorctrl: 'CTRL',
  control: 'CTRL',
  ctrl: 'CTRL',
  alt: 'ALT',
  option: 'ALT',
  altgr: 'ALT',
  shift: 'SHIFT',
  num: 'NUM'
}

/**
 * Electron 特殊键名 → xkbcommon keysym 名（去掉 XKB_KEY_ 前缀）
 */
const ELECTRON_TO_XKB_KEYS: Record<string, string> = {
  space: 'space',
  tab: 'Tab',
  enter: 'Return',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  printscreen: 'Print',
  capslock: 'Caps_Lock',
  numlock: 'Num_Lock',
  scrolllock: 'Scroll_Lock',
  plus: 'plus',
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  '[': 'bracketleft',
  ']': 'bracketright',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave',
  mediaplaypause: 'XF86AudioPlay',
  'media play/pause': 'XF86AudioPlay',
  medianexttrack: 'XF86AudioNext',
  'media next track': 'XF86AudioNext',
  mediaprevioustrack: 'XF86AudioPrev',
  'media previous track': 'XF86AudioPrev',
  mediastop: 'XF86AudioStop',
  'media stop': 'XF86AudioStop',
  volumeup: 'XF86AudioRaiseVolume',
  volumedown: 'XF86AudioLowerVolume',
  volumemute: 'XF86AudioMute'
}

/**
 * 加速键转换结果
 */
export interface XdgAcceleratorConversion {
  ok: boolean
  /** 转换后的 XDG shortcuts-spec 格式加速键（如 "ALT+z"） */
  value?: string
  error?: string
}

/**
 * 将 Electron 格式加速键转换为 XDG shortcuts-spec 格式
 * （修饰键 CTRL/ALT/SHIFT/NUM/LOGO + xkbcommon keysym 名，如 "CTRL+SHIFT+z"）
 * @param accelerator Electron 格式加速键（如 "CommandOrControl+Shift+P"）
 * @returns 转换结果；不支持（如纯修饰键、未知键名）时 ok 为 false 并给出错误说明
 */
export function electronAcceleratorToXdg(accelerator: string): XdgAcceleratorConversion {
  if (!accelerator || !accelerator.trim()) {
    return { ok: false, error: '加速键为空' }
  }

  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) {
    return { ok: false, error: `无法解析加速键: ${accelerator}` }
  }

  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const lower = part.toLowerCase()
    const isLast = i === parts.length - 1

    // 非末位必须是修饰键
    if (!isLast) {
      const modifier = ELECTRON_TO_XDG_MODIFIERS[lower]
      if (!modifier) {
        return { ok: false, error: `未知的修饰键 "${part}"` }
      }
      out.push(modifier)
      continue
    }

    // 末位出现修饰键意味着形如 "Ctrl+Ctrl" 的双击修饰键或纯修饰键，portal 不支持
    if (ELECTRON_TO_XDG_MODIFIERS[lower]) {
      return {
        ok: false,
        error: `加速键 "${accelerator}" 以修饰键结尾，GlobalShortcuts portal 不支持纯修饰键或双击修饰键`
      }
    }

    // 特殊键名映射
    const specialKey = ELECTRON_TO_XKB_KEYS[lower]
    if (specialKey) {
      out.push(specialKey)
      continue
    }

    // 功能键 F1-F24 保持大写（XKB_KEY_F1 的 keysym 名为 "F1"）
    if (/^f\d{1,2}$/.test(lower)) {
      out.push(part.toUpperCase())
      continue
    }

    // 单字符键（字母/数字）统一小写（spec 示例为 CTRL+a；SHIFT 状态由修饰键显式表达）
    if (part.length === 1) {
      out.push(lower)
      continue
    }

    return { ok: false, error: `未知的按键 "${part}"` }
  }

  return { ok: true, value: out.join('+') }
}

/**
 * 判断当前是否 Wayland 会话
 * 决定 Linux 下快捷键注册走 portal 还是 Electron globalShortcut
 * @returns Wayland 会话时返回 true
 */
export function isWaylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
}

/** Electron 修饰键名 → Qt::KeyboardModifier 位 */
const ELECTRON_TO_QT_MODIFIERS: Record<string, number> = {
  command: 0x10000000,
  cmd: 0x10000000,
  super: 0x10000000,
  meta: 0x10000000,
  commandorcontrol: 0x04000000,
  cmdorctrl: 0x04000000,
  control: 0x04000000,
  ctrl: 0x04000000,
  alt: 0x08000000,
  option: 0x08000000,
  shift: 0x02000000
}

/** Electron 特殊键名 → Qt::Key 键码 */
const ELECTRON_TO_QT_KEYS: Record<string, number> = {
  space: 0x20,
  tab: 0x01000001,
  enter: 0x01000004,
  return: 0x01000004,
  escape: 0x01000000,
  esc: 0x01000000,
  backspace: 0x01000003,
  delete: 0x01000007,
  del: 0x01000007,
  insert: 0x01000006,
  ins: 0x01000006,
  home: 0x01000010,
  end: 0x01000011,
  pageup: 0x01000016,
  pagedown: 0x01000017,
  up: 0x01000013,
  down: 0x01000015,
  left: 0x01000012,
  right: 0x01000014,
  printscreen: 0x01000009,
  capslock: 0x01000024,
  numlock: 0x01000025,
  scrolllock: 0x01000026,
  plus: 0x2b,
  '=': 0x3d,
  ',': 0x2c,
  '-': 0x2d,
  '.': 0x2e,
  '/': 0x2f,
  '`': 0x60,
  '[': 0x5b,
  ']': 0x5d,
  "'": 0x27,
  ';': 0x3b,
  '\\': 0x5c
}

/** Qt 键码转换结果 */
export interface QtKeyCodeConversion {
  ok: boolean
  value?: number
  error?: string
}

/**
 * 将 Electron 格式加速键转换为 Qt 键码（修饰位 | Qt::Key）
 * 用于 KDE kglobalaccel 预注册的 setShortcutKeys 调用（如 Alt+Z → 134217818）
 * @param accelerator Electron 格式加速键
 * @returns 转换结果；未知修饰键/按键时 ok 为 false
 */
export function electronAcceleratorToQtKeyCode(accelerator: string): QtKeyCodeConversion {
  if (!accelerator || !accelerator.trim()) {
    return { ok: false, error: '加速键为空' }
  }

  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) {
    return { ok: false, error: `无法解析加速键: ${accelerator}` }
  }

  let code = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const lower = part.toLowerCase()
    const isLast = i === parts.length - 1

    if (!isLast) {
      const modifier = ELECTRON_TO_QT_MODIFIERS[lower]
      if (!modifier) {
        return { ok: false, error: `未知的修饰键 "${part}"` }
      }
      code |= modifier
      continue
    }

    // 末位不能是修饰键（双击修饰键不支持程序化设键）
    if (ELECTRON_TO_QT_MODIFIERS[lower]) {
      return { ok: false, error: `加速键 "${accelerator}" 以修饰键结尾，不支持` }
    }

    // 特殊键名映射
    const specialKey = ELECTRON_TO_QT_KEYS[lower]
    if (specialKey !== undefined) {
      code |= specialKey
      continue
    }

    // 功能键 F1-F24：Qt::Key_F1 = 0x01000030，F(n) = 0x0100002F + n
    const fMatch = /^f(\d{1,2})$/.exec(lower)
    if (fMatch) {
      const n = Number(fMatch[1])
      if (n < 1 || n > 24) {
        return { ok: false, error: `不支持的功能键 "${part}"` }
      }
      code |= 0x0100002f + n
      continue
    }

    // 单字符键：字母用大写 ASCII，数字用 ASCII
    if (part.length === 1) {
      code |= part.toUpperCase().charCodeAt(0)
      continue
    }

    return { ok: false, error: `未知的按键 "${part}"` }
  }

  return { ok: true, value: code }
}

/**
 * 构造 QKeySequence 的 D-Bus 和弦位数组（固定 4 元素，不足补零）
 * kglobalaccel 6.7.x 反序列化强制读 4 个元素（KDE Bug 524700），短数组会带崩 kwin
 * @param keyCode Qt 键码（主和弦）
 * @returns 固定 4 元素的和弦位数组
 */
export function buildQtChordArray(keyCode: number): number[] {
  const chords = [keyCode, 0, 0, 0]
  // 硬约束：数组长度必须为 4，防止旧版 kglobalaccel 越界崩溃
  chords.length = QT_KEYSEQUENCE_CHORD_LENGTH
  return chords
}

/**
 * 解析当前运行模式对应的 portal app_id
 * @param isDev 是否开发模式（未打包）
 * @returns app_id（生产 "top.z-tools" / 开发 "ztools-dev"）
 */
export function resolvePortalAppId(isDev: boolean): string {
  return isDev ? DEV_APP_ID : PROD_APP_ID
}

/**
 * 规范化触发键文本用于对比
 * KDE 返回的 trigger_description 是本地化文本（如 "Alt+Z"），与 XDG 规范格式（"ALT+z"）
 * 仅存在大小写差异，统一小写并去除空白后比较
 * @param text 触发键文本
 * @returns 规范化后的文本
 */
export function normalizeTriggerText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/**
 * 生成 dev 模式占位 .desktop 文件内容
 * portal 的 Registry.Register 只校验 app_id 与 desktop 文件 basename 的对应关系，
 * 不校验 Exec 与实际进程的对应关系（已实测确认），dev 模式生成占位文件即可通过身份校验。
 * @param params 文件参数
 * @returns desktop 文件内容字符串
 */
export function buildDesktopFileContent(params: {
  name: string
  exec: string
  comment?: string
}): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${params.name}`,
    `Exec=${params.exec}`
  ]
  if (params.comment) lines.push(`Comment=${params.comment}`)
  lines.push('Terminal=false', 'NoDisplay=true')
  return lines.join('\n') + '\n'
}

/** D-Bus 消息的最小结构类型（避免与 dbus-next 内部类型耦合） */
interface PortalMessage {
  type: number
  path?: string
  interface?: string
  member?: string
  body?: unknown[]
}

/** portal 方法的最小代理类型 */
interface GlobalShortcutsProxy {
  CreateSession: (options: Record<string, unknown>) => Promise<string>
  BindShortcuts: (
    sessionHandle: string,
    shortcuts: Array<[string, Record<string, unknown>]>,
    parentWindow: string,
    options: Record<string, unknown>
  ) => Promise<string>
}

/** portal Request/Response 的响应负载 */
interface PortalResponsePayload {
  /** 0=成功 1=用户取消/拒绝 */
  code: number
  results: Record<string, { value?: unknown }>
}

/** 绑定中的快捷键内部记录 */
interface ActiveBinding {
  binding: PortalShortcutBinding
  /** portal 返回的实际触发描述 */
  triggerDescription?: string
}

/**
 * GlobalShortcuts portal 管理器（单例）
 */
class PortalGlobalShortcutsManager {
  private dbusModule: typeof import('@jellybrick/dbus-next') | null = null
  private bus: import('@jellybrick/dbus-next').MessageBus | null = null
  private portalObject: import('@jellybrick/dbus-next').ProxyObject | null = null
  private globalShortcutsProxy: GlobalShortcutsProxy | null = null
  private sessionPath: string | null = null
  private identityRegistered = false
  private messageListenerInstalled = false
  private matchRuleAdded = false
  /** 当前生效的绑定集合（含 portal 返回的触发描述），供 portal 重启后重绑 */
  private activeBindings: ActiveBinding[] = []
  /** 基础绑定（呼出键等常驻绑定）：每次 setShortcuts 全量提交时自动合并，不会被调用方的局部集合覆盖 */
  private baseBindings: PortalShortcutBinding[] = []
  /** 进行中的重绑计数，避免 portal 重启风暴导致并发重建 */
  private rebinding = false
  /** 注册串行化链条：同一时刻只允许一个 setShortcuts 执行流程 */
  private registrationChain: Promise<void> = Promise.resolve()
  /** 最近一次成功注册的集合签名（去重，避免并发/重复注册弹多个授权对话框） */
  private lastRegistrationSignature: string | null = null
  /** 最近一次成功注册的结果缓存 */
  private lastRegistrationResults: PortalShortcutResult[] | null = null

  /**
   * 全量设置 portal 快捷键（覆盖式）
   * 串行化 + 签名去重：启动链路会对同一快捷键集合并发调用注册
   * （appMain 启动注册默认键 + loadAndApplySettings 应用配置值），
   * 并发注册会创建多个会话并触发多个授权对话框，因此相同集合直接复用结果，
   * 不同集合排队串行执行（后到者优先）
   * @param shortcuts 快捷键绑定列表
   * @param options.forceSetKeys KDE 下强制用传入键覆盖系统侧既有键位（应用内显式改键）；
   *   强制模式绕过去重缓存——系统侧键位可能已偏离上次注册值，相同签名不代表当前系统状态
   * @returns 每个快捷键的注册结果
   */
  async setShortcuts(
    shortcuts: PortalShortcutBinding[],
    options?: { forceSetKeys?: boolean }
  ): Promise<PortalShortcutResult[]> {
    const forceSetKeys = options?.forceSetKeys === true
    // 基础绑定（呼出键等）自动并入提交集合，调用方只需关注自己的局部集合
    const effectiveShortcuts = [...this.baseBindings, ...shortcuts]
    const signature = JSON.stringify(
      effectiveShortcuts
        .map((s) => [s.id, s.accelerator])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    )

    // 与最近一次成功注册相同的集合：直接复用结果，避免重复弹窗
    if (
      !forceSetKeys &&
      this.lastRegistrationSignature === signature &&
      this.lastRegistrationResults
    ) {
      console.log('[PortalShortcuts] 跳过重复的快捷键注册请求（与最近一次注册相同）')
      return this.lastRegistrationResults
    }

    const task = this.registrationChain.then(async () => {
      // 串行窗口内再校验一次（前一任务可能刚注册了相同集合）
      if (
        !forceSetKeys &&
        this.lastRegistrationSignature === signature &&
        this.lastRegistrationResults
      ) {
        console.log('[PortalShortcuts] 跳过重复的快捷键注册请求（串行队列内去重）')
        return this.lastRegistrationResults
      }
      const results = await this.doSetShortcuts(effectiveShortcuts, forceSetKeys)
      // 仅成功的注册进入去重缓存；失败结果保留以便重试。
      // 强制设键同样更新缓存：完成后系统键位已等于注册值，后续重复注册可去重
      if (results.length > 0 && results.every((r) => r.success)) {
        this.lastRegistrationSignature = signature
        this.lastRegistrationResults = results
      }
      return results
    })

    // 链条吞掉错误避免断裂，错误仍通过 task 传给调用方
    this.registrationChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  /**
   * 执行全量设置（实际注册流程）
   * 受 spec "一个 session 只能绑定一次" 约束，任意变更都会重建会话并全量重绑
   * @param shortcuts 快捷键绑定列表
   * @param forceSetKeys KDE 下强制用传入键覆盖系统侧既有键位（应用内显式改键）
   * @returns 每个快捷键的注册结果
   */
  private async doSetShortcuts(
    shortcuts: PortalShortcutBinding[],
    forceSetKeys = false
  ): Promise<PortalShortcutResult[]> {
    // 空列表语义：清空全部绑定
    if (shortcuts.length === 0) {
      await this.clearShortcuts()
      return []
    }

    // 先做加速键格式转换，转换失败的快捷键单独报错不影响其余项
    const converted: Array<{ binding: PortalShortcutBinding; trigger: string }> = []
    const results: PortalShortcutResult[] = []
    for (const binding of shortcuts) {
      const conversion = electronAcceleratorToXdg(binding.accelerator)
      if (!conversion.ok || !conversion.value) {
        results.push({ id: binding.id, success: false, error: conversion.error })
      } else {
        converted.push({ binding, trigger: conversion.value })
      }
    }
    if (converted.length === 0) return results

    // 平台或 portal 不可用：全部失败
    if (process.platform !== 'linux') {
      return this.failAll(converted, '当前平台不支持 GlobalShortcuts portal')
    }
    const ready = await this.ensureConnection()
    if (!ready) {
      return this.failAll(converted, 'GlobalShortcuts portal 不可用')
    }

    let newSessionPath: string | null = null
    try {
      // 关闭旧会话（全量重绑语义）
      await this.closeSession()

      // KDE 预注册：先把动作与当前键直接写入 kglobalaccel（零弹窗、WeChat 式条目），
      // 预注册成功的项在 BindShortcuts 时不传 preferred_trigger，走静默沿用路径；
      // 非 KDE 环境（无 kglobalaccel）自动跳过，回退 preferred_trigger 授权对话框路径。
      // forceSetKeys 仅影响 KDE 有键位的处理：显式改键时覆盖而非沿用系统侧既有键位
      const appId = resolvePortalAppId(!app.isPackaged)
      const appFriendly = app.isPackaged ? 'ZTools' : 'ZTools (Dev)'
      const preregOk = await this.preRegisterKdeShortcuts(appId, appFriendly, converted, {
        overwrite: forceSetKeys
      })

      // 新建会话并绑定全部快捷键
      const sessionPath = await this.createSession()
      newSessionPath = sessionPath
      const bindResults = await this.bindShortcuts(sessionPath, converted, preregOk)

      // 提交状态：仅记录绑定成功的项，并携带 portal 返回的实际触发描述
      const successResults = new Map(
        bindResults.filter((r) => r.success).map((r) => [r.id, r.triggerDescription])
      )
      this.sessionPath = sessionPath
      this.activeBindings = converted
        .filter((c) => successResults.has(c.binding.id))
        .map((c) => ({
          binding: c.binding,
          triggerDescription: successResults.get(c.binding.id)
        }))

      return [...results, ...bindResults]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[PortalShortcuts] 设置快捷键失败:', message)
      // 关闭已创建的新会话，避免残留的授权对话框与泄漏的 session 对象
      if (newSessionPath) await this.closeSession(newSessionPath)
      return this.failAll(converted, message)
    }
  }

  /**
   * 清空全部 portal 快捷键（含彻底删除）
   * 实测（KDE 后端）：BindShortcuts 传入空列表会触发后端 forget-loop 删除全部动作，
   * 会话关闭后抓取释放；配置条目可能残留，但不影响后续重新注册
   * @returns 操作完成后结束的 Promise
   */
  async clearShortcuts(): Promise<void> {
    // 非 Linux 平台无 portal 可言，避免无谓的 D-Bus 连接尝试
    if (process.platform !== 'linux') return

    this.activeBindings = []
    this.baseBindings = []
    // 清空后旧的去重缓存失效，后续同集合注册需真正执行
    this.lastRegistrationSignature = null
    this.lastRegistrationResults = null

    // portal 不可用时仅关闭本地会话状态
    const ready = await this.ensureConnection().catch(() => false)
    if (!ready) {
      await this.closeSession()
      return
    }

    try {
      // 新建会话并向其提交空绑定列表 = 删除该组件全部动作
      const sessionPath = await this.createSession()
      const dbusModule = this.dbusModule
      if (dbusModule) {
        const sender = await this.waitForBusName()
        const token = `ztools_clear_${Date.now()}`
        const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`
        const responsePromise = this.waitForPortalResponse(requestPath, CREATE_SESSION_TIMEOUT_MS)
        await this.globalShortcutsProxy?.BindShortcuts(sessionPath, [], '', {
          handle_token: new dbusModule.Variant('s', token)
        })
        await responsePromise
      }
      await this.closeSession(sessionPath)
      console.log('[PortalShortcuts] 已清空全部快捷键绑定')

      // KDE 环境：连 kglobalaccel 配置条目一起彻底删除，保持系统设置整洁
      await this.unregisterKdeComponentActions()
    } catch (error) {
      console.warn('[PortalShortcuts] 清空快捷键失败（忽略）:', error)
      await this.closeSession()
    }
  }

  /**
   * 销毁管理器：断开 D-Bus 连接并清空全部状态
   * @returns 无返回值
   */
  destroy(): void {
    this.activeBindings = []
    this.baseBindings = []
    this.sessionPath = null
    this.identityRegistered = false
    this.messageListenerInstalled = false
    this.matchRuleAdded = false
    this.lastRegistrationSignature = null
    this.lastRegistrationResults = null
    this.globalShortcutsProxy = null
    this.portalObject = null
    if (this.bus) {
      try {
        this.bus.disconnect()
      } catch {
        // 忽略断开时的异常（总线可能已关闭）
      }
      this.bus = null
    }
  }

  /**
   * 建立 D-Bus 连接并完成身份注册与监听安装
   * @returns 连接与 GlobalShortcuts 接口就绪时返回 true
   */
  private async ensureConnection(): Promise<boolean> {
    // 复用现有连接时仅需确认代理对象仍然存在
    if (this.bus && this.portalObject && this.globalShortcutsProxy) return true

    try {
      // 动态加载 dbus-next，非 Linux 平台不产生加载开销
      this.dbusModule = await import('@jellybrick/dbus-next')
      const dbus = this.dbusModule
      this.bus = dbus.sessionBus()

      // 等待总线分配唯一名称（请求路径的构造依赖它）
      const sender = await this.waitForBusName()

      // 解析 portal 对象并确认 GlobalShortcuts 接口存在
      this.portalObject = await this.bus.getProxyObject(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH)
      if (!this.portalObject.interfaces[GLOBAL_SHORTCUTS_IFACE]) {
        console.warn('[PortalShortcuts] portal 未提供 GlobalShortcuts 接口（版本过旧？）')
        return false
      }
      this.globalShortcutsProxy = this.portalObject.getInterface(
        GLOBAL_SHORTCUTS_IFACE
      ) as unknown as GlobalShortcutsProxy

      // 安装信号监听与 match 规则
      this.installMessageListener()
      await this.addGlobalShortcutsMatchRule()

      // 注册应用身份（portal >= 1.21 必须；老版本接口不存在时跳过）
      await this.tryRegisterIdentity(sender)

      return true
    } catch (error) {
      console.error('[PortalShortcuts] 建立 D-Bus 连接失败:', error)
      this.bus = null
      this.portalObject = null
      return false
    }
  }

  /**
   * 等待 D-Bus 总线分配唯一名称
   * @returns 去掉冒号并将点替换为下划线后的 sender 片段（用于构造请求路径）
   * @throws 超时抛出错误
   */
  private async waitForBusName(): Promise<string> {
    if (!this.bus) throw new Error('D-Bus 总线未初始化')
    if (this.bus.name) return this.bus.name.replace(/^:/, '').replace(/\./g, '_')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('等待 D-Bus 连接名称超时'))
      }, BUS_NAME_TIMEOUT_MS)
      const poll = (): void => {
        if (this.bus?.name) {
          clearTimeout(timer)
          resolve(this.bus.name.replace(/^:/, '').replace(/\./g, '_'))
        } else {
          setTimeout(poll, 100)
        }
      }
      poll()
    })
  }

  /**
   * 安装总线级消息监听器
   * 统一处理 Activated/Deactivated/ShortcutsChanged 与 portal 服务重启事件
   * @returns 无返回值
   */
  private installMessageListener(): void {
    if (!this.bus || this.messageListenerInstalled) return
    this.messageListenerInstalled = true

    this.bus.on('message', (msg: PortalMessage) => {
      try {
        if (msg.type !== DBUS_MESSAGE_TYPE_SIGNAL) return

        // portal 服务重启：新属主出现时重建身份与绑定
        if (
          msg.interface === DBUS_SERVICE_NAME &&
          msg.member === 'NameOwnerChanged' &&
          msg.path === DBUS_OBJECT_PATH
        ) {
          const [name, , newOwner] = msg.body ?? []
          if (name === PORTAL_BUS_NAME && typeof newOwner === 'string' && newOwner) {
            this.handlePortalRestart()
          }
          return
        }

        if (msg.interface !== GLOBAL_SHORTCUTS_IFACE) return

        if (msg.member === 'Activated') {
          const [session, shortcutId] = msg.body ?? []
          if (session !== this.sessionPath || typeof shortcutId !== 'string') return
          const target = this.activeBindings.find((a) => a.binding.id === shortcutId)
          if (target) {
            try {
              target.binding.callback()
            } catch (error) {
              console.error(`[PortalShortcuts] 快捷键 ${shortcutId} 回调执行失败:`, error)
            }
          }
          return
        }

        if (msg.member === 'ShortcutsChanged') {
          const [session] = msg.body ?? []
          if (session !== this.sessionPath) return
          console.log('[PortalShortcuts] 用户在系统设置中修改了快捷键绑定')
          this.syncTriggerDescriptions(msg.body?.[1])
          return
        }

        if (msg.member === 'Deactivated') {
          // 释放型快捷键的松开事件，当前呼出场景无需处理
        }
      } catch (error) {
        console.error('[PortalShortcuts] 处理 portal 信号异常:', error)
      }
    })
  }

  /**
   * 为 GlobalShortcuts 广播信号添加 D-Bus match 规则
   * Response 信号由 portal 单播给调用者无需规则；Activated 等广播信号必须显式订阅
   * @returns 添加完成后结束的 Promise
   */
  private async addGlobalShortcutsMatchRule(): Promise<void> {
    if (!this.bus || !this.dbusModule || this.matchRuleAdded) return
    this.matchRuleAdded = true

    // 规则添加失败不致命（部分总线默认转发广播信号），仅记录
    try {
      const rule = `type='signal',sender='${PORTAL_BUS_NAME}',interface='${GLOBAL_SHORTCUTS_IFACE}'`
      const message = new this.dbusModule.Message({
        destination: DBUS_SERVICE_NAME,
        path: DBUS_OBJECT_PATH,
        interface: DBUS_SERVICE_NAME,
        member: 'AddMatch',
        signature: 's',
        body: [rule]
      })
      await this.bus.call(message)
    } catch (error) {
      console.warn('[PortalShortcuts] 添加信号 match 规则失败（可能影响广播信号接收）:', error)
    }
  }

  /**
   * 注册应用身份到 host registry
   * portal >= 1.21 必须先注册才能创建会话；老版本无此接口时捕获异常并继续
   * @param sender D-Bus sender 片段（仅用于日志）
   * @returns 注册完成后结束的 Promise
   */
  private async tryRegisterIdentity(sender: string): Promise<void> {
    if (!this.portalObject || this.identityRegistered) return

    // 开发模式下确保占位 .desktop 文件存在（生产模式由 electron-builder 安装）
    this.ensureDesktopFile()

    const appId = resolvePortalAppId(!app.isPackaged)
    try {
      const registry = this.portalObject.getInterface(REGISTRY_IFACE) as unknown as {
        Register: (appId: string, options: Record<string, unknown>) => Promise<void>
      }
      await registry.Register(appId, {})
      this.identityRegistered = true
      console.log(`[PortalShortcuts] 应用身份注册成功: ${appId} (sender=${sender})`)
    } catch (error) {
      // 老版本 portal（< 1.20）没有 Registry 接口；沙箱环境（Flatpak 等）也会拒绝注册
      // 两者都可安全忽略：老版本不要求身份，沙箱应用自动获得 app_id
      console.warn('[PortalShortcuts] 应用身份注册跳过（老版本 portal 或沙箱环境）:', error)
    }
  }

  /**
   * 确保当前 app_id 对应的 .desktop 文件存在（仅开发模式）
   * @returns 无返回值
   */
  private ensureDesktopFile(): void {
    // 生产模式由 electron-builder 安装 desktop 文件，无需处理
    if (app.isPackaged) return

    try {
      // 仅开发模式会走到这里，固定使用 dev 身份
      const appId = resolvePortalAppId(true)
      const applicationsDir = process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, 'applications')
        : path.join(app.getPath('home'), '.local', 'share', 'applications')
      fs.mkdirSync(applicationsDir, { recursive: true })
      const desktopPath = path.join(applicationsDir, `${appId}.desktop`)

      // Exec 指向当前 dev 运行命令，保持语义真实；portal 不校验其可执行性
      const content = buildDesktopFileContent({
        name: 'ZTools (Dev)',
        exec: `${process.execPath} ${app.getAppPath()}`,
        comment: 'ZTools 开发模式占位入口（GlobalShortcuts portal 身份注册用）'
      })
      fs.writeFileSync(desktopPath, content, 'utf-8')
    } catch (error) {
      console.warn('[PortalShortcuts] 生成 dev 模式 desktop 文件失败:', error)
    }
  }

  /**
   * 等待指定请求路径上的 portal Response 信号
   * 必须在发起方法调用之前创建本 Promise（Response 信号可能在方法返回后立即到达）
   * @param requestPath 请求对象路径
   * @param timeoutMs 超时毫秒数
   * @returns 响应码与结果字典
   */
  private waitForPortalResponse(
    requestPath: string,
    timeoutMs: number
  ): Promise<PortalResponsePayload> {
    return new Promise<PortalResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bus?.removeListener('message', handler)
        reject(new Error(`portal Response 信号超时（${timeoutMs}ms）: ${requestPath}`))
      }, timeoutMs)

      const handler = (msg: PortalMessage): void => {
        if (
          msg.type === DBUS_MESSAGE_TYPE_SIGNAL &&
          msg.path === requestPath &&
          msg.interface === REQUEST_IFACE &&
          msg.member === 'Response'
        ) {
          clearTimeout(timer)
          this.bus?.removeListener('message', handler)
          const [code, results] = (msg.body ?? []) as [number, Record<string, { value?: unknown }>]
          resolve({ code, results: results ?? {} })
        }
      }

      this.bus?.on('message', handler)
    })
  }

  /**
   * 创建新的 GlobalShortcuts 会话
   * @returns 会话对象路径
   * @throws portal 返回非 0 响应码或超时抛出错误
   */
  private async createSession(): Promise<string> {
    if (!this.bus || !this.globalShortcutsProxy || !this.dbusModule) {
      throw new Error('portal 连接未就绪')
    }

    const sender = await this.waitForBusName()
    const token = `ztools_${Date.now()}`

    // 先挂监听再调用（Response 信号是瞬态的，事后无法补收）
    const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`
    const responsePromise = this.waitForPortalResponse(requestPath, CREATE_SESSION_TIMEOUT_MS)

    await this.globalShortcutsProxy.CreateSession({
      handle_token: new this.dbusModule.Variant('s', token),
      session_handle_token: new this.dbusModule.Variant('s', token)
    })

    const response = await responsePromise
    if (response.code !== 0) {
      throw new Error(`CreateSession 被拒绝（code=${response.code}）`)
    }

    // spec 历史遗留：session_handle 以字符串类型返回
    const sessionHandle = response.results['session_handle']?.value
    if (typeof sessionHandle !== 'string' || !sessionHandle) {
      throw new Error('CreateSession 响应缺少 session_handle')
    }
    return sessionHandle
  }

  /**
   * 设置基础绑定并立即全量重绑
   * 基础绑定是常驻绑定（如呼出键），后续任何调用方提交的局部集合都会自动合并它们；
   * 传空数组表示清除基础绑定（如切换到双击修饰键模式）
   * @param bindings 基础绑定集合
   * @returns 每个快捷键的注册结果；非 Linux 平台返回空数组
   */
  async setBaseBindings(
    bindings: PortalShortcutBinding[],
    options?: { forceSetKeys?: boolean }
  ): Promise<PortalShortcutResult[]> {
    this.baseBindings = bindings
    // 非 portal 环境不提交 D-Bus，仅记录；portal 重启恢复时 activeBindings 为空则只重连
    if (process.platform !== 'linux') return []
    if (bindings.length === 0) {
      await this.clearShortcuts()
      return []
    }
    // 全量重绑会覆盖集合外的绑定：把 activeBindings 里不属于新基础绑定的条目
    // （即各调用方注册的指令快捷键，携带其 callback）一并合并提交，避免被冲掉
    const baseIds = new Set(bindings.map((b) => b.id))
    const preserved = this.activeBindings
      .filter((a) => !baseIds.has(a.binding.id))
      .map((a) => a.binding)
    return await this.setShortcuts([...bindings, ...preserved], {
      forceSetKeys: options?.forceSetKeys === true
    })
  }

  /**
   * 探测 kglobalaccel 服务是否可用（即是否 KDE 环境）
   * 仅探测服务存在性，不做任何注册动作
   * @returns 探测到 kglobalaccel 服务时返回 true；D-Bus 连接失败视为非 KDE 环境返回 false
   */
  async isKdeEnvironment(): Promise<boolean> {
    if (process.platform !== 'linux') return false
    const ready = await this.ensureConnection().catch(() => false)
    if (!ready || !this.bus) return false
    try {
      await this.bus.getProxyObject(KGA_NAME, KGA_PATH)
      return true
    } catch {
      return false
    }
  }

  /**
   * KDE 专用：预注册快捷键到 kglobalaccel（路线：直接写入动作 + 当前键，不设默认键）
   *
   * 预注册后 portal 的 CreateSession.loadActions 会把动作当作"已存在"，
   * BindShortcuts 不传 preferred_trigger 时走静默沿用路径（零弹窗），
   * 系统设置里呈现 WeChat 式条目：有键 + 无启用复选框 + 可单独删除。
   *
   * 每次运行都调 doRegister 重新认领动作所有权（保证 Activated 派发到本实例）；
   * 常规注册已有键时不覆盖（尊重用户在系统设置中的改键），仅无键时用配置值程序化设键；
   * forceSetKeys=true（应用内显式改键）时视为用户意图，已有键也强制写入传入键。
   *
   * 安全约束：setShortcutKeys 的内层和弦数组必须固定 4 元素（KDE Bug 524700，
   * kglobalaccel 6.7.x 及更早版本短数组会越界 abort 带崩 kwin），发送前强制校验。
   *
   * @param appId portal app_id（同 kglobalaccel 组件名）
   * @param appFriendly 组件友好名（系统设置中显示）
   * @param converted 已完成格式转换的快捷键集合
   * @param options.overwrite true 时已有键位也强制写入传入键（应用内显式改键）
   * @returns 预注册成功的快捷键 ID 集合（这些项绑定时不传 preferred_trigger）
   */
  private async preRegisterKdeShortcuts(
    appId: string,
    appFriendly: string,
    converted: Array<{ binding: PortalShortcutBinding }>,
    options?: { overwrite?: boolean }
  ): Promise<Set<string>> {
    const preregOk = new Set<string>()
    if (!this.bus) return preregOk

    // 非 KDE 环境无 kglobalaccel 服务，自动跳过（回退 preferred_trigger 路径）
    try {
      await this.bus.getProxyObject(KGA_NAME, KGA_PATH)
    } catch {
      console.log('[PortalShortcuts] 未检测到 kglobalaccel（非 KDE 环境），跳过预注册')
      return preregOk
    }

    // 读取组件现有动作：必须在 doRegister 之后逐个读取——
    // 组件激活后配置才会加载，才能读到用户在系统设置中改过的键

    for (const c of converted) {
      const actionId = [appId, c.binding.id, appFriendly, c.binding.description]
      try {
        // 重新认领所有权（动作不存在时创建，存在时仅更新属主）
        await this.bus.call(
          new this.dbusModule!.Message({
            destination: KGA_NAME,
            path: KGA_PATH,
            interface: KGA_IFACE,
            member: 'doRegister',
            signature: 'as',
            body: [actionId]
          })
        )

        const existing = (await this.readKdeComponentKeys(appId)).get(c.binding.id)
        const hasKey = existing !== undefined && existing.length > 0 && existing[0] !== 0
        if (hasKey && !options?.overwrite) {
          console.log(
            `[PortalShortcuts] 动作 ${c.binding.id} 已有键绑定，预注册仅认领所有权（不覆盖用户键位）`
          )
          preregOk.add(c.binding.id)
          continue
        }
        // 到这里要么无键（首次注册/用户清空了键），要么显式改键强制覆盖：
        // 都用配置值程序化设置当前键（不设默认键）
        const qt = electronAcceleratorToQtKeyCode(c.binding.accelerator)
        if (!qt.ok || qt.value === undefined) {
          console.warn(
            `[PortalShortcuts] 快捷键 ${c.binding.id} 无法转换为 Qt 键码，回退 preferred_trigger 路径:`,
            qt.error
          )
          continue
        }

        // 和弦数组固定 4 元素（Bug 524700 防护），dbus-next 的 struct 表示需再包一层
        const chord = buildQtChordArray(qt.value)
        if (chord.length !== QT_KEYSEQUENCE_CHORD_LENGTH) {
          throw new Error('和弦数组长度校验失败，拒绝发送')
        }
        const reply = await this.bus.call(
          new this.dbusModule!.Message({
            destination: KGA_NAME,
            path: KGA_PATH,
            interface: KGA_IFACE,
            member: 'setShortcutKeys',
            signature: 'asa(ai)u',
            body: [actionId, [[chord]], KGA_SET_FLAGS]
          })
        )
        if (!reply || reply.type === 3) {
          throw new Error(`setShortcutKeys 被拒绝: ${String(reply?.body?.[0] ?? '')}`)
        }
        console.log(
          `[PortalShortcuts] 动作 ${c.binding.id} 预注册成功（Qt 键码 ${qt.value}${hasKey ? '，覆盖系统侧旧键' : '，零弹窗'}）`
        )
        preregOk.add(c.binding.id)
      } catch (error) {
        // 预注册失败不致命：该项回退 preferred_trigger 路径（首次会弹授权对话框）
        console.warn(`[PortalShortcuts] 快捷键 ${c.binding.id} 预注册失败，回退占位键路径:`, error)
      }
    }
    return preregOk
  }

  /**
   * 读取 KDE 组件现有动作的键位映射
   * @param appId 组件名（app_id）
   * @returns 动作 ID → 键位数组（无组件时返回空映射）
   */
  private async readKdeComponentKeys(appId: string): Promise<Map<string, number[]>> {
    const keys = new Map<string, number[]>()
    if (!this.bus) return keys

    try {
      // kglobalaccel 组件对象路径会把所有非字母数字字符替换为下划线（如 ztools-dev → ztools_dev）
      const componentPath = `/component/${appId.replace(/[^a-zA-Z0-9]/g, '_')}`
      const componentObject = await this.bus.getProxyObject(KGA_NAME, componentPath)
      const componentIface = componentObject.getInterface(KGA_COMPONENT_IFACE) as unknown as {
        allShortcutInfos: () => Promise<unknown[]>
      }
      const infos = await componentIface.allShortcutInfos()
      // 结构 a(ssssssaiai)：[uniqueName, friendly, componentUnique, componentFriendly, contextUnique, contextFriendly, keys, defaultKeys]
      for (const info of infos as unknown[][]) {
        const uniqueName = info[0]
        const keyList = info[6]
        if (typeof uniqueName === 'string' && Array.isArray(keyList)) {
          keys.set(uniqueName, keyList as number[])
        }
      }
    } catch {
      // 组件尚不存在（首次运行），返回空映射
    }
    return keys
  }

  /**
   * KDE 专用：彻底删除当前组件的全部 kglobalaccel 配置条目
   * 仅调用 portal 的 BindShortcuts([]) 不会删除配置条目，需逐个调 kga unregister
   * @returns 操作完成后结束的 Promise
   */
  private async unregisterKdeComponentActions(): Promise<void> {
    if (!this.bus || !this.dbusModule) return
    const appId = resolvePortalAppId(!app.isPackaged)

    try {
      const componentKeys = await this.readKdeComponentKeys(appId)
      for (const [actionId] of componentKeys) {
        const reply = await this.bus.call(
          new this.dbusModule.Message({
            destination: KGA_NAME,
            path: KGA_PATH,
            interface: KGA_IFACE,
            member: 'unregister',
            signature: 'ss',
            body: [appId, actionId]
          })
        )
        if (!reply || reply.type === 3) {
          console.warn(`[PortalShortcuts] kga unregister ${actionId} 失败:`, reply?.body?.[0])
        } else {
          console.log(`[PortalShortcuts] 已彻底删除 kglobalaccel 条目: ${actionId}`)
        }
      }
    } catch (error) {
      console.warn('[PortalShortcuts] kga 清理失败（非 KDE 环境可忽略）:', error)
    }
  }

  /**
   * 绑定快捷键集合到指定会话
   * @param sessionPath 会话对象路径
   * @param converted 已完成格式转换的快捷键集合
   * @param omitPreferredTrigger 已预注册的项不传 preferred_trigger（KDE 静默沿用路径，
   *   避免占位键被设为"默认键"样式；预注册失败的项仍传，回退授权对话框路径）
   * @returns 每个快捷键的绑定结果
   */
  private async bindShortcuts(
    sessionPath: string,
    converted: Array<{ binding: PortalShortcutBinding; trigger: string }>,
    omitPreferredTrigger: Set<string>
  ): Promise<PortalShortcutResult[]> {
    if (!this.bus || !this.globalShortcutsProxy || !this.dbusModule) {
      throw new Error('portal 连接未就绪')
    }

    const sender = await this.waitForBusName()
    const token = `ztools_bind_${Date.now()}`

    // 构造 a(sa{sv}) 快捷键描述数组
    const dbusModule = this.dbusModule
    const shortcutSpecs: Array<[string, Record<string, unknown>]> = converted.map((c) => {
      const opts: Record<string, unknown> = {
        description: new dbusModule.Variant('s', c.binding.description)
      }
      if (!omitPreferredTrigger.has(c.binding.id)) {
        opts['preferred_trigger'] = new dbusModule.Variant('s', c.trigger)
      }
      return [c.binding.id, opts]
    })

    // 先挂监听再调用；KDE 首次绑定可能弹出授权对话框，需等待用户操作
    const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`
    const responsePromise = this.waitForPortalResponse(requestPath, BIND_RESPONSE_TIMEOUT_MS)

    await this.globalShortcutsProxy.BindShortcuts(sessionPath, shortcutSpecs, '', {
      handle_token: new this.dbusModule.Variant('s', token)
    })

    const response = await responsePromise.catch(() => null)
    // 超时不足以下结论：KDE 对新快捷键 ID 的首次绑定会弹系统确认对话框，
    // Response 只在用户操作后才发出。绑定请求已提交且 KGlobalAccel 侧已注册，
    // 此时保持会话存活、乐观启用绑定，并追加迟到响应监听。
    if (!response) {
      console.warn(
        '[PortalShortcuts] BindShortcuts 响应超时，转入待用户确认状态（新快捷键首次绑定会弹出系统对话框）'
      )
      this.watchLateBindResponse(requestPath, LATE_RESPONSE_GRACE_MS)
      return converted.map((c) => ({
        id: c.binding.id,
        success: true,
        pendingConfirm: true
      }))
    }
    if (response.code === 1) {
      throw new Error('用户取消了快捷键授权对话框')
    }
    if (response.code !== 0) {
      throw new Error(`BindShortcuts 被拒绝（code=${response.code}）`)
    }

    // 解析 portal 实际接受的绑定子集与触发描述
    const boundShortcuts = (response.results['shortcuts']?.value ?? []) as Array<
      [string, Record<string, { value?: unknown }>]
    >
    const boundMap = new Map<string, string>()
    for (const [id, props] of boundShortcuts) {
      const triggerDescription = props?.['trigger_description']?.value
      boundMap.set(id, typeof triggerDescription === 'string' ? triggerDescription : '')
    }

    // portal 返回的绑定子集可能小于提交集合（用户在对话框中取消部分绑定）；
    // 已注册 ID 会沿用旧绑定并忽略本次占位键，通过对比触发描述标记差异
    return converted.map((c) => {
      if (!boundMap.has(c.binding.id)) {
        return { id: c.binding.id, success: false, error: 'portal 未接受该快捷键绑定' }
      }
      const triggerDescription = boundMap.get(c.binding.id) || undefined
      const normalizedBound = normalizeTriggerText(triggerDescription ?? '')
      const normalizedDesired = normalizeTriggerText(c.trigger)
      const triggerMismatch =
        !!triggerDescription && normalizedBound.length > 0 && normalizedBound !== normalizedDesired
      if (triggerMismatch) {
        console.warn(
          `[PortalShortcuts] 快捷键 ${c.binding.id} 沿用旧绑定 "${triggerDescription}"，` +
            `与本次占位键 "${c.trigger}" 不一致（用户可能在系统设置中改过键），` +
            '实际生效的触发键以后者为准'
        )
      }
      return {
        id: c.binding.id,
        success: true,
        triggerDescription,
        triggerMismatch
      }
    })
  }

  /**
   * 监听迟到的 BindShortcuts Response 信号
   * 用户在超时后才处理系统确认对话框时，用最终结果同步内部状态
   * @param requestPath 请求对象路径
   * @param graceMs 追加监听窗口毫秒数
   * @returns 无返回值
   */
  private watchLateBindResponse(requestPath: string, graceMs: number): void {
    if (!this.bus) return

    const handler = (msg: PortalMessage): void => {
      if (
        msg.type === DBUS_MESSAGE_TYPE_SIGNAL &&
        msg.path === requestPath &&
        msg.interface === REQUEST_IFACE &&
        msg.member === 'Response'
      ) {
        this.bus?.removeListener('message', handler)
        const [code] = (msg.body ?? []) as [number]
        if (code === 0) {
          console.log('[PortalShortcuts] 用户已确认快捷键对话框（迟到响应），绑定正式生效')
          // 同步实际的触发描述
          const results = (msg.body?.[1] ?? {}) as Record<string, { value?: unknown }>
          const bound = (results['shortcuts']?.value ?? []) as Array<
            [string, Record<string, { value?: unknown }>]
          >
          for (const [id, props] of bound) {
            const target = this.activeBindings.find((a) => a.binding.id === id)
            if (target) {
              const triggerDescription = props?.['trigger_description']?.value
              target.triggerDescription =
                typeof triggerDescription === 'string' ? triggerDescription : undefined
            }
          }
        } else {
          console.warn('[PortalShortcuts] 用户取消了快捷键对话框（迟到响应），绑定未生效')
        }
      }
    }

    this.bus.on('message', handler)
    setTimeout(() => {
      this.bus?.removeListener('message', handler)
    }, graceMs)
  }

  /**
   * 关闭指定（或当前）会话（spec：一个会话只能绑定一次，变更前必须关闭重建）
   * @param targetSessionPath 可选的会话路径；缺省时关闭当前会话
   * @returns 操作完成后结束的 Promise；无目标会话时立即返回
   */
  private async closeSession(targetSessionPath?: string | null): Promise<void> {
    const sessionPath = targetSessionPath ?? this.sessionPath
    if (!sessionPath || !this.bus) {
      if (!targetSessionPath) this.sessionPath = null
      return
    }

    if (sessionPath === this.sessionPath) this.sessionPath = null
    try {
      // 会话对象可能已被 portal 侧销毁（如服务重启），关闭失败不影响后续重建
      const sessionObject = await this.bus.getProxyObject(PORTAL_BUS_NAME, sessionPath)
      const sessionInterface = sessionObject.getInterface(SESSION_IFACE) as unknown as {
        Close: () => Promise<void>
      }
      await sessionInterface.Close()
    } catch {
      // 静默：旧会话关闭失败不构成错误
    }
  }

  /**
   * portal 服务重启后的恢复流程
   * 延迟执行以等待新 portal 实例完成初始化
   * @returns 无返回值
   */
  private handlePortalRestart(): void {
    if (this.rebinding) return
    this.rebinding = true

    setTimeout(() => {
      this.rebinding = false
      // 身份注册状态随 portal 实例失效，重置后由 ensureConnection 重新注册
      this.identityRegistered = false
      this.sessionPath = null
      // portal 重启后需真正重新注册，去重缓存同步失效
      this.lastRegistrationSignature = null
      this.lastRegistrationResults = null
      this.bus = null
      this.portalObject = null
      this.globalShortcutsProxy = null

      void (async () => {
        // 没有需要恢复的绑定时仅重建连接与身份
        if (this.activeBindings.length === 0) {
          await this.ensureConnection()
          return
        }
        console.log('[PortalShortcuts] portal 已重启，重新绑定全部快捷键')
        await this.setShortcuts(this.activeBindings.map((a) => a.binding))
      })()
    }, PORTAL_RESTART_REBIND_DELAY_MS)
  }

  /**
   * 同步 ShortcutsChanged 信号返回的最新触发描述
   * @param shortcutsBody 信号中的 a(sa{sv}) 负载
   * @returns 无返回值
   */
  private syncTriggerDescriptions(shortcutsBody: unknown): void {
    try {
      const shortcuts = (shortcutsBody ?? []) as Array<
        [string, Record<string, { value?: unknown }>]
      >
      for (const [id, props] of shortcuts) {
        const target = this.activeBindings.find((a) => a.binding.id === id)
        if (target) {
          const triggerDescription = props?.['trigger_description']?.value
          target.triggerDescription =
            typeof triggerDescription === 'string' ? triggerDescription : undefined
        }
      }
    } catch (error) {
      console.warn('[PortalShortcuts] 解析 ShortcutsChanged 信号失败:', error)
    }
  }

  /**
   * 批量生成失败结果
   * @param converted 已转换的快捷键集合
   * @param error 统一错误信息
   * @returns 全部失败的注册结果
   */
  private failAll(
    converted: Array<{ binding: PortalShortcutBinding }>,
    error: string
  ): PortalShortcutResult[] {
    return converted.map((c) => ({ id: c.binding.id, success: false, error }))
  }
}

export default new PortalGlobalShortcutsManager()
