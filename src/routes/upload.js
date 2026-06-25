const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { authenticate, isAdmin } = require('../middlewares/auth')

// 确保上传目录存在（包括 feedback 子目录）
const uploadDir = path.join(__dirname, '../../uploads')
const feedbackDir = path.join(uploadDir, 'feedback')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
if (!fs.existsSync(feedbackDir)) fs.mkdirSync(feedbackDir, { recursive: true })

/**
 * 动态选择存储目录
 * - type=feedback → uploads/feedback/
 * - 默认 → uploads/
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.body?.type || req.query?.type || ''
    const dest = type === 'feedback' ? feedbackDir : uploadDir
    cb(null, dest)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('只支持 jpg/png/webp/gif 格式'))
    }
  }
})

/**
 * POST /api/upload
 * 上传单张图片，返回图片 URL
 *
 * 权限：普通用户（需要登录）用于反馈图片上传
 * 管理员：后端菜品图片上传（已有 isAdmin 中间件单独保护）
 *
 * 查询/表单参数：
 *   type=feedback → 存入 uploads/feedback/ 目录
 *   不传 type → 存入 uploads/ 根目录
 */
router.post('/', authenticate, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('[upload] 上传错误:', err.message)
      // multer 的错误需要特殊处理（不是 Express 中间件错误）
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: `上传失败: ${err.message}` })
      }
      return res.status(400).json({ success: false, message: err.message || '上传失败' })
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: '未选择文件' })
    }

    // 构建完整 URL：优先使用 SERVER_URL 环境变量，否则用局域网 IP 兜底
    const serverUrl = process.env.SERVER_URL || 'http://192.168.31.100:3000'
    const subDir = (req.body?.type || req.query?.type) === 'feedback' ? 'feedback/' : ''
    const url = `${serverUrl}/uploads/${subDir}${req.file.filename}`

    res.json({ success: true, data: { url, filename: req.file.filename } })
  })
})

/**
 * POST /api/upload/admin
 * 管理员上传图片（菜品图片等），存入 uploads/ 根目录
 */
router.post('/admin', authenticate, isAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('[upload/admin] 上传错误:', err.message)
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: `上传失败: ${err.message}` })
      }
      return res.status(400).json({ success: false, message: err.message || '上传失败' })
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: '未选择文件' })
    }

    const serverUrl = process.env.SERVER_URL || 'http://192.168.31.100:3000'
    const url = `${serverUrl}/uploads/${req.file.filename}`

    res.json({ success: true, data: { url, filename: req.file.filename } })
  })
})

module.exports = router
