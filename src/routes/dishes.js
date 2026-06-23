const express = require('express')
const router = express.Router()
const prisma = require('../lib/prisma')
const { authenticate, isAdmin } = require('../middlewares/auth')
const path = require('path')
const fs = require('fs')

const uploadDir = path.join(__dirname, '../../uploads')

/**
 * 根据 image URL 解析出本地文件名，重命名为 {dishName}{ext}
 * 返回新的 URL，失败时返回原 URL
 */
function renameImageFile(imageUrl, dishName) {
  if (!imageUrl || !dishName) return imageUrl
  try {
    // 从 URL 中提取文件名，例如 http://localhost:3000/uploads/xxx.jpg → xxx.jpg
    const urlPath = new URL(imageUrl).pathname
    const oldName = path.basename(urlPath)
    const oldPath = path.join(uploadDir, oldName)

    if (!fs.existsSync(oldPath)) return imageUrl

    const ext = path.extname(oldName)
    // 清理菜品名中的非法文件名字符（Windows 和 URL 不友好字符）
    const safeName = dishName.replace(/[\\/:*?"<>|]/g, '-').trim()
    const newName = safeName + ext
    const newPath = path.join(uploadDir, newName)

    // 如果目标文件已存在（同名菜品更新图片），先删旧的
    if (oldPath !== newPath) {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath)
      fs.renameSync(oldPath, newPath)
    }

    // 用原 URL 的 base 拼新文件名
    const baseUrl = imageUrl.substring(0, imageUrl.lastIndexOf('/') + 1)
    return baseUrl + encodeURIComponent(newName)
  } catch {
    return imageUrl
  }
}

/** GET /api/dishes —— 获取菜品列表（支持分类过滤、搜索、分页、推荐筛选） */
router.get('/', async (req, res) => {
  try {
    const { categoryId, keyword, page = 1, limit = 20, recommended } = req.query
    const where = { isActive: true }
    if (categoryId) where.categoryId = parseInt(categoryId)
    if (recommended === 'true') where.isRecommended = true
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { description: { contains: keyword } }
      ]
    }

    const total = await prisma.dish.count({ where })
    const dishes = await prisma.dish.findMany({
      where,
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ isRecommended: 'desc' }, { sales: 'desc' }, { createdAt: 'desc' }],
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    })

    res.json({
      success: true,
      data: dishes,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: '获取菜品失败' })
  }
})

/** POST /api/dishes/batch-delete —— 批量删除菜品（管理员） */
router.post('/batch-delete', authenticate, isAdmin, async (req, res) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: '请提供要删除的菜品ID列表' })
    }
    await prisma.dish.updateMany({
      where: { id: { in: ids.map(Number) } },
      data: { isActive: false }
    })
    res.json({ success: true, message: `成功批量删除 ${ids.length} 个菜品` })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: '批量删除菜品失败' })
  }
})

/** GET /api/dishes/:id —— 获取单个菜品 */
router.get('/:id', async (req, res) => {
  try {
    const dish = await prisma.dish.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { category: true }
    })
    if (!dish) return res.status(404).json({ success: false, message: '菜品不存在' })
    res.json({ success: true, data: dish })
  } catch (err) {
    res.status(500).json({ success: false, message: '获取菜品失败' })
  }
})

/** POST /api/dishes —— 创建菜品（管理员） */
router.post('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { name, description, price, image, categoryId, stock, isRecommended } = req.body
    if (!name || !price || !categoryId) {
      return res.status(400).json({ success: false, message: '名称、价格、分类不能为空' })
    }

    // 如果有图片，按菜品名称重命名
    const finalImage = renameImageFile(image, name)

    const dish = await prisma.dish.create({
      data: {
        name,
        description,
        price: parseFloat(price),
        image: finalImage,
        categoryId: parseInt(categoryId),
        stock: stock ? parseInt(stock) : 999,
        isRecommended: !!isRecommended
      },
      include: { category: true }
    })
    res.status(201).json({ success: true, data: dish })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: '创建菜品失败' })
  }
})

/** PUT /api/dishes/:id —— 更新菜品（管理员） */
router.put('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { name, description, price, image, categoryId, stock, isFeatured, isActive, isRecommended } = req.body
    const data = {}
    if (name !== undefined) data.name = name
    if (description !== undefined) data.description = description
    if (price !== undefined) data.price = parseFloat(price)
    if (image !== undefined) {
      // 如果更新了图片且更新了名称，用新名称重命名；否则用 old name 重命名
      const dish = await prisma.dish.findUnique({ where: { id: parseInt(req.params.id) } })
      const targetName = name || dish?.name || ''
      data.image = renameImageFile(image, targetName)
    } else {
      // 如果只改了名称没改图片，也重命名旧图片以匹配新名称
      if (name !== undefined) {
        const dish = await prisma.dish.findUnique({ where: { id: parseInt(req.params.id) } })
        if (dish?.image) {
          data.image = renameImageFile(dish.image, name)
        }
      }
    }
    if (categoryId !== undefined) data.categoryId = parseInt(categoryId)
    if (stock !== undefined) data.stock = parseInt(stock)
    if (isFeatured !== undefined) data.isFeatured = !!isFeatured
    if (isActive !== undefined) data.isActive = !!isActive
    if (isRecommended !== undefined) data.isRecommended = !!isRecommended

    const dish = await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { category: true }
    })
    res.json({ success: true, data: dish })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, message: '更新菜品失败' })
  }
})

/** PATCH /api/dishes/:id/available —— 切换上架状态（管理员） */
router.patch('/:id/available', authenticate, isAdmin, async (req, res) => {
  try {
    const { isActive } = req.body
    const dish = await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data: { isActive: !!isActive }
    })
    res.json({ success: true, data: dish })
  } catch (err) {
    res.status(500).json({ success: false, message: '更新状态失败' })
  }
})

/** DELETE /api/dishes/:id —— 删除菜品（管理员） */
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data: { isActive: false }
    })
    res.json({ success: true, message: '删除成功' })
  } catch (err) {
    res.status(500).json({ success: false, message: '删除菜品失败' })
  }
})

module.exports = router
