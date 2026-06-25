/**
 * routes/dishes.js —— 菜品管理路由
 *
 * 提供菜品的 CRUD（增删改查）、批量删除、上架/下架切换等功能。
 *
 * 权限控制（数据隔离）:
 *   - GET / 公开，但支持 createdBy 参数过滤
 *   - POST / (创建) 要求登录，自动设置 createdBy 为当前用户
 *   - PUT/DELETE/PATCH (修改/删除/切换) 要求登录，但只有创建者本人或管理员可操作
 *   - POST /batch-delete (批量删除) 要求登录，非管理员只能删自己创建的
 *
 * 图片处理相关:
 *   - normalizeImageUrl:  将图片 URL 中的 localhost 替换为实际服务器地址
 *   - normalizeDishImages: 对单个菜品对象的图片 URL 做标准化处理
 *   - renameImageFile:    将上传的图片文件重命名为菜品名称（便于管理）
 *
 * 删除策略: 使用"软删除"模式（设置 isActive: false），不物理删除数据库记录。
 * 这样设计是为了保留历史订单中的菜品关联关系，避免删除菜品后订单项数据显示异常。
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { authenticate, isAdmin } = require("../middlewares/auth");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "../../uploads");
const SERVER_URL = process.env.SERVER_URL || "http://localhost:8888";

/**
 * normalizeImageUrl(url) —— 将图片 URL 中的 localhost 替换为实际服务器地址
 *
 * 为什么需要替换 localhost：
 *   - 后端上传图片时存储的是 http://localhost:8888/uploads/xxx.jpg 这样的相对地址
 *   - 但真机（手机）访问时 localhost 指向手机本身，无法访问服务器上的图片
 *   - SERVER_URL 环境变量存储了服务器的实际 IP 或域名（如 http://192.168.1.100:8888）
 *   - 替换后手机端就能通过局域网 IP 正确加载图片
 *
 * 替换策略: 使用正则 /http:\/\/localhost:\d+/g 匹配任意端口的 localhost URL
 *
 * @param {string} url - 原始图片 URL（可能包含 localhost）
 * @returns {string} 替换后的图片 URL，若 url 为空则原样返回
 */
function normalizeImageUrl(url) {
  if (!url) return url;
  return url.replace(/http:\/\/localhost:\d+/g, SERVER_URL);
}

/**
 * normalizeDishImages(dish) —— 对单个菜品对象的图片 URL 执行标准化处理
 *
 * 批量处理的入口是数组 map，此函数处理单个 dish 对象。
 * 只处理 dish.image 主图字段，不处理其他可能的图片字段。
 *
 * @param {Object} dish - 菜品对象（含 image 属性）
 * @returns {Object} 处理后的菜品对象，image 字段的 localhost 已被替换
 */
function normalizeDishImages(dish) {
  if (!dish) return dish;
  if (dish.image) dish.image = normalizeImageUrl(dish.image);
  return dish;
}

/**
 * renameImageFile(imageUrl, dishName) —— 将上传的图片文件重命名为菜品名称
 *
 * 命名逻辑:
 *   1. 从 URL 中提取原始文件名（如 http://xxx/uploads/temp_abc.jpg → temp_abc.jpg）
 *   2. 在 uploads 目录中找到该文件
 *   3. 将菜品名中的非法字符（Windows/URL 不友好字符）替换为 "-"
 *   4. 保留原文件的扩展名，生成新文件名 = safeName + ext（如 "宫保鸡丁.jpg"）
 *   5. 如果目标文件已存在（同名菜品重新上传图片），先删除旧文件再重命名
 *   6. 返回新的完整 URL（原 baseUrl + encodeURIComponent 编码后的新文件名）
 *
 * 非法字符清理: 正则 /[\\/:*?"<>|]/g 匹配 Windows 文件名禁用的字符和 URL 特殊字符
 *   清理后空格等字符保留（trim 处理首尾空格），文件名中可能出现空格但 modern OS 允许
 *
 * 容错: 如果过程中任何步骤出错（如文件不存在、URL 解析失败），catch 块捕获异常并返回原始 URL
 *
 * @param {string} imageUrl - 原始图片 URL
 * @param {string} dishName - 菜品名称（用作新文件名的基础）
 * @returns {string} 重命名后的图片 URL，失败时返回原始 URL
 */
