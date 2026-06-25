/**
 * ==================== 菜品收藏路由 ====================
 *
 * 功能：
 * - 添加/取消收藏
 * - 获取当前用户的收藏列表（含菜品详情）方便在收藏页面展示
 *
 * 权限：所有登录用户均可操作自己的收藏
 */

const express = require("express");
const router = express.Router();
const { authenticate } = require("../middlewares/auth");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * POST /api/favorites
 * 添加收藏
 *
 * 请求体：
 * - dishId: number  要收藏的菜品 ID
 *
 * 同一用户对同一菜品只能收藏一次（数据库层 @@unique 约束 + upsert 兜底）
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const { dishId } = req.body;
    if (!dishId) {
      return res.status(400).json({ success: false, message: "缺少菜品 ID" });
    }

    // 使用 upsert 防止重复插入（数据库已有 unique 约束，upsert 更安全）
    await prisma.favorite.upsert({
      where: { userId_dishId: { userId: req.user.id, dishId } },
      create: { userId: req.user.id, dishId },
      update: {}, // 已存在则不更新
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[favorites] add error:", err);
    res.status(500).json({ success: false, message: "收藏失败" });
  }
});

/**
 * DELETE /api/favorites/:dishId
 * 取消收藏
 *
 * 通过菜品 ID 删除当前用户的收藏记录。
 * 即使用户未收藏该菜品，也不报错（静默成功）。
 */
router.delete("/:dishId", authenticate, async (req, res) => {
  try {
    const dishId = parseInt(req.params.dishId);

    await prisma.favorite.deleteMany({
      where: { userId: req.user.id, dishId },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[favorites] delete error:", err);
    res.status(500).json({ success: false, message: "取消收藏失败" });
  }
});

/**
 * GET /api/favorites
 * 获取当前用户的收藏列表
 *
 * 返回：
 * - favorites 数组，每个元素包含完整菜品信息和收藏时间
 * - 按收藏时间倒序排列
 *
 * 小程序收藏页面通过此接口获取数据并展示菜品列表。
 */
router.get("/", authenticate, async (req, res) => {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user.id },
      include: {
        dish: {
          include: { category: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: favorites });
  } catch (err) {
    console.error("[favorites] list error:", err);
    res.status(500).json({ success: false, message: "获取收藏列表失败" });
  }
});

module.exports = router;
