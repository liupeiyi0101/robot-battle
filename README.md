# Robot Battle Project

浏览器端机器人对战原型，包含多人房间流程、角色与机体选择、卡牌战斗、地图以及配套素材。

## 运行环境

- Node.js 20 或更高版本

## 本地运行

在项目目录运行：

```bash
npm start
```

然后打开 <http://localhost:4173>。

Windows 用户也可以双击 `Start Robot Battle.bat`。

## 项目结构

- `public/`：前端页面、样式、脚本和游戏数据
- `server.js`：本地 HTTP 服务与游戏逻辑
- `card_images/`、`icon_images/`、`map_images/`、`pilot_images/`、`unit_images/`：图片素材
- `voice/`：音效素材
- `tools/`：数据与素材生成工具
- `*_data.xlsx`：游戏源数据表

## 数据说明

运行时账号和对局状态会写入 `storage/game-state.json`。该目录已被 `.gitignore` 排除，不会提交测试账号、密码哈希或本地对局记录。首次运行时会自动创建所需目录和状态文件。
