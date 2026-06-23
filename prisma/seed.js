const { PrismaClient } = require('@prisma/client')
const crypto = require('crypto')

const prisma = new PrismaClient()

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

async function main() {
  console.log('清空旧数据...')
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.dish.deleteMany()
  await prisma.category.deleteMany()
  await prisma.user.deleteMany()

  console.log('开始填充初始数据...')

  // 创建分类
  const categories = await Promise.all([
    prisma.category.create({ data: { name: '推荐', icon: '🔥', sort: 0 } }),
    prisma.category.create({ data: { name: '主食', icon: '🍜', sort: 1 } }),
    prisma.category.create({ data: { name: '小吃', icon: '🍟', sort: 2 } }),
    prisma.category.create({ data: { name: '饮品', icon: '🥤', sort: 3 } }),
    prisma.category.create({ data: { name: '甜点', icon: '🍰', sort: 4 } })
  ])
  console.log('分类创建完成:', categories.length, '条')

  // 创建菜品
  const dishes = [
    { name: '红烧肉盖饭', description: '正宗红烧肉，入口即化', price: 28.00, categoryId: categories[1].id, isFeatured: true },
    { name: '番茄鸡蛋面', description: '新鲜番茄配土鸡蛋，营养美味', price: 18.00, categoryId: categories[1].id },
    { name: '蒜香鸡腿饭', description: '嫩滑鸡腿，蒜香四溢', price: 32.00, categoryId: categories[1].id, isFeatured: true },
    { name: '招牌炒饭', description: '厨师特制蛋炒饭，颗粒分明', price: 22.00, categoryId: categories[1].id },
    { name: '薯条（大）', description: '黄金酥脆，现炸现卖', price: 12.00, categoryId: categories[2].id },
    { name: '鸡翅（4个）', description: '秘制腌料，外酥里嫩', price: 28.00, categoryId: categories[2].id, isFeatured: true },
    { name: '洋葱圈', description: '香脆可口，搭配番茄酱', price: 15.00, categoryId: categories[2].id },
    { name: '可乐（大）', description: '冰镇可口可乐', price: 8.00, categoryId: categories[3].id },
    { name: '鲜榨橙汁', description: '新鲜橙子现榨，无添加', price: 18.00, categoryId: categories[3].id },
    { name: '珍珠奶茶', description: '台湾原味配方，Q弹珍珠', price: 16.00, categoryId: categories[3].id, isFeatured: true },
    { name: '草莓蛋糕', description: '新鲜草莓，手工制作', price: 38.00, categoryId: categories[4].id },
    { name: '提拉米苏', description: '经典意式甜点', price: 32.00, categoryId: categories[4].id }
  ]

  for (const dish of dishes) {
    await prisma.dish.create({ data: dish })
  }

  // 创建一个管理员用户
  await prisma.user.create({
    data: {
      openid: 'admin_internal',
      nickname: 'admin',
      role: 'ADMIN',
      passwordHash: hashPassword('admin123')
    }
  })

  console.log('菜品创建完成:', dishes.length, '条')
  console.log('数据初始化完成！')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
