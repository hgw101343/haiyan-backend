-- ============================================
-- 生产环境数据库迁移：新增 system_configs 表
-- 适用：/www/wwwroot/backend/prisma/productions.db
-- 
-- 执行方法（在服务器上）：
--   sqlite3 /www/wwwroot/backend/prisma/productions.db < /www/wwwroot/backend/prisma/migration-add-system-configs.sql
-- 
-- ============================================

CREATE TABLE IF NOT EXISTS "system_configs" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key"        TEXT    NOT NULL UNIQUE,
    "value"      TEXT    NOT NULL,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认主题配置
INSERT OR IGNORE INTO "system_configs" ("key", "value")
VALUES ('theme', '{"primaryColor":"#ff6b35","primaryLight":"#ff9a5c","primaryDark":"#e55a2b","backgroundColor":"#f5f5f5","cardColor":"#ffffff","textColor":"#333333","textSecondary":"#999999","navBarBgColor":"#ff6b35","navBarTextStyle":"white","tabBarSelectedColor":"#ff6b35","tabBarColor":"#999999","tabBarBgColor":"#ffffff","borderColor":"#e8e8e8","successColor":"#52c41a","warningColor":"#faad14","errorColor":"#ff4d4f"}');
