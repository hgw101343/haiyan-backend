const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { authenticate, isAdmin } = require("../middlewares/auth");

/** GET /api/categories —— 获取所有分类（含菜品数量，支持推荐筛选） */
router.get("/", async (req, res) => {
  try {
    const { recommended } = req.query;
    const where = { isActive: true };
    if (recommended === "true") where.isRecommended = true;

    const categories = await prisma.category.findMany({
      where,
      orderBy: { sort: "asc" },
      include: {
        _count: { select: { dishes: { where: { isActive: true } } } },
      },
    });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: "获取分类失败" });
  }
});

/** POST /api/categories —— 创建分类（管理员） */
router.post("/", authenticate, isAdmin, async (req, res) => {
  try {
    const { name, icon, sort, isRecommended } = req.body;
    if (!name)
      return res
        .status(400)
        .json({ success: false, message: "分类名称不能为空" });
    const category = await prisma.category.create({
      data: { name, icon, sort: sort || 0, isRecommended: !!isRecommended },
    });
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: "创建分类失败" });
  }
});

/** POST /api/categories/batch-delete —— 批量删除分类（管理员） */
router.post("/batch-delete", authenticate, isAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "请提供要删除的分类ID列表" });
    }
    // 检查每个分类下是否有菜品
    for (const id of ids) {
      const count = await prisma.dish.count({
        where: { categoryId: parseInt(id) },
      });
      if (count > 0) {
        const cat = await prisma.category.findUnique({
          where: { id: parseInt(id) },
        });
        return res.status(400).json({
          success: false,
          message: `分类"${cat?.name || id}"下有 ${count} 个菜品，无法删除`,
        });
      }
    }
    await prisma.category.deleteMany({
      where: { id: { in: ids.map(Number) } },
    });
    res.json({ success: true, message: `成功批量删除 ${ids.length} 个分类` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "批量删除分类失败" });
  }
});

/** PUT /api/categories/:id —— 更新分类（管理员） */
router.put("/:id", authenticate, isAdmin, async (req, res) => {
  try {
    const { name, icon, sort, isActive, isRecommended } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (icon !== undefined) data.icon = icon;
    if (sort !== undefined) data.sort = parseInt(sort);
    if (isActive !== undefined) data.isActive = !!isActive;
    if (isRecommended !== undefined) data.isRecommended = !!isRecommended;

    const category = await prisma.category.update({
      where: { id: parseInt(req.params.id) },
      data,
    });
    res.json({ success: true, data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: "更新分类失败" });
  }
});

/** DELETE /api/categories/:id —— 删除分类（管理员） */
router.delete("/:id", authenticate, isAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const count = await prisma.dish.count({ where: { categoryId: id } });
    console.log(count, "555");
    if (count > 0) {
      return res
        .status(400)
        .json({ success: false, message: "该分类下有菜品，无法删除" });
    }
    await prisma.category.delete({ where: { id } });
    res.json({ success: true, message: "删除成功" });
  } catch (err) {
    res.status(500).json({ success: false, message: "删除分类失败" });
  }
});

module.exports = router;
