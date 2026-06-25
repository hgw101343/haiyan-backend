/**
 * routes/categories.js —— 菜品分类管理路由
 *
 * 提供分类的 CRUD（增删改查）和批量删除功能。
 *
 * 权限控制（数据隔离）:
 *   - GET / 公开，但支持 createdBy 过滤
 *   - POST / (创建) 要求登录，自动设置 createdBy
 *   - PUT/DELETE (修改/删除) 要求登录，仅创建者本人或管理员可操作
 *   - POST /batch-delete 要求登录，非管理员只能删自己创建的
 *
 * 删除策略:
 *   - 单个删除 (DELETE /:id): 使用物理删除（prisma.category.delete），但有前置检查
 *   - 批量删除 (POST /batch-delete): 同样物理删除，但逐条检查权限和菜品关联
 *   - 删除前检查: 如果分类下有菜品，拒绝删除（防止产生孤儿菜品数据）
 *
 * 与菜品表的关系:
 *   - Category ← Dish (一对多): 每个分类可以有多个菜品
 *   - 查询时通过 _count.dishes 子查询统计每个分类下的菜品数量
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { authenticate, isAdmin } = require("../middlewares/auth");

/**
 * GET /api/categories —— 获取所有分类列表（公开接口）
 *
 * HTTP Method: GET
 * 权限要求: 无（公开）
 *
 * 查询参数（Query）:
 *   - recommended (可选): 是否只返回推荐分类（"true"）
 *   - createdBy   (可选): 按创建人 ID 过滤，用于管理员查看指定用户创建的分类
 *
 * 包含关联数据:
 *   - _count.dishes: 每个分类下的在售菜品数量（isActive: true 的菜品）
 *     使用 Prisma 的嵌套过滤: { dishes: { where: { isActive: true } } }
 *     只统计在售菜品，不统计已下架/软删除的菜品
 *
 * 排序: 按 sort 字段升序排列（sort 值小的分类排在前面）
 *
 * 默认过滤: 只返回 isActive: true 的分类
 *
 * 响应格式:
 *   { success: true, data: [Category] }  每个 Category 包含 _count.dishes 字段
 */
router.get("/", async (req, res) => {
  try {
    const { recommended, createdBy } = req.query;
    // 默认只查活跃分类
    const where = { isActive: true };
    // 按推荐状态筛选
    if (recommended === "true") where.isRecommended = true;
    // 按创建人筛选（数据隔离）
    if (createdBy) where.createdBy = parseInt(createdBy);

    const categories = await prisma.category.findMany({
      where,
      orderBy: { sort: "asc" },
      include: {
        // 子查询：统计每个分类下在售菜品的数量
        _count: { select: { dishes: { where: { isActive: true } } } },
      },
    });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: "获取分类失败" });
  }
});

/**
 * POST /api/categories —— 创建新分类（需认证）
 *
 * HTTP Method: POST
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 请求体（JSON）:
 *   - name         (必填): 分类名称
 *   - icon         (可选): 分类图标（emoji 或图片 URL）
 *   - sort         (可选): 排序值，默认 0，值越小越靠前
 *   - isRecommended (可选): 是否推荐，默认 false
 *
 * 创建逻辑:
 *   1. 校验 name 不为空
 *   2. 设置 createdBy = req.user.id（关联创建者）
 *   3. sort 默认 0，用于 GET 接口的排序
 *   4. isRecommended 默认 false
 *
 * 响应格式:
 *   HTTP 201 { success: true, data: Category }
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const { name, icon, sort, isRecommended } = req.body;
    if (!name)
      return res
        .status(400)
        .json({ success: false, message: "分类名称不能为空" });
    const category = await prisma.category.create({
      data: {
        name,
        icon,
        sort: sort || 0,                    // 排序值默认 0
        isRecommended: !!isRecommended,      // 双重取反确保布尔值
        createdBy: req.user.id,              // 记录创建者，用于后续权限判断
      },
    });
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: "创建分类失败" });
  }
});

/**
 * POST /api/categories/batch-delete —— 批量删除分类（需认证，物理删除）
 *
 * HTTP Method: POST
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 请求体（JSON）:
 *   - ids (必填): 要删除的分类 ID 数组，如 [1, 2, 3]
 *
 * 删除前检查（逐条检查，任一不满足立即拒绝）:
 *
 *   检查1 - 权限检查:
 *     - 管理员: 可以删除任意分类
 *     - 普通用户: 只能删除自己创建的 (cat.createdBy === req.user.id)
 *     - 不满足返回 403
 *
 *   检查2 - 菜品关联检查:
 *     - 查询分类下的菜品数量 (count)
 *     - 如果有菜品 (count > 0)，拒绝删除，返回 400 并提示哪个分类下有菜品
 *     - 原因: 物理删除分类后，关联的菜品将失去所属分类，产生数据异常
 *     - 用户提示包含分类名称和菜品数量，方便前端展示具体原因
 *
 * 删除方式: 物理删除（prisma.category.deleteMany），与菜品的软删除不同
 *   - 分类删除是物理删除，因为分类数据量小且通常不关联历史数据
 *   - 菜品用软删除，因为历史订单需要保留菜品关联关系
 *
 * 响应格式:
 *   成功: { success: true, message: "成功批量删除 N 个分类" }
 *   失败: { success: false, message: "分类"xxx"下有 N 个菜品，无法删除" }
 */