function renameImageFile(imageUrl, dishName) {
  if (!imageUrl || !dishName) return imageUrl;
  try {
    // 从 URL 中提取文件名，例如 http://localhost:3000/uploads/xxx.jpg → xxx.jpg
    const urlPath = new URL(imageUrl).pathname;
    const oldName = path.basename(urlPath);
    const oldPath = path.join(uploadDir, oldName);

    // 文件不存在则无法重命名，直接返回原 URL
    if (!fs.existsSync(oldPath)) return imageUrl;

    const ext = path.extname(oldName);
    // 清理菜品名中的非法文件名字符（Windows 和 URL 不友好字符）
    const safeName = dishName.replace(/[\\/:*?"<>|]/g, "-").trim();
    const newName = safeName + ext;
    const newPath = path.join(uploadDir, newName);

    // 如果目标文件已存在（同名菜品更新图片），先删旧的
    // oldPath !== newPath 防止重命名为同名文件时误删
    if (oldPath !== newPath) {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
      fs.renameSync(oldPath, newPath);
    }

    // 用原 URL 的 base 拼新文件名（encodeURIComponent 处理中文等特殊字符）
    const baseUrl = imageUrl.substring(0, imageUrl.lastIndexOf("/") + 1);
    return baseUrl + encodeURIComponent(newName);
  } catch {
    // 任何步骤出错（URL 解析失败、文件不存在、权限问题等）返回原 URL
    return imageUrl;
  }
}

/**
 * GET /api/dishes —— 获取菜品列表（公开接口，支持多维筛选和排序）
 *
 * HTTP Method: GET
 * 权限要求: 无（公开接口）
 *
 * 查询参数（Query）:
 *   - categoryId  (可选): 按分类 ID 筛选
 *   - keyword     (可选): 按名称或描述模糊搜索
 *   - page        (可选): 页码，默认 1
 *   - limit       (可选): 每页条数，默认 20（兼容 pageSize 参数）
 *   - recommended (可选): 是否推荐（"true"/"false"），用于首页推荐菜品展示
 *   - createdBy   (可选): 按创建人 ID 筛选，用于数据隔离（管理员查看指定用户的菜品）
 *
 * 默认过滤: 只返回 isActive=true 的菜品，排除已下架/软删除的菜品
 *
 * 排序优先级（orderBy 三元组，优先级从高到低）:
 *   1. isRecommended: desc  — 推荐菜品排在前面
 *   2. sales: desc           — 销量高的优先
 *   3. createdAt: desc       — 最新创建的优先
 *
 * 图片处理: 返回前对所有菜品调用 normalizeDishImages 批量替换 localhost 为实际服务器地址
 *
 * 响应格式:
 *   { success: true, data: [Dish], pagination: { total, page, limit } }
 */
router.get("/", async (req, res) => {
  try {
    const {
      categoryId,
      keyword,
      page = 1,
      limit,
      pageSize,
      recommended,
      createdBy,
      all, // 新增：all=true 时返回所有菜品（不限 isActive）
      sort, // 排序方式：newest=按创建时间倒序
    } = req.query;
    // 兼容 limit 和 pageSize 两种参数名
    const pageLimit = parseInt(limit || pageSize || 20);
    // 默认条件：只查在售菜品；all=true 时不过滤 isActive
    const where = all === 'true' ? {} : { isActive: true };

    // 按分类筛选
    if (categoryId) where.categoryId = parseInt(categoryId);
    // 按推荐状态筛选
    if (recommended !== undefined) {
      where.isRecommended = recommended === "true";
    }
    // 按名称或描述模糊搜索
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { description: { contains: keyword } },
      ];
    }
    // 按创建人过滤（管理员后台传 createdBy=自己的userId 看自己的菜品）
    if (createdBy) where.createdBy = parseInt(createdBy);

    // 排序逻辑：sort=newest 时按创建时间倒序，否则按推荐→销量→创建时间
    const orderBy = sort === 'newest'
      ? [{ createdAt: 'desc' }]
      : [
          { isRecommended: 'desc' },
          { sales: 'desc' },
          { createdAt: 'desc' },
        ];

    // 先查总数用于前端分页计算
    const total = await prisma.dish.count({ where });

    const dishes = await prisma.dish.findMany({
      where,
      include: { category: { select: { id: true, name: true } } },
      orderBy,
      skip: (parseInt(page) - 1) * pageLimit,
      take: pageLimit,
    });

    // 批量标准化图片 URL（替换 localhost）
    const normalized = dishes.map(normalizeDishImages);

    res.json({
      success: true,
      data: normalized,
      pagination: { total, page: parseInt(page), limit: pageLimit },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "获取菜品失败" });
  }
});

