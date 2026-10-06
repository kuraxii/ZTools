import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模块顶层 import 了 electron 的 app（仅 isPackaged/getPath/getAppPath）与惰性 dbus-next，
// 单元测试用 mock 替换 electron，避免拉起真实运行时
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/home/tester'),
    getAppPath: vi.fn(() => '/project')
  }
}))

import {
  electronAcceleratorToXdg,
  electronAcceleratorToQtKeyCode,
  buildQtChordArray,
  buildDesktopFileContent,
  resolvePortalAppId,
  normalizeTriggerText,
  isWaylandSession
} from '../../src/main/core/portalGlobalShortcuts'

describe('electronAcceleratorToXdg', () => {
  it('转换 ZTools 默认呼出键 Option+Z 为 ALT+z', () => {
    expect(electronAcceleratorToXdg('Option+Z')).toEqual({ ok: true, value: 'ALT+z' })
  })

  it('转换 Alt 系列修饰键', () => {
    expect(electronAcceleratorToXdg('Alt+Space')).toEqual({ ok: true, value: 'ALT+space' })
    expect(electronAcceleratorToXdg('Alt+Q')).toEqual({ ok: true, value: 'ALT+q' })
  })

  it('转换 CommandOrControl 与 Ctrl 为 CTRL', () => {
    expect(electronAcceleratorToXdg('CommandOrControl+Shift+P')).toEqual({
      ok: true,
      value: 'CTRL+SHIFT+p'
    })
    expect(electronAcceleratorToXdg('Ctrl+F12')).toEqual({ ok: true, value: 'CTRL+F12' })
  })

  it('转换 Super/Meta/Command 为 LOGO', () => {
    expect(electronAcceleratorToXdg('Super+Z')).toEqual({ ok: true, value: 'LOGO+z' })
    expect(electronAcceleratorToXdg('Meta+L')).toEqual({ ok: true, value: 'LOGO+l' })
  })

  it('转换特殊键名为 xkbcommon keysym', () => {
    expect(electronAcceleratorToXdg('Ctrl+Return')).toEqual({ ok: true, value: 'CTRL+Return' })
    expect(electronAcceleratorToXdg('Alt+PageUp')).toEqual({ ok: true, value: 'ALT+Prior' })
    expect(electronAcceleratorToXdg('Ctrl+BackSpace')).toEqual({
      ok: true,
      value: 'CTRL+BackSpace'
    })
  })

  it('转换功能键 F1-F24 保持大写', () => {
    expect(electronAcceleratorToXdg('Ctrl+f1')).toEqual({ ok: true, value: 'CTRL+F1' })
    expect(electronAcceleratorToXdg('Ctrl+F24')).toEqual({ ok: true, value: 'CTRL+F24' })
  })

  it('转换多媒体键为 XF86 keysym', () => {
    expect(electronAcceleratorToXdg('MediaPlayPause')).toEqual({
      ok: true,
      value: 'XF86AudioPlay'
    })
    expect(electronAcceleratorToXdg('Media Next Track')).toEqual({
      ok: true,
      value: 'XF86AudioNext'
    })
  })

  it('拒绝双击修饰键与纯修饰键结尾的加速键', () => {
    const result = electronAcceleratorToXdg('Ctrl+Ctrl')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不支持')
  })

  it('拒绝未知修饰键与未知按键', () => {
    expect(electronAcceleratorToXdg('Bogus+Z').ok).toBe(false)
    expect(electronAcceleratorToXdg('Ctrl+NoSuchKey').ok).toBe(false)
  })

  it('拒绝空加速键', () => {
    expect(electronAcceleratorToXdg('').ok).toBe(false)
    expect(electronAcceleratorToXdg('   ').ok).toBe(false)
  })
})

describe('isWaylandSession', () => {
  it('依据 XDG_SESSION_TYPE 或 WAYLAND_DISPLAY 判定 Wayland 会话', () => {
    const savedSession = process.env.XDG_SESSION_TYPE
    const savedDisplay = process.env.WAYLAND_DISPLAY
    try {
      delete process.env.WAYLAND_DISPLAY
      process.env.XDG_SESSION_TYPE = 'x11'
      expect(isWaylandSession()).toBe(false)
      process.env.XDG_SESSION_TYPE = 'wayland'
      expect(isWaylandSession()).toBe(true)
      delete process.env.XDG_SESSION_TYPE
      process.env.WAYLAND_DISPLAY = 'wayland-0'
      expect(isWaylandSession()).toBe(true)
    } finally {
      if (savedSession) process.env.XDG_SESSION_TYPE = savedSession
      else delete process.env.XDG_SESSION_TYPE
      if (savedDisplay) process.env.WAYLAND_DISPLAY = savedDisplay
      else delete process.env.WAYLAND_DISPLAY
    }
  })
})

