const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')

// 默认主题（暖橙色）
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

/** GET /api/theme —— 获取当前主题（公开） */
router.get('/', async (_req, res) => {
  try {
    let config = await prisma.systemConfig.findUnique({ where: { key: 'theme' } })
    if (config) {
      return res.json({ success: true, data: JSON.parse(config.value) })
    }
    // 返回默认主题
    res.json({ success: true, data: DEFAULT_THEME })
  } catch (err) {
    console.error('[theme] get error:', err)
    res.status(500).json({ success: false, message: '获取主题失败' })
  }
})

/** PUT /api/theme —— 更新主题（管理员） */
router.put('/', authenticate, isAdmin, async (req, res) => {
  try {
    const theme = req.body
    if (!theme || typeof theme !== 'object') {
      return res.status(400).json({ success: false, message: '无效的主题数据' })
    }

    // 合并默认值，确保所有字段存在
    const merged = { ...DEFAULT_THEME, ...theme }
    const value = JSON.stringify(merged)

    await prisma.systemConfig.upsert({
      where: { key: 'theme' },
      update: { value },
      create: { key: 'theme', value },
    })

    res.json({ success: true, data: merged, message: '主题已更新' })
  } catch (err) {
    console.error('[theme] update error:', err)
    res.status(500).json({ success: false, message: '更新主题失败' })
  }
})

/** POST /api/theme/reset —— 重置为默认主题（管理员） */
router.post('/reset', authenticate, isAdmin, async (_req, res) => {
  try {
    await prisma.systemConfig.upsert({
      where: { key: 'theme' },
      update: { value: JSON.stringify(DEFAULT_THEME) },
      create: { key: 'theme', value: JSON.stringify(DEFAULT_THEME) },
    })
    res.json({ success: true, data: DEFAULT_THEME, message: '主题已重置为默认' })
  } catch (err) {
    console.error('[theme] reset error:', err)
    res.status(500).json({ success: false, message: '重置主题失败' })
  }
})

module.exports = router