router.post("/batch-delete", authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "请提供要删除的分类ID列表" });
    }

    // 逐条检查每个分类的权限和菜品关联
    for (const id of ids) {
      // 查找分类信息
      const cat = await prisma.category.findUnique({ where: { id: parseInt(id) } });

      // 检查1：权限验证
      if (req.user.role !== 'ADMIN' && cat?.createdBy !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: `无权删除分类"${cat?.name || id}"`
        });
      }

      // 检查2：是否有关联菜品
      const count = await prisma.dish.count({
        where: { categoryId: parseInt(id) },
      });
      if (count > 0) {
        return res.status(400).json({
          success: false,
          message: `分类"${cat?.name || id}"下有 ${count} 个菜品，无法删除`,
        });
      }
    }

    // 所有检查通过，执行批量物理删除
    await prisma.category.deleteMany({
      where: { id: { in: ids.map(Number) } },
    });
    res.json({ success: true, message: `成功批量删除 ${ids.length} 个分类` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "批量删除分类失败" });
  }
});

/**
 * PUT /api/categories/:id —— 更新分类信息（需认证，仅创建者本人或管理员）
 *
 * HTTP Method: PUT
 * 路径参数: :id - 分类 ID
 * 鉴权中间件: authenticate
 *
 * 权限逻辑:
 *   1. 查找分类，不存在返回 404
 *   2. 检查权限：管理员 (role === 'ADMIN') 或创建者 (cat.createdBy === req.user.id)
 *   3. 不满足返回 403
 *
 * 可更新字段:
 *   - name:         分类名称
 *   - icon:         分类图标
 *   - sort:         排序值
 *   - isActive:     是否启用
 *   - isRecommended: 是否推荐
 *
 * 更新策略: 只更新请求中提供的字段（undefined 的字段不修改）
 *
 * 数据隔离: 通过 createdBy 字段判断用户是否有权限修改此分类
 *
 * 响应格式:
 *   { success: true, data: Category }
 */
router.put("/:id", authenticate, async (req, res) => {
  try {
    // 1. 查找分类
    const cat = await prisma.category.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!cat) return res.status(404).json({ success: false, message: "分类不存在" });

    // 2. 权限检查：管理员或创建者
    if (req.user.role !== 'ADMIN' && cat.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: "无权修改此分类" });
    }

    const { name, icon, sort, isActive, isRecommended } = req.body;
    const data = {};
    // 只更新传入的字段
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

/**
 * DELETE /api/categories/:id —— 删除单个分类（物理删除，需认证，仅创建者本人或管理员）
 *
 * HTTP Method: DELETE
 * 路径参数: :id - 分类 ID
 * 鉴权中间件: authenticate
 *
 * 删除前检查（与批量删除相同）:
 *
 *   1. 分类存在性检查: 不存在返回 404
 *   2. 权限检查: 管理员或创建者，不满足返回 403
 *   3. 菜品关联检查: 分类下有菜品时拒绝删除，返回 400
 *      - 这样做防止产生孤儿菜品（categoryId 指向不存在的分类）
 *
 * 删除方式: 物理删除（prisma.category.delete）
 *   与菜品的软删除不同，分类不需要保留历史数据关联
 *
 * 注意: 代码中包含 console.log(count, "555")，看起来是调试遗留，
 *       生产环境建议移除此类调试语句。
 *
 * 响应格式:
 *   成功: { success: true, message: "删除成功" }
 *   失败: { success: false, message: "该分类下有菜品，无法删除" }
 */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // 1. 查找分类
    const cat = await prisma.category.findUnique({ where: { id } });
    if (!cat) return res.status(404).json({ success: false, message: "分类不存在" });

    // 2. 权限检查
    if (req.user.role !== 'ADMIN' && cat.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: "无权删除此分类" });
    }

    // 3. 检查分类下是否有关联菜品
    const count = await prisma.dish.count({ where: { categoryId: id } });
    console.log(count, "555");
    if (count > 0) {
      return res
        .status(400)
        .json({ success: false, message: "该分类下有菜品，无法删除" });
    }

    // 物理删除
    await prisma.category.delete({ where: { id } });
    res.json({ success: true, message: "删除成功" });
  } catch (err) {
    res.status(500).json({ success: false, message: "删除分类失败" });
  }
});

module.exports = router;
