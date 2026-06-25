/**
 * routes/admin.js —— 管理员后台路由
 *
 * 提供订单管理、销售统计、用户管理等管理员功能。
 * 所有路由都需要登录认证（authenticate 中间件），其中大部分还需要
 * 管理员权限验证（isAdmin 中间件）。
 *
 * 数据隔离策略：
 *   - GET /orders 允许普通用户访问但限定只能看自己的订单
 *   - 其余路由均为管理员专用（isAdmin）
 *
 * 中间件说明：
 *   - authenticate: 解析 JWT，将用户信息注入 req.user
 *   - isAdmin: 检查 req.user.role === 'ADMIN'，非管理员返回 403
 */

const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')

/**
 * GET /api/admin/orders —— 获取订单列表（需认证）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 查询参数（Query）:
 *   - status    (可选): 订单状态筛选 (PENDING/PAID/PREPARING/READY/COMPLETED/CANCELLED)
 *   - page      (可选): 页码，默认 1
 *   - limit     (可选): 每页条数，默认 20
 *   - date      (可选): 按日期筛选（YYYY-MM-DD 格式），查询当天 00:00 ~ 次日 00:00
 *   - keyword   (可选): 按订单号模糊搜索
 *   - userId    (可选): 按用户 ID 筛选（仅管理员可用）
 *
 * 数据隔离逻辑：
 *   - 非管理员 (req.user.role !== 'ADMIN'): 强制 where.userId = req.user.id，只能看到自己的订单
 *   - 管理员: 可以传 userId 参数过滤特定用户的订单，不传则查全部
 *
 * 包含关联数据:
 *   - user: { id, nickname, realName, phone }  订单所属用户信息
 *   - items → dish: { name, price, image }      订单项对应的菜品基础信息
 *
 * 响应格式:
 *   { success: true, data: [Order], pagination: { total, page, limit } }
 */
router.get('/orders', authenticate, async (req, res) => {
  try {
    const { status, page = 1, limit = 20, date, keyword, userId } = req.query
    const where = {}

    // 数据隔离：非管理员只能看自己的订单
    if (req.user.role !== 'ADMIN') {
      where.userId = req.user.id
    } else if (userId) {
      // 管理员可选择按 userId 过滤
      where.userId = parseInt(userId)
    }

    // 按订单状态筛选
    if (status) where.status = status
    // 按日期筛选：将日期字符串转为当天 00:00:00 到次日 00:00:00 的时间范围
    if (date) {
      const start = new Date(date)
      const end = new Date(date)
      end.setDate(end.getDate() + 1)
      where.createdAt = { gte: start, lt: end }
    }
    // 按订单号模糊搜索
    if (keyword) {
      where.orderNo = { contains: keyword }
    }

    // 先查总数用于分页
    const total = await prisma.order.count({ where })
    // 查订单列表，关联用户信息和订单项-菜品信息
    const orders = await prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, nickname: true, realName: true, phone: true } },
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

/**
 * GET /api/admin/recent-orders —— 获取最近 N 笔订单（管理员专用，仪表盘数据）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate, isAdmin
 * 权限要求: 必须是管理员
 *
 * 查询参数（Query）:
 *   - limit (可选): 返回的订单数量，默认 10
 *
 * 用途: 为管理员仪表盘提供"最近订单"卡片数据，展示最新的订单动态。
 * 与 GET /orders 不同，此接口不做分页，不做筛选，只按时间倒序取最近 N 条。
 *
 * 包含关联数据:
 *   - user: { id, nickname, openid }   下单用户信息
 *   - items → dish: { name }           订单中包含的菜品名称
 *
 * 响应格式:
 *   { success: true, data: [Order] }
 */
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

/**
 * GET /api/admin/sales-chart —— 获取近 N 天销售趋势数据（管理员专用，图表数据）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate, isAdmin
 *
 * 查询参数（Query）:
 *   - days (可选): 统计最近多少天的数据，默认 7 天
 *
 * 数据处理逻辑（按天聚合循环）:
 *   for (i = days-1; i >= 0; i--)  从最远一天到今天的顺序（保证返回数组按日期升序排列）
 *     1. 计算当天的起始时间 start = N天前 00:00:00
 *     2. 计算当天的结束时间 end = start + 1天
 *     3. 对当天时间范围内的订单做聚合查询（aggregate）:
 *        - _sum.totalAmount: 当天有效订单的总金额（营收）
 *        - _count.id: 当天有效订单总数
 *
 * 营收计算规则 (状态过滤):
 *   - status IN ('PAID', 'PREPARING', 'READY', 'COMPLETED')
 *   - 排除 CANCELLED（已取消）和 PENDING（待支付）的订单，只统计已产生实际营收的订单
 *   - 这样设计是因为：未支付的订单可能最终被取消，不应计入营收
 *
 * 每个聚合查询单独查询数据库（循环 days 次），适合数据量不大的情况。
 * 若需性能优化可改为一条 SQL 按天 GROUP BY。
 *
 * 响应格式:
 *   { success: true, data: [{ date: "2024-01-01", revenue: 1234, orders: 5 }, ...] }
 */
router.get('/sales-chart', authenticate, isAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const result = []
    // 从最远一天到今天的顺序遍历，保证结果按日期升序
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date()
      start.setDate(start.getDate() - i)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)

      // 聚合查询：统计当天已产生营收的订单
      const agg = await prisma.order.aggregate({
        where: {
          createdAt: { gte: start, lt: end },
          // 只统计有效状态（排除已取消和待支付）
          status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] }
        },
        _sum: { totalAmount: true },  // 当天营收总额
        _count: { id: true }          // 当天订单数
      })
      result.push({
        date: start.toISOString().slice(0, 10),  // 返回 YYYY-MM-DD 格式
        revenue: agg._sum.totalAmount || 0,
        orders: agg._count.id
      })
    }
    res.json({ success: true, data: result })
  } catch {
    res.status(500).json({ success: false, message: '获取销售图表失败' })
  }
})