/**
 * POST /api/dishes/batch-delete —— 批量删除（下架）菜品（需认证）
 *
 * HTTP Method: POST
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录
 *
 * 请求体（JSON）:
 *   - ids (必填): 要删除的菜品 ID 数组，如 [1, 2, 3]
 *
 * 数据隔离逻辑:
 *   - 管理员: 可以删除（下架）任意菜品
 *   - 普通用户 (req.user.role !== 'ADMIN'): 只能删除自己创建的菜品
 *     通过在 where 条件中追加 createdBy: req.user.id 实现
 *
 * 软删除模式:
 *   - 使用 updateMany 将 isActive 设为 false，而不是物理删除数据库记录
 *   - 原因: 历史订单可能引用了这些菜品，物理删除会导致订单详情中菜品信息丢失
 *   - 副作用: 如果某菜品不在用户创建的范围内会被静默忽略（updateMany 只匹配符合条件的记录）
 *
 * 响应格式:
 *   { success: true, message: "成功批量删除 N 个菜品" }
 */
router.post("/batch-delete", authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "请提供要删除的菜品ID列表" });
    }
    // 构建删除条件：匹配所有指定 ID
    const where = { id: { in: ids.map(Number) } };
    // 非管理员只能删自己创建的
    if (req.user.role !== 'ADMIN') {
      where.createdBy = req.user.id;
    }
    // 软删除：设置 isActive = false
    await prisma.dish.updateMany({
      where,
      data: { isActive: false },
    });
    res.json({ success: true, message: `成功批量删除 ${ids.length} 个菜品` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "批量删除菜品失败" });
  }
});

/** GET /api/dishes/:id —— 获取单个菜品详情（公开接口） */
router.get("/:id", async (req, res) => {
  try {
    const dish = await prisma.dish.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { category: true },
    });
    if (!dish)
      return res.status(404).json({ success: false, message: "菜品不存在" });
    // 返回前标准化图片 URL
    res.json({ success: true, data: normalizeDishImages(dish) });
  } catch (err) {
    res.status(500).json({ success: false, message: "获取菜品失败" });
  }
});

