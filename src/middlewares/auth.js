const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')

// JWT 验证中间件
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }
    const token = authHeader.substring(7)
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' })
    }
    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '令牌无效或已过期' })
  }
}

// 管理员权限中间件
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: '无权限访问' })
  }
  next()
}

module.exports = { authenticate, isAdmin }