/**
 * GET /api/admin/stats —— 获取仪表盘统计数据（管理员专用）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate, isAdmin
 *
 * 使用 Promise.all 批量并行执行 8 个数据库查询，一次请求获取全部统计指标。
 * 这样设计避免了 8 次串行请求的网络延迟累加。
 *
 * 时间边界计算：
 *   - today:    当前日期 00:00:00，用于"今日"相关指标的筛选起点
 *   - monthStart: 本月 1 号 00:00:00，用于"本月"相关指标的筛选起点
 *
 * 各指标含义：
 *   1. totalOrders   - 总订单数（排除已取消的 CANCELLED 订单）
 *   2. todayOrders   - 今日订单数（今日 00:00 起创建，排除 CANCELLED）
 *   3. totalRevenue  - 总营收（排除 CANCELLED 和 PENDING，仅统计实际产生收入的订单）
 *   4. todayRevenue  - 今日营收（同上筛选 + 今日时间范围）
 *   5. monthOrders   - 本月订单数（本月 1 号起创建，排除 CANCELLED）
 *   6. monthRevenue  - 本月营收（同上筛选 + 有效状态订单金额合计）
 *   7. totalDishes   - 在售菜品数（isActive: true）
 *   8. totalUsers    - 注册用户总数
 *
 * 营收计算的状态过滤逻辑：
 *   - 统计订单数时：排除 CANCELLED（使用 status: { not: 'CANCELLED' }）
 *   - 统计营收时：只统计 PAID / PREPARING / READY / COMPLETED 这四种状态
 *     （排除 CANCELLED 和 PENDING，因为 PENDING 还未支付不应记入营收）
 *
 * 响应格式:
 *   { success: true, data: { totalOrders, todayOrders, totalRevenue, todayRevenue,
 *       monthOrders, monthRevenue, totalDishes, totalUsers } }
 */
