/**
 * routes/theme.js —— 主题配置路由
 *
 * 提供系统主题的获取、更新、重置功能。
 * 主题数据以 JSON 字符串形式存储在 systemConfig 表中，使用 key 区分作用域：
 *   - key="theme"  → 全局主题（管理员更新）
 *   - key="theme:{userId}" → 用户个人主题（普通用户更新）
 *
 * 数据隔离逻辑：
 *   - GET 接口公开，不要求登录，先查用户主题，回退到全局主题，最后回退到硬编码默认值
 *   - PUT/POST(reset) 要求认证，管理员操作全局 key，普通用户操作个人 key
 */

const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate } = require('../middlewares/auth')

/**
 * DEFAULT_THEME —— 系统默认主题配色（暖橙色系）
 *
 * 当数据库中没有用户主题也没有全局主题时使用此默认值。
 * 管理员可用 POST /reset 或 PUT 将全局主题恢复为此配色。
 *
 * 各颜色变量用途说明：
 *   primaryColor        - 主色调，用于按钮、标题、强调元素
 *   primaryLight        - 浅主色，用于按钮悬停态、渐变辅助色
 *   primaryDark         - 深主色，用于按钮按下态、渐变暗部
 *   backgroundColor     - 页面整体背景色
 *   cardColor           - 卡片/面板背景色
 *   textColor           - 主要文字颜色
 *   textSecondary       - 次要文字颜色（说明文字、时间戳等）
 *   navBarBgColor       - 顶部导航栏背景色
 *   navBarTextStyle     - 顶部导航栏文字样式（white/black）
 *   tabBarSelectedColor - 底部 TabBar 选中图标/文字颜色
 *   tabBarColor         - 底部 TabBar 未选中图标/文字颜色
 *   tabBarBgColor       - 底部 TabBar 背景色
 *   borderColor         - 分割线/边框颜色
 *   successColor        - 成功状态色（绿色）
 *   warningColor        - 警告状态色（黄色）
 *   errorColor          - 错误状态色（红色）
 */
const DEFAULT_THEME = {
  primaryColor: '#ff6b35',
  primaryLight: '#ff9a5c',
  primaryDark: '#e55a2b',
  backgroundColor: '#f5f5f5',
  cardColor: '#ffffff',
  textColor: '#333333',
  textSecondary: '#999999',
  navBarBgColor: '#ff6b35',
  navBarTextStyle: 'white',
  tabBarSelectedColor: '#ff6b35',
  tabBarColor: '#999999',
  tabBarBgColor: '#ffffff',
  borderColor: '#e8e8e8',
  successColor: '#52c41a',
  warningColor: '#faad14',
  errorColor: '#ff4d4f',
}

/**
 * themeKey(userId) —— 生成 systemConfig 表的存储 key
 *
 * key 命名规则：
 *   - 无 userId → "theme"           （全局主题，管理员修改）
 *   - 有 userId → "theme:{userId}"   （用户个人主题，普通用户修改）
 *
 * 这样设计的原因：
 *   - 无需新建表，利用 systemConfig {key, value} 的通用 KV 结构即可
 *   - 命名空间前缀 "theme:" 将主题配置与 systemConfig 中其他配置区分开
 *   - 全局 key 不带冒号后缀，便于与用户 key 区分
 *
 * @param {number|string} userId - 用户 ID，可为空（返回全局 key）
 * @returns {string} 对应的 systemConfig 存储 key
 */
function themeKey(userId) {
  return userId ? `theme:${userId}` : 'theme'
}

