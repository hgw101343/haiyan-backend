require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const http = require('http')
const { WebSocketServer } = require('ws')

const app = express()
const server = http.createServer(app)

// WebSocket 用于订单实时推送
const wss = new WebSocketServer({ server })
const clients = new Map()

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`)
  const userId = url.searchParams.get('userId')
  if (userId) {
    clients.set(userId, ws)
    ws.on('close', () => clients.delete(userId))
  }
})

// 全局挂载 ws 通知方法
app.set('notifyUser', (userId, data) => {
  const ws = clients.get(String(userId))
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data))
  }
})

// 中间件
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 静态文件（上传的图片）
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// 路由
app.use('/api/auth', require('./routes/auth'))
app.use('/api/categories', require('./routes/categories'))
app.use('/api/dishes', require('./routes/dishes'))
app.use('/api/orders', require('./routes/orders'))
app.use('/api/payment', require('./routes/payment'))
app.use('/api/upload', require('./routes/upload'))
app.use('/api/admin', require('./routes/admin'))
app.use('/api/theme', require('./routes/theme'))

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// 全局错误处理
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '服务器内部错误'
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`✅ 点餐服务启动成功: http://localhost:${PORT}`)
})

module.exports = { app, wss }