/**
 * POST /api/dishes —— 创建新菜品（需认证）
 *
 * HTTP Method: POST
 * 鉴权中间件: authenticate
 * 权限要求: 需要登录（任何登录用户均可创建）
 *
 * 请求体（JSON）:
 *   - name        (必填): 菜品名称
 *   - price       (必填): 菜品价格（元）
 *   - categoryId  (必填): 所属分类 ID
 *   - description (可选): 菜品描述
 *   - image       (可选): 图片 URL（上传后返回的地址）
 *   - stock       (可选): 库存数量，默认 999
 *   - isRecommended (可选): 是否推荐，默认 false
 *
 * 创建流程:
 *   1. 校验必填字段（name, price, categoryId）
 *   2. 如果有图片，调用 renameImageFile 将图片文件重命名为菜品名称
 *      - 这样做的原因: 上传时文件名通常是随机的（如时间戳），不方便管理
 *      - 重命名后文件名与菜品名一致，查找和替换时更直观
 *   3. 设置 createdBy = req.user.id，建立菜品与创建者的关联关系
 *      - 后续修改/删除操作通过此字段判断权限
 *   4. 插入数据库，返回创建的菜品（含分类关联信息）
 *
 * 默认值说明:
 *   - stock 默认 999: 方便运营，通常不需要精确库存管理
 *   - isRecommended 默认 false: 新菜品不自动推荐
 *
 * 响应格式:
 *   HTTP 201 { success: true, data: Dish }
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      image,
      categoryId,
      stock,
      isRecommended,
    } = req.body;
    // 必填字段校验
    if (!name || price === undefined || !categoryId) {
      return res
        .status(400)
        .json({ success: false, message: "名称、价格、分类不能为空" });
    }

    // 如果有图片，按菜品名称重命名图片文件
    const finalImage = renameImageFile(image, name);

    const dish = await prisma.dish.create({
      data: {
        name,
        description,
        price: parseFloat(price),
        image: finalImage,
        categoryId: parseInt(categoryId),
        stock: stock ? parseInt(stock) : 999,     // 默认库存 999
        isRecommended: !!isRecommended,             // 双重取反转布尔值
        createdBy: req.user.id,                     // 记录创建人，用于后续权限判断
      },
      include: { category: true },
    });
    res.status(201).json({ success: true, data: dish });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "创建菜品失败" });
  }
});

/**
 * PUT /api/dishes/:id —— 更新菜品信息（需认证，仅创建者本人或管理员）
 *
 * HTTP Method: PUT
 * 路径参数: :id - 菜品 ID
 * 鉴权中间件: authenticate
 *
 * 权限检查逻辑:
 *   1. 先查询菜品是否存在（不存在返回 404）
 *   2. 检查操作权限：管理员 (role === 'ADMIN') 或有创建者 (dish.createdBy === req.user.id)
 *   3. 不满足返回 403
 *
 * 可以更新的字段:
 *   - name, description, price, categoryId, stock, isFeatured, isActive, isRecommended
 *   - image (图片 URL)
 *
 * 图片重命名逻辑（关键）:
 *   情况A - 更新了图片 (image !== undefined):
 *     - 如果有新名称：用新名称重命名图片
 *     - 如果没有新名称：用旧名称重命名图片（即 name || dish.name）
 *
 *   情况B - 只改了名称没改图片 (image === undefined, name !== undefined):
 *     - 将旧图片文件重命名以匹配新名称
 *     - 如果菜品原有 image，调用 renameImageFile(dish.image, name)
 *     - 这样菜品改名后图片文件也同步改名，保持一致性
 *
 * 响应格式:
 *   { success: true, data: Dish }
 */
