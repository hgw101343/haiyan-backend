const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')

/**
 * JWT 身份认证中间件（authenticate）
 *
 * 从请求头的 Authorization 字段中提取 Bearer Token，验证其有效性后查询对应用户，
 * 并将用户信息挂载到 req.user 供后续中间件/路由使用。
 *
 * 执行流程：
 * 1. 从 req.headers.authorization 读取鉴权头
 * 2. 校验格式必须为 "Bearer <token>"，否则返回 401（未提供认证令牌）
 * 3. 截取 "Bearer " 之后的 token 部分（substring(7)，跳过 "Bearer " 7 个字符）
 * 4. 使用 JWT_SECRET 环境变量对 token 进行验签和解析，得到 { userId, ... }
 * 5. 通过 Prisma 在数据库中查询该 userId 对应的用户记录
 * 6. 若用户不存在（可能已被删除），返回 401（用户不存在）
 * 7. 验证通过后，将完整 user 对象挂载到 req.user，调用 next() 放行
 * 8. 任何一步异常（token 过期/签名无效/数据库错误）统一返回 401（令牌无效或已过期）
 */
const authenticate = async (req, res, next) => {
  try {
    // 步骤1：获取 Authorization 请求头
    const authHeader = req.headers.authorization
    // 步骤2：检查请求头是否存在且以 "Bearer " 开头
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }
    // 步骤3：提取 token（去掉前缀 "Bearer "，共7个字符）
    const token = authHeader.substring(7)
    // 步骤4：使用 JWT_SECRET 验证 token 签名并解码 payload
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    // 步骤5：从数据库中查找与 token 中 userId 匹配的用户
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    // 步骤6：用户不存在则拒绝访问
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' })
    }
    // 步骤7：将用户信息挂载到 req 对象上，供后续路由处理器使用
    req.user = user
    next()
  } catch (err) {
    // 步骤8：捕获 JWT 验证异常（过期/签名不匹配）或数据库错误
    return res.status(401).json({ success: false, message: '令牌无效或已过期' })
  }
}

/**
 * 管理员权限中间件（isAdmin）
 *
 * 必须在 authenticate 中间件之后使用（依赖 req.user 已挂载）。
 * 检查当前登录用户的 role 字段是否为 "ADMIN"，
 * 非管理员用户直接返回 403 Forbidden，阻止访问管理员专属接口。
 *
 * 使用方式：router.post('/admin/some-api', authenticate, isAdmin, handler)
 */
const isAdmin = (req, res, next) => {
  // 验证用户角色是否为管理员，否则返回 403 无权访问
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: '无权限访问' })
  }
  next()
}

module.exports = { authenticate, isAdmin }
