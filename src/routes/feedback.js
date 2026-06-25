/**
 * ==================== 意见反馈路由 ====================
 *
 * 功能：
 * - 小程序端：用户提交反馈（文字 + 可选图片）
 * - Admin 后台：管理员查看全部反馈、标记已读
 *
 * 权限说明：
 * - POST /api/feedback     → 任何登录用户可提交
 * - GET  /api/feedback     → 管理员看全部，普通用户看自己的
 * - PUT  /api/feedback/:id → 管理员标记已读
 */

const express = require("express");
const router = express.Router();
const { authenticate, isAdmin } = require("../middlewares/auth");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * POST /api/feedback
 * 用户提交反馈
 *
 * 请求体：
 * - content: string  反馈文字内容（必填）
 * - images: string[] 图片 URL 数组（可选，默认空数组）
 *
 * 所有登录用户均可提交，提交后默认状态为 UNREAD
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const { content, images } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: "反馈内容不能为空" });
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId: req.user.id,
        content: content.trim(),
        images: JSON.stringify(Array.isArray(images) ? images : []),
      },
      include: { user: { select: { id: true, nickname: true, realName: true, avatar: true } } },
    });

    res.json({ success: true, data: feedback });
  } catch (err) {
    console.error("[feedback] create error:", err);
    res.status(500).json({ success: false, message: "提交失败" });
  }
});

/**
 * GET /api/feedback
 * 获取反馈列表
 *
 * 权限：
 * - 管理员：查看所有反馈（含提交人信息）
 * - 普通用户：只查看自己提交的反馈
 *
 * 排序：按创建时间倒序（最新在前）
 */
router.get("/", authenticate, async (req, res) => {
  try {
    const where = req.user.role === "ADMIN" ? {} : { userId: req.user.id };

    const feedbacks = await prisma.feedback.findMany({
      where,
      include: { user: { select: { id: true, nickname: true, realName: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
    });

    // 将 images 从 JSON 字符串解析为数组
    const result = feedbacks.map((f) => ({
      ...f,
      images: JSON.parse(f.images || "[]"),
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[feedback] list error:", err);
    res.status(500).json({ success: false, message: "获取失败" });
  }
});

/**
 * PUT /api/feedback/:id
 * 管理员标记反馈为已读
 *
 * 将状态从 UNREAD 改为 READ，仅管理员可操作
 */
router.put("/:id", authenticate, isAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const feedback = await prisma.feedback.update({
      where: { id },
      data: { status: "READ" },
    });

    res.json({ success: true, data: feedback });
  } catch (err) {
    console.error("[feedback] update error:", err);
    res.status(500).json({ success: false, message: "更新失败" });
  }
});

module.exports = router;