describe('normalizeTriggerText', () => {
  it('统一大小写与空白后对比 KDE 本地化文本与 XDG 规范格式', () => {
    expect(normalizeTriggerText('Alt+Z')).toBe(normalizeTriggerText('ALT+z'))
    expect(normalizeTriggerText('Ctrl+Alt+Z')).toBe(normalizeTriggerText('CTRL+ALT+z'))
    expect(normalizeTriggerText('Alt+Z')).not.toBe(normalizeTriggerText('ALT+x'))
  })
})

describe('electronAcceleratorToQtKeyCode', () => {
  it('转换 ZTools 默认呼出键 Option+Z 为 Qt 键码（Alt=0x08000000 | Z=0x5A）', () => {
    expect(electronAcceleratorToQtKeyCode('Option+Z')).toEqual({ ok: true, value: 134217818 })
  })

  it('转换常见修饰键组合', () => {
    // Ctrl+Shift+P = 0x06000000 | 0x50
    expect(electronAcceleratorToQtKeyCode('CommandOrControl+Shift+P')).toEqual({
      ok: true,
      value: 0x06000000 | 0x50
    })
    // Ctrl+Alt+F12 = 0x0c000000 | 0x0100003b
    expect(electronAcceleratorToQtKeyCode('Ctrl+Alt+F12')).toEqual({
      ok: true,
      value: 0x0c000000 | 0x0100003b
    })
    // Super+Space = 0x10000000 | 0x20
    expect(electronAcceleratorToQtKeyCode('Super+Space')).toEqual({
      ok: true,
      value: 0x10000000 | 0x20
    })
  })

  it('转换 F1-F24 功能键（Qt::Key_Fn = 0x0100002F + n）', () => {
    expect(electronAcceleratorToQtKeyCode('Ctrl+F1')).toEqual({
      ok: true,
      value: 0x04000000 | 0x01000030
    })
    expect(electronAcceleratorToQtKeyCode('F24')).toEqual({ ok: true, value: 0x01000047 })
  })

  it('转换特殊键为 Qt::Key', () => {
    expect(electronAcceleratorToQtKeyCode('Alt+Return')).toEqual({
      ok: true,
      value: 0x08000000 | 0x01000004
    })
    expect(electronAcceleratorToQtKeyCode('Ctrl+Tab')).toEqual({
      ok: true,
      value: 0x04000000 | 0x01000001
    })
  })

  it('拒绝未知键与修饰键结尾', () => {
    expect(electronAcceleratorToQtKeyCode('Ctrl+NoSuchKey').ok).toBe(false)
    expect(electronAcceleratorToQtKeyCode('Ctrl+Ctrl').ok).toBe(false)
    expect(electronAcceleratorToQtKeyCode('F99').ok).toBe(false)
    expect(electronAcceleratorToQtKeyCode('').ok).toBe(false)
  })
})

describe('buildQtChordArray', () => {
  it('和弦数组固定 4 元素（KDE Bug 524700 防护：短数组会带崩 kglobalaccel/kwin）', () => {
    expect(buildQtChordArray(134217818)).toEqual([134217818, 0, 0, 0])
    expect(buildQtChordArray(134217818)).toHaveLength(4)
    expect(buildQtChordArray(42)).toEqual([42, 0, 0, 0])
  })
})

describe('resolvePortalAppId', () => {
  it('开发模式返回 ztools-dev，生产模式返回 top.z-tools', () => {
    expect(resolvePortalAppId(true)).toBe('ztools-dev')
    expect(resolvePortalAppId(false)).toBe('top.z-tools')
  })
})

describe('buildDesktopFileContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('生成合法的 Desktop Entry 内容并隐藏图标显示', () => {
    const content = buildDesktopFileContent({
      name: 'ZTools (Dev)',
      exec: '/usr/bin/electron /project',
      comment: '测试注释'
    })
    expect(content).toContain('[Desktop Entry]')
    expect(content).toContain('Type=Application')
    expect(content).toContain('Name=ZTools (Dev)')
    expect(content).toContain('Exec=/usr/bin/electron /project')
    expect(content).toContain('Comment=测试注释')
    expect(content).toContain('NoDisplay=true')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('省略 comment 时不含 Comment 行', () => {
    const content = buildDesktopFileContent({ name: 'X', exec: '/bin/true' })
    expect(content).not.toContain('Comment=')
  })
})
