const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')

/** GET /api/admin/orders —— 获取所有订单（管理员） */
router.get('/orders', authenticate, isAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20, date } = req.query
    const where = {}
    if (status) where.status = status
    if (date) {
      const start = new Date(date)
      const end = new Date(date)
      end.setDate(end.getDate() + 1)
      where.createdAt = { gte: start, lt: end }
    }

    const total = await prisma.order.count({ where })
    const orders = await prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, nickname: true, phone: true } },
        items: {
          include: { dish: { select: { name: true, price: true, image: true } } }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    })
    res.json({ success: true, data: orders, pagination: { total, page: parseInt(page), limit: parseInt(limit) } })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取订单失败' })
  }
})

/** GET /api/admin/recent-orders —— 最近N笔订单 */
router.get('/recent-orders', authenticate, isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const orders = await prisma.order.findMany({
      include: {
        user: { select: { id: true, nickname: true, openid: true } },
        items: { include: { dish: { select: { name: true } } } }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    })
    res.json({ success: true, data: orders })
  } catch {
    res.status(500).json({ success: false, message: '获取最近订单失败' })
  }
})

/** GET /api/admin/sales-chart —— 近N天销售数据 */
router.get('/sales-chart', authenticate, isAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const result = []
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date()
      start.setDate(start.getDate() - i)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      const agg = await prisma.order.aggregate({
        where: { createdAt: { gte: start, lt: end }, status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true },
        _count: { id: true }
      })
      result.push({
        date: start.toISOString().slice(0, 10),
        revenue: agg._sum.totalAmount || 0,
        orders: agg._count.id
      })
    }
    res.json({ success: true, data: result })
  } catch {
    res.status(500).json({ success: false, message: '获取销售图表失败' })
  }
})

/** GET /api/admin/stats —— 数据统计 */
router.get('/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const [totalOrders, todayOrders, totalRevenue, todayRevenue, monthOrders, monthRevenue, totalDishes, totalUsers] = await Promise.all([
      prisma.order.count({ where: { status: { not: 'CANCELLED' } } }),
      prisma.order.count({ where: { createdAt: { gte: today }, status: { not: 'CANCELLED' } } }),
      prisma.order.aggregate({
        where: { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      prisma.order.count({ where: { createdAt: { gte: monthStart }, status: { not: 'CANCELLED' } } }),
      prisma.order.aggregate({
        where: { createdAt: { gte: monthStart }, status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      prisma.dish.count({ where: { isActive: true } }),
      prisma.user.count()
    ])

    res.json({
      success: true,
      data: {
        totalOrders,
        todayOrders,
        totalRevenue: totalRevenue._sum.totalAmount || 0,
        todayRevenue: todayRevenue._sum.totalAmount || 0,
        monthOrders,
        monthRevenue: monthRevenue._sum.totalAmount || 0,
        totalDishes,
        totalUsers
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取统计失败' })
  }
})

/** GET /api/admin/users —— 获取用户列表 */
router.get('/users', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, pageSize, keyword } = req.query
    const take = parseInt(pageSize || limit)
    const where = keyword
      ? { OR: [{ nickname: { contains: keyword } }, { phone: { contains: keyword } }] }
      : {}
    const total = await prisma.user.count({ where })
    const users = await prisma.user.findMany({
      where,
      select: { id: true, nickname: true, phone: true, avatar: true, role: true, createdAt: true,
        _count: { select: { orders: true } } },
      skip: (parseInt(page) - 1) * take,
      take,
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, data: users, pagination: { total } })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取用户失败' })
  }
})

/** PUT /api/admin/users/:id/role —— 设置用户角色 */
router.put('/users/:id/role', authenticate, isAdmin, async (req, res) => {
  try {
    const { role } = req.body
    if (!['USER', 'ADMIN'].includes(role)) {
      return res.status(400).json({ success: false, message: '无效角色' })
    }
    const user = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data: { role }
    })
    res.json({ success: true, data: user })
  } catch (err) {
    res.status(500).json({ success: false, message: '更新角色失败' })
  }
})

module.exports = router
