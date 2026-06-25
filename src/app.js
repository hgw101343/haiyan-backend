const path = require("path");
const dotenv = require("dotenv");

// 根据 NODE_ENV 加载对应的 .env 文件，默认 development
const env = process.env.NODE_ENV || "development";
const envFile = path.resolve(__dirname, "..", `.env.${env}`);
dotenv.config({ path: envFile });
// 如果对应文件不存在，dotenv 会静默跳过，再尝试加载 .env（兼容）
dotenv.config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

// WebSocket 用于订单实时推送
const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const userId = url.searchParams.get("userId");
  if (userId) {
    clients.set(userId, ws);
    ws.on("close", () => clients.delete(userId));
  }
});

// 防止服务器 listen 错误导致 WebSocket 未处理异常崩溃
wss.on("error", (err) => {
  console.error("[ws] error:", err.message);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ 端口 ${PORT} 已被占用，请先关闭占用进程再启动`);
  } else {
    console.error("❌ 服务启动失败:", err.message);
  }
  process.exit(1);
});

// 全局挂载 ws 通知方法
app.set("notifyUser", (userId, data) => {
  const ws = clients.get(String(userId));
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
});

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件（上传的图片）——加 CORS 头，允许小程序跨域加载图片
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    next();
  },
  express.static(path.join(__dirname, "../uploads")),
);

// 路由
app.use("/api/auth", require("./routes/auth"));
app.use("/api/categories", require("./routes/categories"));
app.use("/api/dishes", require("./routes/dishes"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/theme", require("./routes/theme"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/favorites", require("./routes/favorites"));

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "服务器内部错误",
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 点餐服务启动成功: http://localhost:${PORT}`);
});

module.exports = { app, wss };
