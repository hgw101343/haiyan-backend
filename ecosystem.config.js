module.exports = {
  apps: [
    {
      name: 'food-order-backend',
      script: 'src/app.js',
      // 生产模式 — 读取 .env.production
      env: {
        NODE_ENV: 'production',
      },
      // 日志路径
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // 自动重启
      autorestart: true,
      // 崩溃后延迟 2 秒再重启
      restart_delay: 2000,
      // 最大重启次数（防止无限重启）
      max_restarts: 10,
      // 内存超限自动重启（300MB）
      max_memory_restart: '300M',
      // 监听文件变更（生产环境建议 false）
      watch: false,
      // 忽略的监听目录
      ignore_watch: [
        'node_modules',
        'logs',
        'uploads',
        'prisma/*.db',
        'prisma/*.db-*',
      ],
    },
  ],
};