router.get('/stats', authenticate, isAdmin, async (req, res) => {
  try {
    // 计算"今日"的时间起点（今天 00:00:00）
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // 计算"本月"的时间起点（本月 1 号 00:00:00）
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    // Promise.all 并行执行全部 8 个统计查询，减少总耗时
    const [totalOrders, todayOrders, totalRevenue, todayRevenue, monthOrders, monthRevenue, totalDishes, totalUsers] = await Promise.all([
      // 1. 总订单数（全部时间，排除已取消）
      prisma.order.count({ where: { status: { not: 'CANCELLED' } } }),
      // 2. 今日订单数
      prisma.order.count({ where: { createdAt: { gte: today }, status: { not: 'CANCELLED' } } }),
      // 3. 总营收（全部时间，只统计有效状态）
      prisma.order.aggregate({
        where: { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      // 4. 今日营收
      prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      // 5. 本月订单数
      prisma.order.count({ where: { createdAt: { gte: monthStart }, status: { not: 'CANCELLED' } } }),
      // 6. 本月营收
      prisma.order.aggregate({
        where: { createdAt: { gte: monthStart }, status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
        _sum: { totalAmount: true }
      }),
      // 7. 在售菜品数
      prisma.dish.count({ where: { isActive: true } }),
      // 8. 注册用户总数
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

/**
 * GET /api/admin/users —— 获取用户列表（管理员专用，用户管理功能）
 *
 * HTTP Method: GET
 * 鉴权中间件: authenticate, isAdmin
 *
 * 查询参数（Query）:
 *   - page     (可选): 页码，默认 1
 *   - limit    或 pageSize (可选): 每页条数，默认 20（兼容两种参数名）
 *   - keyword  (可选): 按昵称或手机号模糊搜索匹配的用户
 *
 * 返回字段说明:
 *   - id, nickname, phone, avatar, role, createdAt  用户基本信息
 *   - _count.orders  该用户的订单数量（关联查询，便于管理后台展示）
 *
 * 注意: 返回数据中排除 openid 和 passwordHash 等敏感字段，使用 select 精确控制字段。
 *
 * 响应格式:
 *   { success: true, data: [User], pagination: { total } }
 */
router.get('/users', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, pageSize, keyword } = req.query
    const take = parseInt(pageSize || limit)  // 兼容 pageSize 和 limit 两种参数名
    // 按昵称或手机号模糊搜索
    const where = keyword
      ? { OR: [{ nickname: { contains: keyword } }, { phone: { contains: keyword } }] }
      : {}
    const total = await prisma.user.count({ where })
    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, nickname: true, phone: true, avatar: true, role: true, createdAt: true,
        _count: { select: { orders: true } }  // 关联查询每个用户的订单数
      },
      skip: (parseInt(page) - 1) * take,
      take,
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, data: users, pagination: { total } })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取用户失败' })
  }
})

/**
 * PUT /api/admin/users/:id/role —— 设置用户角色（管理员专用）
 *
 * HTTP Method: PUT
 * 路径参数: :id - 目标用户 ID
 * 鉴权中间件: authenticate, isAdmin
 *
 * 请求体（JSON）:
 *   - role (必填): 角色值，允许 'USER' 或 'ADMIN'
 *
 * 安全校验:
 *   - 只允许设置为 'USER' 或 'ADMIN' 两种角色，其他值返回 400
 *   - 只有管理员可以执行此操作（isAdmin 中间件保证）
 *
 * 业务场景:
 *   - 将普通用户提升为管理员（role: 'ADMIN'）
 *   - 将管理员降级为普通用户（role: 'USER'）
 *
 * 注意: 此接口直接更新 role 字段，不做降级后的权限清理。
 *       如果管理员只有 1 个，降级后系统将无管理员，需自行保证有至少 1 个管理员。
 */
router.put('/users/:id/role', authenticate, isAdmin, async (req, res) => {
  try {
    const { role } = req.body
    // 角色白名单验证：只允许 USER 和 ADMIN
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
