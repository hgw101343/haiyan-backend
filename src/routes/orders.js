const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')
const { v4: uuidv4 } = require('uuid')

/** POST /api/orders —— 创建订单 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { items, remark, tableNo } = req.body
    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: '订单不能为空' })
    }

    // 查询菜品价格并验证库存
    let totalAmount = 0
    const orderItems = []
    for (const item of items) {
      const dish = await prisma.dish.findUnique({ where: { id: item.dishId } })
      if (!dish || !dish.isActive) {
        return res.status(400).json({ success: false, message: `菜品 ${item.dishId} 不存在或已下架` })
      }
      if (dish.stock < item.quantity) {
        return res.status(400).json({ success: false, message: `${dish.name} 库存不足` })
      }
      totalAmount += parseFloat(dish.price) * item.quantity
      orderItems.push({
        dishId: dish.id,
        quantity: item.quantity,
        price: dish.price,
        remark: item.remark || null
      })
    }

    // 生成订单号
    const orderNo = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`

    // 创建订单（事务）
    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          orderNo,
          userId: req.user.id,
          totalAmount,
          remark,
          tableNo,
          items: { create: orderItems }
        },
        include: {
          items: { include: { dish: { select: { name: true, image: true } } } }
        }
      })

      // 减库存、增销量
      for (const item of items) {
        await tx.dish.update({
          where: { id: item.dishId },
          data: { stock: { decrement: item.quantity }, sales: { increment: item.quantity } }
        })
      }

      return newOrder
    })

    res.status(201).json({ success: true, data: order })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: '创建订单失败' })
  }
})

/** GET /api/orders —— 获取当前用户订单列表 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query
    const where = { userId: req.user.id }
    if (status) where.status = status

    const total = await prisma.order.count({ where })
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: { dish: { select: { name: true, image: true, price: true } } }
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

/** GET /api/orders/:id —— 获取订单详情 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: parseInt(req.params.id), userId: req.user.id },
      include: {
        items: {
          include: { dish: { select: { name: true, image: true, description: true } } }
        }
      }
    })
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' })
    res.json({ success: true, data: order })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取订单失败' })
  }
})

/** PUT /api/orders/:id/cancel —— 取消订单 */
router.put('/:id/cancel', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: parseInt(req.params.id), userId: req.user.id }
    })
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' })
    if (!['PENDING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: '该状态订单无法取消' })
    }
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' }
    })
    res.json({ success: true, message: '取消成功' })
  } catch (err) {
    res.status(500).json({ success: false, message: '取消订单失败' })
  }
})

/** PUT /api/orders/:id/status —— 更新订单状态（管理员） */
router.put('/:id/status', authenticate, isAdmin, async (req, res) => {
  try {
    const { status } = req.body
    const validStatuses = ['PENDING', 'PAID', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的订单状态' })
    }
    const order = await prisma.order.update({
      where: { id: parseInt(req.params.id) },
      data: { status }
    })

    // WebSocket 推送通知给用户
    const notify = req.app.get('notifyUser')
    if (notify) {
      notify(order.userId, {
        type: 'ORDER_STATUS_CHANGED',
        orderId: order.id,
        orderNo: order.orderNo,
        status: order.status
      })
    }

    res.json({ success: true, data: order })
  } catch (err) {
    res.status(500).json({ success: false, message: '更新状态失败' })
  }
})

module.exports = router
