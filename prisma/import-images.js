/**
 * 批量导入脚本 — 遍历 uploads/ 目录中的所有图片，自动创建菜品
 *
 * 用法：
 *   cd food-order-system/backend
 *   node prisma/import-images.js
 *
 * 规则：
 *   - 菜品名称 = 图片文件名（去掉后缀）
 *   - 价格默认 = 0
 *   - 菜品照片 = 图片文件
 *   - 分类 = 第一个已有分类（没有的话自动创建"未分类"）
 *   - 已有同名菜品则更新图片并重新上架（不会跳过）
 */

const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

// 加载 .env
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const prisma = new PrismaClient()
const uploadDir = path.join(__dirname, '../uploads')
const BASE_URL = process.env.SERVER_URL || 'http://localhost:3000'

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

async function main() {
  // 确保 uploads 目录存在
  if (!fs.existsSync(uploadDir)) {
    console.log('❌ uploads 目录不存在:', uploadDir)
    process.exit(1)
  }

  // 读取所有图片文件
  const files = fs.readdirSync(uploadDir).filter((f) => {
    const ext = path.extname(f).toLowerCase()
    return ALLOWED_EXT.includes(ext)
  })

  if (files.length === 0) {
    console.log('⚠️  uploads 目录中没有图片文件')
    process.exit(0)
  }

  console.log(`📂 找到 ${files.length} 个图片文件:\n`)
  files.forEach((f) => console.log(`   ${f}`))
  console.log('')

  // 获取或创建默认分类（取第一个已有分类，没有则创建"未分类"）
  let defaultCategory = await prisma.category.findFirst({ orderBy: { sort: 'asc' } })
  if (!defaultCategory) {
    defaultCategory = await prisma.category.create({
      data: { name: '未分类', sort: 0 }
    })
    console.log(`📁 自动创建默认分类: "${defaultCategory.name}"\n`)
  } else {
    console.log(`📁 使用默认分类: "${defaultCategory.name}" (ID: ${defaultCategory.id})\n`)
  }

  let created = 0
  let updated = 0
  const errors = []

  for (const file of files) {
    const ext = path.extname(file)
    const dishName = path.basename(file, ext)

    try {
      const imageUrl = `${BASE_URL}/uploads/${encodeURIComponent(file)}`

      // 用 $transaction 包裹 find + update/create，避免 SQLite 锁超时
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.dish.findFirst({ where: { name: dishName } })

        if (existing) {
          await tx.dish.update({
            where: { id: existing.id },
            data: { image: imageUrl, isActive: true, isRecommended: true }
          })
          return { action: 'updated' }
        } else {
          await tx.dish.create({
            data: {
              name: dishName,
              price: 0,
              image: imageUrl,
              categoryId: defaultCategory.id,
              isActive: true,
              isRecommended: true,
            }
          })
          return { action: 'created' }
        }
      }, { timeout: 15000 })

      if (result.action === 'updated') {
        console.log(`🔄 已更新: ${dishName}  →  ${imageUrl}`)
        updated++
      } else {
        console.log(`✅ 已导入: ${dishName}  →  ¥0.00  →  ${imageUrl}`)
        created++
      }
    } catch (err) {
      console.error(`❌ 导入失败: ${dishName}`, err.message)
      errors.push({ file, error: err.message })
    }
  }

  console.log('')
  console.log('==================== 导入完成 ====================')
  console.log(`  新增菜品: ${created} 个`)
  console.log(`  更新菜品: ${updated} 个`)
  console.log(`  失败:     ${errors.length} 个`)
  if (errors.length > 0) {
    console.log('\n失败详情:')
    errors.forEach((e) => console.log(`  - ${e.file}: ${e.error}`))
  }
  console.log('==================================================')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
