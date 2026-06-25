/**
 * 共享 Prisma 客户端 — 所有模块共用同一个实例（单例模式）
 *
 * SQLite 性能优化配置：
 *
 * 1. WAL 模式（Write-Ahead Logging，预写日志）：
 *    - SQLite 默认使用 DELETE 模式（回滚日志），写入时会锁定整个数据库文件，
 *      导致读操作被阻塞，并发性能差。
 *    - WAL 模式下，写操作先写入独立的 WAL 文件（-wal），原数据库文件不变，
 *      读操作可以直接读取原始数据库文件，无需等待写锁释放。
 *    - 核心优势：支持"读写并发"（一个写入 + 多个读取同时进行），
 *      在 Web 服务器多请求场景下大幅提升响应速度。
 *    - 注意：WAL 模式会在数据库同目录下生成 .wal 和 .shm 两个辅助文件。
 *
 * 2. busy_timeout（忙碌超时，单位毫秒）：
 *    - 当数据库被其他连接锁定时，默认行为是立即返回 SQLITE_BUSY 错误。
 *    - 设置 busy_timeout=5000 后，SQLite 会在 5 秒内不断重试等待锁释放，
 *      而不是直接报错，避免了因短暂锁竞争导致的请求失败。
 *    - 对多并发场景尤为关键：一个请求正在写 WAL checkpoint 时，
 *      其他请求可以等待而非失败。
 */
const { PrismaClient } = require('@prisma/client')

// 创建全局唯一的 PrismaClient 实例
const prisma = new PrismaClient()

// 初始化 SQLite 数据库连接并配置性能参数
prisma.$connect().then(async () => {
  try {
    // PRAGMA 语句在 Prisma SQLite 下均返回结果，统一用 $queryRawUnsafe 执行
    // 开启 WAL 模式：允许读写并发，提升多请求场景性能
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    // 设置忙碌超时 5 秒：遇到锁定时等待而非直接报错
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000')
    console.log('[prisma] SQLite WAL mode enabled')
  } catch (err) {
    console.warn('[prisma] WAL init warning:', err.message)
  }
})

module.exports = prisma
