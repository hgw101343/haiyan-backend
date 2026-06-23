const express = require('express')
const router = express.Router()
const axios = require('axios')
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')
const { authenticate } = require('../middlewares/auth')

const crypto = require('crypto')

// 简单的密码哈希
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

/**
 * POST /api/auth/admin/login
 * 管理员账号密码登录
 */
router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '请输入用户名和密码' })
    }

    const hashed = hashPassword(password)
    const user = await prisma.user.findFirst({
      where: {
        nickname: username,
        passwordHash: hashed,
        role: 'ADMIN'
      }
    })

    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    const token = jwt.sign(
      { userId: user.id, openid: user.openid },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          phone: user.phone,
          role: user.role
        }
      }
    })
  } catch (err) {
    console.error('[管理登录] 异常:', err.message)
    res.status(500).json({ success: false, message: '登录失败' })
  }
})

/**
 * POST /api/auth/login
 * 微信登录 —— 前端传入 code，后端换取 openid
 */
router.post('/login', async (req, res) => {
  try {
    const { code } = req.body
    if (!code) {
      return res.status(400).json({ success: false, message: '缺少 code 参数' })
    }

    // 检查环境变量
    if (!process.env.WECHAT_APPID || !process.env.WECHAT_SECRET) {
      console.error('[登录] 缺少 WECHAT_APPID 或 WECHAT_SECRET 环境变量')
      return res.status(500).json({ success: false, message: '服务端配置缺失，请联系管理员' })
    }

    console.log('[登录] 请求微信 jscode2session, code:', code.substring(0, 10) + '...')

    // 请求微信 jscode2session 接口
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: process.env.WECHAT_APPID,
        secret: process.env.WECHAT_SECRET,
        js_code: code,
        grant_type: 'authorization_code'
      }
    })

    console.log('[登录] 微信返回:', JSON.stringify(wxRes.data))

    const { openid, errcode, errmsg } = wxRes.data
    if (errcode) {
      console.error('[登录] 微信 API 错误:', errcode, errmsg)
      return res.status(400).json({ success: false, message: `微信登录失败: ${errmsg} (错误码: ${errcode})` })
    }

    if (!openid) {
      console.error('[登录] 未获取到 openid')
      return res.status(400).json({ success: false, message: '微信登录失败: 未获取到 openid' })
    }

    // 查找或创建用户
    let user = await prisma.user.findUnique({ where: { openid } })
    if (!user) {
      user = await prisma.user.create({
        data: { openid, nickname: `用户${Date.now()}` }
      })
    }

    // 生成 JWT
    const token = jwt.sign(
      { userId: user.id, openid: user.openid },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )

    console.log('[登录] 成功, userId:', user.id)

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          phone: user.phone,
          role: user.role
        }
      }
    })
  } catch (err) {
    console.error('[登录] 异常:', err.message)
    console.error('[登录] 完整错误:', err)
    res.status(500).json({ success: false, message: `登录失败: ${err.message}` })
  }
})

/**
 * PUT /api/auth/profile
 * 更新用户资料
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { nickname, avatar, phone } = req.body
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { nickname, avatar, phone }
    })
    res.json({ success: true, data: user })
  } catch (err) {
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

/**
 * GET /api/auth/me
 * 获取当前用户信息
 */
router.get('/me', authenticate, (req, res) => {
  const { id, nickname, avatar, phone, role } = req.user
  res.json({ success: true, data: { id, nickname, avatar, phone, role } })
})

module.exports = router
