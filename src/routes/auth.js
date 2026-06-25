/**
 * routes/auth.js —— 认证与用户管理路由
 *
 * 提供微信小程序登录、手机号登录、管理员账号密码登录、管理员创建/修改用户、
 * 用户资料更新、获取当前用户信息等认证相关功能。
 *
 * 登录方式汇总:
 *   - POST /admin/login        管理员账号密码登录
 *   - POST /phone-login         微信手机号一键登录（新版本 API）
 *   - POST /login              微信小程序 code 登录（旧版本，仅用 openid）
 *
 * 用户管理（管理员专用）:
 *   - POST /admin/register     管理员创建用户
 *   - GET  /admin/users        管理员查看用户列表
 *   - PUT  /admin/users/:id    管理员修改用户信息
 *
 * 个人功能:
 *   - GET  /me                 获取当前登录用户信息
 *   - PUT  /profile            更新个人资料
 *
 * 微信 API 调用说明:
 *   - jscode2session:  用小程序端 code 换取 openid（无需 access_token）
 *   - getAccessToken:  获取全局 access_token（带缓存，用于后续 API 调用）
 *   - getPhoneNumber:  用 phoneCode 换取手机号（需要 access_token，新版 API）
 */

const express = require('express')
const router = express.Router()
const axios = require('axios')
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')

const crypto = require('crypto')

/**
 * hashPassword(password) —— 对密码进行 SHA-256 哈希
 *
 * 使用场景: 管理员创建的账号密码存储时使用哈希而非明文
 * 注意: 这只是简单哈希，生产环境建议使用 bcrypt/argon2 等加盐哈希算法
 *
 * @param {string} password - 明文密码
 * @returns {string} SHA-256 哈希后的十六进制字符串
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

// ============ 微信 access_token 缓存 ============
// 全局缓存变量（模块级别），在服务进程生命周期内持续有效
let cachedAccessToken = null       // 缓存的 access_token 值
let accessTokenExpiresAt = 0      // 过期时间戳（毫秒）

/**
 * getWxAccessToken() —— 获取微信全局 access_token（带内存缓存）
 *
 * 微信 access_token 说明:
 *   - 是调用微信大部分 API 的凭证，有效期通常为 7200 秒（2 小时）
 *   - 每天获取次数有限制，所以必须缓存复用
 *   - 不同小程序的 access_token 是独立的
 *
 * 缓存机制:
 *   1. 检查是否有缓存且未过期（now < accessTokenExpiresAt）
 *      - 命中缓存：直接返回，避免无意义的 API 调用
 *   2. 未命中缓存或已过期：调用微信 API 获取新 token
 *   3. 将 token 和过期时间存入模块级变量
 *
 * 提前 5 分钟过期（安全余量）:
 *   - 微信返回的 expires_in 通常是 7200 秒
 *   - 我们设置 accessTokenExpiresAt = now + (expires_in - 300) * 1000
 *   - 提前 5 分钟使缓存过期，确保高并发场景下不会因过期导致 API 调用失败
 *   - 即使提前过期，重新获取也只需一次 HTTP 请求，成本很低
 *
 * 环境变量依赖:
 *   - WECHAT_APPID: 微信小程序 AppID
 *   - WECHAT_SECRET: 微信小程序 AppSecret
 *
 * @returns {Promise<string>} 有效的 access_token
 * @throws {Error} 如果获取失败（配置缺失或微信返回错误）
 */
async function getWxAccessToken() {
  const now = Date.now()
  // 缓存命中且未过期，直接返回
  if (cachedAccessToken && now < accessTokenExpiresAt) {
    return cachedAccessToken
  }

  const appid = process.env.WECHAT_APPID
  const secret = process.env.WECHAT_SECRET
  if (!appid || !secret) {
    throw new Error('缺少微信 AppID/Secret 配置')
  }

  console.log('[AccessToken] 请求新的 access_token...')
  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: {
      grant_type: 'client_credential',
      appid,
      secret,
    }
  })

  const { access_token, expires_in, errcode, errmsg } = res.data
  if (errcode) {
    console.error('[AccessToken] 获取失败:', errcode, errmsg)
    throw new Error(`获取 access_token 失败: ${errmsg}`)
  }

  // 缓存 token 和过期时间
  cachedAccessToken = access_token
  // 提前 5 分钟过期，留安全余量
  accessTokenExpiresAt = now + (expires_in - 300) * 1000
  console.log('[AccessToken] 获取成功, 有效期至:', new Date(accessTokenExpiresAt).toISOString())
  return access_token
}