router.put("/:id", authenticate, async (req, res) => {
  try {
    // 1. 查询菜品是否存在
    const dish = await prisma.dish.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!dish) return res.status(404).json({ success: false, message: "菜品不存在" });

    // 2. 权限检查：只有创建者本人或管理员可修改
    if (req.user.role !== 'ADMIN' && dish.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: "无权修改此菜品" });
    }

    const {
      name,
      description,
      price,
      image,
      categoryId,
      stock,
      isFeatured,
      isActive,
      isRecommended,
    } = req.body;
    const data = {};

    // 基础字段更新
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (price !== undefined) data.price = parseFloat(price);

    // 图片处理：根据是否传了新图片和是否改了名称，分情况处理
    if (image !== undefined) {
      // 情况A：更新了图片地址 → 用目标名称重命名图片文件
      const targetName = name || dish?.name || "";
      data.image = renameImageFile(image, targetName);
    } else {
      // 情况B：只改了名称没改图片 → 用新名称重命名旧图片文件
      if (name !== undefined) {
        if (dish?.image) {
          data.image = renameImageFile(dish.image, name);
        }
      }
    }

    // 其他字段更新
    if (categoryId !== undefined) data.categoryId = parseInt(categoryId);
    if (stock !== undefined) data.stock = parseInt(stock);
    if (isFeatured !== undefined) data.isFeatured = !!isFeatured;
    if (isActive !== undefined) data.isActive = !!isActive;
    if (isRecommended !== undefined) data.isRecommended = !!isRecommended;

    const updated = await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: { category: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "更新菜品失败" });
  }
});

/**
 * PATCH /api/dishes/:id/available —— 切换菜品上架/下架状态（需认证，仅创建者本人或管理员）
 *
 * HTTP Method: PATCH
 * 路径参数: :id - 菜品 ID
 * 鉴权中间件: authenticate
 *
 * 请求体（JSON）:
 *   - isActive (必填): 目标状态，true 上架 / false 下架
 *
 * 权限检查: 与 PUT 相同，管理员或创建者可操作
 *
 * 业务逻辑区别:
 *   - PATCH /available vs DELETE:
 *     PATCH 明确表达"切换上下架"，可能上架或下架
 *     DELETE 路由虽然也用软删除，但语义上表示"删除"
 *     两者操作相同（改 isActive），但给前端提供不同语义的 API
 *
 * 响应格式:
 *   { success: true, data: Dish }
 */
router.patch("/:id/available", authenticate, async (req, res) => {
  try {
    const dish = await prisma.dish.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!dish) return res.status(404).json({ success: false, message: "菜品不存在" });
    // 权限检查：管理员或创建者
    if (req.user.role !== 'ADMIN' && dish.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: "无权操作此菜品" });
    }
    const { isActive } = req.body;
    const updated = await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data: { isActive: !!isActive },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "更新状态失败" });
  }
});

/**
 * DELETE /api/dishes/:id —— 删除菜品（软删除，需认证，仅创建者本人或管理员）
 *
 * HTTP Method: DELETE
 * 路径参数: :id - 菜品 ID
 * 鉴权中间件: authenticate
 *
 * 删除方式: 软删除（设置 isActive = false）
 *
 * 为什么用软删除而非物理删除:
 *   1. 历史订单中可能包含此菜品（orderItems 表关联 dishId）
 *   2. 物理删除会导致订单详情页菜品信息丢失或报错
 *   3. 软删除保留数据完整性，同时实现"下架"效果
 *   4. 如果需要恢复，只需将 isActive 改回 true 即可（与 DELETE 语义不同）
 *
 * 对比 PATCH /available:
 *   - DELETE 语义上表示"删除"，通常不会再恢复
 *   - PATCH /available 语义上表示"上下架切换"，可双向操作
 *   - 两者底层操作相同（改 isActive），但给前端提供不同语义的 API 入口
 *
 * 权限检查: 管理员或创建者可操作
 *
 * 响应格式:
 *   { success: true, message: "删除成功" }
 */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const dish = await prisma.dish.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!dish) return res.status(404).json({ success: false, message: "菜品不存在" });
    // 权限检查：管理员或创建者
    if (req.user.role !== 'ADMIN' && dish.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: "无权删除此菜品" });
    }
    // 软删除：将 isActive 设为 false
    await prisma.dish.update({
      where: { id: parseInt(req.params.id) },
      data: { isActive: false },
    });
    res.json({ success: true, message: "删除成功" });
  } catch (err) {
    res.status(500).json({ success: false, message: "删除菜品失败" });
  }
});

module.exports = router;
