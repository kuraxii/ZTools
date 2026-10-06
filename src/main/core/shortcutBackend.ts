import portalGlobalShortcuts, { isWaylandSession } from './portalGlobalShortcuts.js'

/**
 * 全局快捷键后端
 * - native：Electron globalShortcut 原生流程（Windows / macOS / Linux X11 / 非 KDE Wayland 兜底）
 * - portal：GlobalShortcuts portal 流程（仅 KDE Wayland，Electron globalShortcut 在 Wayland 下失效）
 */
export type ShortcutBackend = 'native' | 'portal'

/** 已探测并缓存的后端；null 表示尚未完成探测 */
let cachedBackend: ShortcutBackend | null = null
/** 进行中的探测 Promise（幂等，避免并发探测重复建连） */
let detectionPromise: Promise<ShortcutBackend> | null = null

/**
 * 探测并缓存全局快捷键后端（幂等）
 * 分发规则：仅 Linux Wayland 会话且存在 kglobalaccel 服务（KDE）时走 portal，
 * 其余环境（非 Linux、X11、非 KDE Wayland）一律回退 Electron globalShortcut 原生流程。
 * 探测结果进程内缓存，启动阶段调用一次即可，后续注册路径同步读取
 * @returns 解析完成的后端类型
 */
export async function detectShortcutBackend(): Promise<ShortcutBackend> {
  if (cachedBackend) return cachedBackend
  if (!detectionPromise) {
    detectionPromise = (async (): Promise<ShortcutBackend> => {
      // 默认 native；只有命中 KDE Wayland 才切换 portal
      let backend: ShortcutBackend = 'native'
      if (process.platform === 'linux' && isWaylandSession()) {
        try {
          if (await portalGlobalShortcuts.isKdeEnvironment()) backend = 'portal'
        } catch (error) {
          // 探测异常按非 KDE 处理，回退原生流程
          console.warn('[ShortcutBackend] KDE 环境探测失败，回退原生流程:', error)
        }
      }
      cachedBackend = backend
      console.log(`[ShortcutBackend] 快捷键后端: ${backend}`)
      return backend
    })()
  }
  return detectionPromise
}

/**
 * 同步读取当前快捷键后端
 * 探测完成前调用（含 E2E 模式跳过探测时）兜底返回 native，保证注册路径可同步决策
 * @returns 当前生效的后端类型
 */
export function getShortcutBackend(): ShortcutBackend {
  return cachedBackend ?? 'native'
}