/**
 * getPhoneByCode(phoneCode) —— 通过微信 phoneCode 换取用户手机号（新版 API）
 *
 * 微信小程序手机号获取流程:
 *   1. 小程序端调用 wx.login() 获取 loginCode
 *   2. 小程序端调用 button open-type="getPhoneNumber" 获取 phoneCode
 *   3. 前端将 loginCode 和 phoneCode 一起传给后端
 *   4. 后端先用 loginCode 换取 openid（jscode2session）
 *   5. 后端再用 phoneCode + access_token 调用此函数换取手机号
 *
 * API 地址: /wxa/business/getuserphonenumber
 * 请求方式: POST
 * 需要: access_token（通过 getWxAccessToken() 获取）
 *
 * @param {string} phoneCode - 小程序端获取的动态令牌（phoneCode）
 * @returns {Promise<string>} 纯手机号（不含国家代码，如 "13800138000"）
 * @throws {Error} 如果换取失败（errcode !== 0）
 */
async function getPhoneByCode(phoneCode) {
  // 先确保获取到有效的 access_token
  const accessToken = await getWxAccessToken()

  console.log('[GetPhone] 请求手机号, phoneCode:', phoneCode.substring(0, 10) + '...')
  const res = await axios.post(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`,
    { code: phoneCode },
    { headers: { 'Content-Type': 'application/json' } }
  )

  const { errcode, errmsg, phone_info } = res.data
  if (errcode !== 0) {
    console.error('[GetPhone] 换取手机号失败:', errcode, errmsg)
    throw new Error(`换取手机号失败: ${errmsg} (错误码: ${errcode})`)
  }

  // phone_info.purePhoneNumber 是不带国家代码的纯手机号
  const phone = phone_info.purePhoneNumber
  console.log('[GetPhone] 成功获取手机号:', phone)
  return phone
}

/**
 * POST /api/auth/admin/login —— 管理员账号密码登录
 *
 * HTTP Method: POST
 * 权限要求: 无（公开接口）
 *
 * 请求体（JSON）:
 *   - username (必填): 管理员用户名（对应数据库 nickname 字段）
 *   - password (必填): 明文密码
 *
 * 登录流程:
 *   1. 校验参数不为空
 *   2. 对密码做 SHA-256 哈希
 *   3. 在 user 表中按 nickname + passwordHash 查找匹配的用户
 *   4. 找到 → 生成 JWT token 并返回用户信息
 *   5. 未找到 → 返回 401
 *
 * JWT payload: { userId, openid }
 * JWT 有效期: process.env.JWT_EXPIRE 环境变量，默认 '7d'
 *
 * 注意: 此接口没有角色限定，任何通过密码验证的用户都能登录。
 *       但大部分管理功能还有 isAdmin 中间件的二次校验。
 *
 * 响应格式:
 *   成功: { success: true, data: { token, user: { id, nickname, realName, avatar, phone, role } } }
 *   失败: { success: false, message: "用户名或密码错误" }
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
        nickname: username,       // 用户名存储在 nickname 字段
        passwordHash: hashed,      // 密码比对 SHA-256 哈希值
      }
    })

    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    // 生成 JWT，payload 包含 userId 和 openid
    const token = jwt.sign(
      { userId: user.id, openid: user.openid },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )

    // 返回 token 和用户信息（排除敏感字段如 passwordHash）
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          realName: user.realName,
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
 * POST /api/auth/admin/register —— 管理员创建用户（后台添加账号密码用户）
 *
 * HTTP Method: POST
 * 鉴权中间件: authenticate, isAdmin
 * 权限要求: 必须是管理员
 *
 * 请求体（JSON）:
 *   - nickname (必填): 用户名（用作登录名）
 *   - password (必填): 明文密码，长度至少 6 位
 *   - role     (可选): 角色，'ADMIN' 或 'USER'，默认 'USER'
 *   - phone    (可选): 手机号
 *   - realName (可选): 真实姓名
 *
 * 创建逻辑:
 *   1. 校验 nickname 和 password 不为空
 *   2. 校验密码长度 >= 6
 *   3. 检查 nickname 是否已存在（避免重名）
 *   4. 生成 openid: 格式为 "manual_{timestamp}_{随机6位字符}"
 *      - "manual_" 前缀标识这是手动创建的用户，不是微信登录的
 *      - 时间戳 + 随机字符确保唯一性
 *   5. 哈希密码存储
 *   6. 插入数据库并返回用户信息（排除密码哈希）
 *
 * 安全考虑:
 *   - openid 使用 manual_ 前缀区分，避免与微信 openid 冲突
 *   - 返回数据中不包含 passwordHash
 *
 * 响应格式:
 *   { success: true, data: { id, nickname, realName, role, phone } }
 */
router.post('/admin/register', authenticate, isAdmin, async (req, res) => {
  try {
    const { nickname, password, role, phone, realName } = req.body

    if (!nickname || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' })
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '密码长度至少6位' })
    }

    // 检查昵称是否已存在（用作登录名）
    const exist = await prisma.user.findFirst({ where: { nickname } })
    if (exist) {
      return res.status(400).json({ success: false, message: '用户名已存在' })
    }

    const hashed = hashPassword(password)

    // 生成唯一 openid: "manual_" + 时间戳 + 6位随机字符
    const user = await prisma.user.create({
      data: {
        openid: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        nickname,
        realName: realName || null,
        passwordHash: hashed,
        role: role === 'ADMIN' ? 'ADMIN' : 'USER',
        phone: phone || null,
      }
    })

    // 返回不含敏感字段的用户信息
    res.json({
      success: true,
      data: {
        id: user.id,
        nickname: user.nickname,
        realName: user.realName,
        role: user.role,
        phone: user.phone,
      }
    })
  } catch (err) {
    console.error('[创建用户] 异常:', err.message)
    res.status(500).json({ success: false, message: '创建用户失败' })
  }
})

/**
 * POST /api/auth/password-login —— 用户名密码登录（小程序端使用）
 *
 * HTTP Method: POST
 * 权限要求: 无（公开接口）
 *
 * 请求体（JSON）:
 *   - nickname (必填): 用户名
 *   - password (必填): 明文密码
 *
 * 登录流程:
 *   1. 校验参数不为空
 *   2. 对密码做 SHA-256 哈希
 *   3. 在 user 表中按 nickname + passwordHash 查找匹配的用户
 *   4. 密码匹配 → 生成 JWT token 并返回用户信息
 *   5. 密码不匹配 → 返回 401（提示"用户名"而非"密码"防止用户枚举）
 *   6. 用户不存在 → 也返回 401 同样提示，不透露具体原因
 *
 * 响应格式:
 *   成功: { success: true, data: { token, user: { id, nickname, realName, avatar, phone, role } } }
 *   失败: { success: false, message: "用户名或密码错误" }
 */
router.post('/password-login', async (req, res) => {
  try {
    const { nickname, password } = req.body
    if (!nickname || !password) {
      return res.status(400).json({ success: false, message: '请输入用户名和密码' })
    }

    // 先用 nickname 找用户
    const user = await prisma.user.findFirst({
      where: { nickname }
    })

    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    // 检查密码哈希是否匹配
    if (!user.passwordHash) {
      return res.status(401).json({ success: false, message: '该账号未设置密码，请通过其他方式登录' })
    }

    const hashed = hashPassword(password)
    if (user.passwordHash !== hashed) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' })
    }

    // 生成 JWT
    const token = jwt.sign(
      { userId: user.id, openid: user.openid },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )

    console.log('[密码登录] 成功, userId:', user.id, 'nickname:', nickname)
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          realName: user.realName,
          avatar: user.avatar,
          phone: user.phone,
          role: user.role
        }
      }
    })
  } catch (err) {
    console.error('[密码登录] 异常:', err.message)
    res.status(500).json({ success: false, message: '登录失败' })
  }
})

/**
 * POST /api/auth/password-register —— 用户名密码注册（小程序端公开注册）
 *
 * HTTP Method: POST
 * 权限要求: 无（公开接口，与 /admin/register 不同，不需要管理员权限）
 *
 * 请求体（JSON）:
 *   - nickname (必填): 用户名（至少2个字符）
 *   - password (必填): 明文密码（至少6个字符）
 *
 * 注册逻辑:
 *   1. 校验 nickname 和 password 不为空
 *   2. 校验密码长度 >= 6，用户名长度 >= 2
 *   3. 检查 nickname 是否已被注册
 *   4. 生成唯一 openid: "manual_" + 时间戳 + 随机字符（与管理员创建用户一致）
 *   5. SHA-256 哈希密码
 *   6. 创建用户并返回 JWT token（注册即登录）
 *
 * 响应格式:
 *   成功: { success: true, data: { token, user: { id, nickname, realName, ... } } }
 *   失败: { success: false, message: "用户名已存在" | "密码长度至少6位" | ... }
 */
router.post('/password-register', async (req, res) => {
  try {
    const { nickname, password } = req.body

    if (!nickname || !password) {
      return res.status(400).json({ success: false, message: '请输入用户名和密码' })
    }
    if (nickname.length < 2) {
      return res.status(400).json({ success: false, message: '用户名至少2个字符' })
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '密码至少6位' })
    }

    // 检查昵称是否已被占用
    const exist = await prisma.user.findFirst({ where: { nickname } })
    if (exist) {
      return res.status(400).json({ success: false, message: '用户名已存在' })
    }

    const hashed = hashPassword(password)
    const user = await prisma.user.create({
      data: {
        openid: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        nickname,
        passwordHash: hashed,
        role: 'USER',
      }
    })

    // 注册成功即登录，直接返回 token
    const token = jwt.sign(
      { userId: user.id, openid: user.openid },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )

    console.log('[用户注册] 成功, userId:', user.id, 'nickname:', nickname)
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          realName: user.realName,
          avatar: user.avatar,
          phone: user.phone,
          role: user.role
        }
      }
    })
  } catch (err) {
    console.error('[用户注册] 异常:', err.message)
    res.status(500).json({ success: false, message: '注册失败' })
  }
})

/**
 * GET /api/auth/admin/users —— 管理员查看用户列表
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate, isAdmin
 * 权限要求: 必须是管理员
 *
 * 查询参数（Query）:
 *   - keyword  (可选): 按昵称或手机号模糊搜索
 *   - role     (可选): 按角色筛选 ('ADMIN' | 'USER')
 *   - page     (可选): 页码，默认 1
 *   - pageSize (可选): 每页条数，默认 20
 *
 * 关联数据: _count.orders - 每个用户的订单数量
 *
 * 安全考虑:
 *   - 使用 select 精确控制返回字段，排除 passwordHash 等敏感数据
 *   - 包含 openid 的排除也不在此接口返回
 *
 * 响应格式:
 *   { success: true, data: [User], pagination: { total, page, limit } }
 */
router.get('/admin/users', authenticate, isAdmin, async (req, res) => {
  try {
    const { keyword, role, page = 1, pageSize = 20 } = req.query
    const where = {}
    // 按昵称或手机号模糊搜索
    if (keyword) {
      where.OR = [
        { nickname: { contains: keyword } },
        { phone: { contains: keyword } },
      ]
    }
    // 按角色筛选
    if (role) where.role = role

    const total = await prisma.user.count({ where })
    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(pageSize),
      take: parseInt(pageSize),
      select: {
        id: true,
        nickname: true,
        realName: true,
        phone: true,
        role: true,
        createdAt: true,
        _count: { select: { orders: true } },  // 关联查询订单数
      }
    })

    res.json({
      success: true,
      data: users,
      pagination: { total, page: parseInt(page), limit: parseInt(pageSize) }
    })
  } catch (err) {
    console.error('[用户列表] 异常:', err.message)
    res.status(500).json({ success: false, message: '获取用户列表失败' })
  }
})

/**
 * PUT /api/auth/admin/users/:id —— 管理员修改用户信息
 *
 * HTTP Method: PUT
 * 路径参数: :id - 目标用户 ID
 * 鉴权中间件: authenticate, isAdmin
 * 权限要求: 必须是管理员
 *
 * 请求体（JSON，所有字段可选，只更新传入的字段）:
 *   - nickname (可选): 新用户名（会检查是否与其他用户冲突）
 *   - password (可选): 新密码（明文，长度至少6位）
 *   - role     (可选): 新角色
 *   - phone    (可选): 新手机号
 *   - realName (可选): 新真实姓名
 *
 * 安全检查:
 *   - 修改 nickname 时检查是否与其他用户冲突（排除自身）
 *   - 修改 password 时校验长度 >= 6
 *   - 只更新 body 中传入的字段（undefined 的字段不修改）
 *
 * 响应格式:
 *   { success: true, data: { id, nickname, realName, phone, role } }
 */
router.put('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { nickname, password, role, phone, realName } = req.body
    const userId = parseInt(req.params.id)

    const data = {}
    if (nickname !== undefined) {
      // 检查昵称是否与其他用户冲突（排除自身）
      const conflict = await prisma.user.findFirst({
        where: { nickname, NOT: { id: userId } }
      })
      if (conflict) {
        return res.status(400).json({ success: false, message: '用户名已存在' })
      }
      data.nickname = nickname
    }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: '密码长度至少6位' })
      }
      // 对新密码做哈希后再存储
      data.passwordHash = hashPassword(password)
    }
    if (role !== undefined) data.role = role
    if (phone !== undefined) data.phone = phone || null
    if (realName !== undefined) data.realName = realName || null

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      // 只返回非敏感字段
      select: { id: true, nickname: true, realName: true, phone: true, role: true }
    })

    res.json({ success: true, data: user })
  } catch (err) {
    console.error('[修改用户] 异常:', err.message)
    res.status(500).json({ success: false, message: '修改用户失败' })
  }
})

/**
 * POST /api/auth/phone-login —— 微信手机号一键登录（新版本推荐方式）
 *
 * HTTP Method: POST
 * 权限要求: 无（公开接口）
 *
 * 请求体（JSON）:
 *   - loginCode (必填): wx.login() 返回的临时 code，用于换取 openid
 *   - phoneCode (可选): 微信 getPhoneNumber 返回的动态令牌，用于换取手机号
 *   - nickname  (可选): 微信用户昵称
 *   - avatar    (可选): 微信用户头像 URL
 *
 * 完整登录流程（4 步）:
 *
 *   第1步 - 用 loginCode 换取 openid:
 *     调用微信 jscode2session API，获取用户的唯一标识 openid
 *     如果获取失败（如 code 过期），直接返回错误
 *
 *   第2步 - 尝试用 phoneCode 换取手机号（可选）:
 *     如果前端传了 phoneCode，调用 getPhoneByCode 获取真实手机号
 *     如果获取失败（如 code 过期或用户拒绝授权），降级为 openid 登录
 *     降级策略: 不阻断登录流程，只是没有手机号，后续可通过其他方式绑定
 *
 *   第3步 - 查找或创建用户（有手机号的情况）:
 *     先按手机号查找用户（同时查 phone 和 nickname 字段，兼容旧数据）
 *     找到 → 更新 openid（用户可能换了设备）、手机号、微信昵称、头像
 *     未找到 → 创建新用户：
 *       - nickname = phone（用手机号作登录用户名）
 *       - realName = 微信昵称
 *       - phone = 手机号
 *
 *   第3步备选 - 降级为 openid 登录（无手机号的情况）:
 *     按 openid 查找用户
 *     找到 → 直接登录
 *     未找到 → 创建新用户（nickname = "用户_{openid前8位}"）
 *
 *   第4步 - 生成 JWT token:
 *     JWT payload: { userId, openid }
 *     返回 token 和用户信息
 *
 * 数据兼容策略:
 *   - 同时查 phone 和 nickname 字段：旧数据中手机号可能存储在 nickname 中
 *     查找: OR [{ phone }, { nickname: phone }]
 *   - 新数据统一用 phone 字段存储手机号，nickname 用手机号也是用户名
 *
 * 降级策略说明:
 *   - 手机号换取失败时不阻断登录，用户仍可通过 openid 登录
 *   - 这样设计是因为：手机号获取需要用户主动授权，不能强制
 *   - 无手机号的用户后续可通过其他绑定流程补全手机号
 *
 * 响应格式:
 *   { success: true, data: { token, user: { id, nickname, realName, avatar, phone, role } } }
 */
router.post('/phone-login', async (req, res) => {
  try {
    const { loginCode, phoneCode, nickname, avatar } = req.body

    if (!loginCode) {
      return res.status(400).json({ success: false, message: '缺少 loginCode 参数' })
    }

    // 第1步：用 loginCode 换 openid
    console.log('[手机登录] jscode2session, code:', loginCode.substring(0, 10) + '...')
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: process.env.WECHAT_APPID,
        secret: process.env.WECHAT_SECRET,
        js_code: loginCode,
        grant_type: 'authorization_code'
      }
    })

    const { openid, errcode, errmsg } = wxRes.data
    if (errcode || !openid) {
      console.error('[手机登录] jscode2session 失败:', errcode, errmsg)
      return res.status(400).json({ success: false, message: `微信登录失败: ${errmsg || '未获取到 openid'}` })
    }

    // 第2步：尝试用 phoneCode 换取手机号（失败则降级）
    let phone = null
    if (phoneCode) {
      try {
        phone = await getPhoneByCode(phoneCode)
      } catch (e) {
        console.warn('[手机登录] 换取手机号失败，降级为 openid 登录:', e.message)
        // 降级：不阻断登录，继续使用 openid 方式
      }
    }

    // 第3步：查找或创建用户
    let user = null
    const displayName = nickname || '微信用户'

    if (phone) {
      // ===== 有手机号：以手机号为唯一标识查找/创建用户 =====
      // 兼容旧数据：手机号可能存在 nickname 字段中
      user = await prisma.user.findFirst({
        where: { OR: [{ phone }, { nickname: phone }] }
      })

      if (user) {
        // 已有用户：更新 openid（换设备登录时 openid 可能不同）和微信昵称/头像
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            openid,                          // 更新 openid（用户可能换了设备）
            phone: phone,                    // 确保 phone 字段有值
            realName: user.realName || displayName,  // 保留已有真实姓名，否则用微信昵称
            avatar: avatar || user.avatar,   // 保留已有头像，否则用微信头像
          }
        })
        console.log('[手机登录] 已有用户登录, userId:', user.id, '手机号:', phone)
      } else {
        // 新用户：手机号做用户名，微信昵称做中文名
        user = await prisma.user.create({
          data: {
            openid,
            nickname: phone,           // 用户名 = 手机号
            phone,
            realName: displayName,     // 真实姓名 = 微信昵称
            avatar: avatar || null,
            role: 'USER',
          }
        })
        console.log('[手机登录] 新用户自动注册, userId:', user.id, '手机号:', phone)
      }
    } else {
      // ===== 无手机号：降级为纯 openid 登录 =====
      user = await prisma.user.findUnique({ where: { openid } })
      if (!user) {
        user = await prisma.user.create({
          data: {
            openid,
            nickname: `用户_${openid.substring(0, 8)}`,  // 生成临时用户名
            realName: displayName,
            avatar: avatar || null,
          }
        })
        console.log('[手机登录] 无手机号-新用户注册, userId:', user.id)
      }
    }

    // 第4步：生成 JWT token
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
          realName: user.realName,
          avatar: user.avatar,
          phone: user.phone,
          role: user.role
        }
      }
    })
  } catch (err) {
    console.error('[手机登录] 异常:', err.message)
    res.status(500).json({ success: false, message: `登录失败: ${err.message}` })
  }
})

/**
 * POST /api/auth/login —— 微信小程序 code 登录（旧版本登录方式）
 *
 * HTTP Method: POST
 * 权限要求: 无
 *
 * 请求体（JSON）:
 *   - code (必填): wx.login() 返回的临时 code
 *
 * 登录流程:
 *   1. 校验参数
 *   2. 向微信 jscode2session 接口换取 openid
 *   3. 用 openid 查找或创建用户（首次登录自动注册）
 *   4. 生成 JWT token 返回
 *
 * 与 phone-login 的区别:
 *   - 不需要手机号，只用 openid 标识用户
 *   - 不需要调用 getWxAccessToken（不需要 access_token）
 *   - 不需要 phoneCode
 *
 * 适用场景:
 *   - 只需要 openid 即可登录的简单场景
 *   - 不需要收集手机号的场景
 *
 * 响应格式:
 *   { success: true, data: { token, user: { id, nickname, realName, avatar, phone, role } } }
 */
router.post('/login', async (req, res) => {
  try {
    const { code } = req.body
    if (!code) {
      return res.status(400).json({ success: false, message: '缺少 code 参数' })
    }

    // 环境变量检查
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

    // 解析微信返回结果
    const { openid, errcode, errmsg } = wxRes.data
    if (errcode) {
      console.error('[登录] 微信 API 错误:', errcode, errmsg)
      return res.status(400).json({ success: false, message: `微信登录失败: ${errmsg} (错误码: ${errcode})` })
    }

    if (!openid) {
      console.error('[登录] 未获取到 openid')
      return res.status(400).json({ success: false, message: '微信登录失败: 未获取到 openid' })
    }

    // 用 openid 查找或创建用户（首次登录自动注册）
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
          realName: user.realName,
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
 * PUT /api/auth/profile —— 更新当前登录用户的个人资料（需认证）
 *
 * HTTP Method: PUT
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 请求体（JSON，所有字段可选，只更新传入的字段）:
 *   - nickname (可选): 新昵称
 *   - avatar   (可选): 新头像 URL
 *   - phone    (可选): 新手机号
 *   - realName (可选): 新真实姓名
 *
 * 安全设计:
 *   - 用户只能更新自己的信息（where: { id: req.user.id }）
 *   - req.user.id 来自 JWT 解析结果，无法伪造
 *
 * 响应格式:
 *   { success: true, data: User }
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { nickname, avatar, phone, realName } = req.body
    const user = await prisma.user.update({
      where: { id: req.user.id },     // 只能修改自己的信息
      data: { nickname, avatar, phone, realName }
    })
    res.json({ success: true, data: user })
  } catch (err) {
    res.status(500).json({ success: false, message: '更新失败' })
  }
})

/**
 * GET /api/auth/me —— 获取当前登录用户信息（需认证）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 数据来源:
 *   - req.user 由 authenticate 中间件从 JWT 解析后注入
 *   - authenticate 中间件通过 prisma.user.findUnique 查询完整用户信息
 *
 * 用途:
 *   - 前端页面初始化时获取当前用户信息（昵称、头像、角色等）
 *   - 判断用户是否登录及角色权限
 *   - 更新个人资料后的状态同步
 *
 * 响应格式:
 *   { success: true, data: { id, nickname, realName, avatar, phone, role } }
 */
router.get('/me', authenticate, (req, res) => {
  const { id, nickname, realName, avatar, phone, role } = req.user
  res.json({ success: true, data: { id, nickname, realName, avatar, phone, role } })
})

module.exports = router
