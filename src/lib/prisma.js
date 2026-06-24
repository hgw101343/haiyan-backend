/**
 * 共享 Prisma 客户端 — 所有模块共用同一个实例
 * 开启 WAL 模式 + busy_timeout，支持并发读写
 */
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// 初始化 SQLite 配置
prisma.$connect().then(async () => {
  try {
    // PRAGMA 语句在 Prisma SQLite 下均返回结果，统一用 $queryRawUnsafe
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000')
    console.log('[prisma] SQLite WAL mode enabled')
  } catch (err) {
    console.warn('[prisma] WAL init warning:', err.message)
  }
})

module.exports = prisma