/**
 * GET /api/theme —— 获取主题配置（公开接口，无需登录）
 *
 * HTTP Method: GET
 * 请求参数（Query）:
 *   - userId (可选): 用户 ID，传入时尝试获取该用户的个人主题
 * 响应:
 *   - success: true, data: { primaryColor, ... } 主题配色对象
 *
 * 主题获取的回退链（fallback chain）：
 *   1. 先查用户个人主题 (key="theme:{userId}")
 *   2. 若不存在且传了 userId，回退到全局主题 (key="theme")
 *   3. 若全局主题也不存在，回退到硬编码的 DEFAULT_THEME
 *
 * 这样设计保证系统始终有可用主题，不会返回空值。
 */
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query
    const key = themeKey(userId)

    // 第1步：尝试获取用户个人主题
    let config = await prisma.systemConfig.findUnique({ where: { key } })
    if (!config && userId) {
      // 第2步：用户主题不存在，回退到全局主题
      config = await prisma.systemConfig.findUnique({ where: { key: 'theme' } })
    }
    // 第3步：数据库有配置就返回
    if (config) {
      return res.json({ success: true, data: JSON.parse(config.value) })
    }
    // 第4步：数据库无任何配置，返回硬编码默认主题
    res.json({ success: true, data: DEFAULT_THEME })
  } catch (err) {
    // 表不存在或查询异常时，优雅降级为默认主题
    console.error('[theme] get error:', err)
    res.json({ success: true, data: DEFAULT_THEME })
  }
})

/**
 * PUT /api/theme —— 更新主题配置（需认证）
 *
 * HTTP Method: PUT
 * 权限要求: 需要登录（authenticate 中间件）
 * 鉴权中间件: authenticate
 * 请求体 (JSON):
 *   - 部分或全部主题配色字段，如 { primaryColor: '#ff0000', cardColor: '#fff' }
 *
 * 数据隔离逻辑（通过 key 区分作用域）：
 *   - 管理员 (req.user.role === 'ADMIN') → 更新全局主题 key="theme"
 *   - 普通用户 → 更新个人主题 key="theme:{userId}"
 *
 * 使用 upsert（insert-or-update）模式的原因：
 *   - 首次设置主题时 systemConfig 中可能没有对应 key，需要 insert
 *   - 再次修改时 key 已存在，需要 update
 *   - 一个 upsert 操作同时覆盖创建和更新两种场景，避免先查后判的冗余逻辑
 *
 * 数据合并策略：
 *   - 请求体与 DEFAULT_THEME 做浅合并 { ...DEFAULT_THEME, ...theme }
 *   - 保证即使前端只传部分字段，返回的也是一个完整可用的主题对象
 */
router.put('/', authenticate, async (req, res) => {
  try {
    const theme = req.body
    if (!theme || typeof theme !== 'object') {
      return res.status(400).json({ success: false, message: '无效的主题数据' })
    }

    // 用默认主题补全缺失字段，确保存储的是完整配色对象
    const merged = { ...DEFAULT_THEME, ...theme }
    const value = JSON.stringify(merged)
    // 管理员 → 全局 key；普通用户 → 个人 key
    const key = req.user.role === 'ADMIN' ? 'theme' : themeKey(req.user.id)

    // upsert: 存在则更新 value，不存在则创建 {key, value} 记录
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })

    res.json({ success: true, data: merged, message: '主题已更新' })
  } catch (err) {
    console.error('[theme] update error:', err)
    // 表不存在时返回默认主题（优雅降级）
    res.json({ success: true, data: DEFAULT_THEME, message: '主题更新失败，已使用默认主题' })
  }
})

/**
 * POST /api/theme/reset —— 重置主题为系统默认（需认证）
 *
 * HTTP Method: POST
 * 路径: /api/theme/reset
 * 权限要求: 需要登录（authenticate 中间件）
 *
 * 重置逻辑：
 *   - 管理员 → 将全局主题 (key="theme") 重置为 DEFAULT_THEME
 *   - 普通用户 → 将个人主题 (key="theme:{userId}") 重置为 DEFAULT_THEME
 *
 * 同样使用 upsert 模式：无论对应 key 是否存在，都将其 value 设置为 DEFAULT_THEME 的 JSON。
 * 完成后返回 DEFAULT_THEME 对象供前端直接应用。
 */
router.post('/reset', authenticate, async (req, res) => {
  try {
    // 根据角色确定要重置的主题 key
    const key = req.user.role === 'ADMIN' ? 'theme' : themeKey(req.user.id)
    // upsert: 无论是否存在都写入默认主题值
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value: JSON.stringify(DEFAULT_THEME) },
      create: { key, value: JSON.stringify(DEFAULT_THEME) },
    })
    res.json({ success: true, data: DEFAULT_THEME, message: '主题已重置为默认' })
  } catch (err) {
    console.error('[theme] reset error:', err)
    res.json({ success: true, data: DEFAULT_THEME, message: '重置失败，已使用默认主题' })
  }
})

module.exports = router
