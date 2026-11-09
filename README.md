# Xiaoxiao Reader · 本机 Edge TTS

在 Chrome 侧栏里朗读网页正文或选中文字，使用免费的微软 Edge 在线语音（无需 Azure 密钥），支持逐句跳转、暂停后自由滚动、以及分页文章的预加载顺延朗读。

## 功能

- **朗读网页/选中文字**：点击工具栏图标或右键菜单即可读取正文，右侧面板自动朗读。
- **逐句控制**：`◀ 上一句` / `下一句 ▶` 按钮，或 `Alt+←` / `Alt+→`；`Space` 暂停/继续。
- **暂停不跟随**：暂停后保留当前位置高亮但停止自动滚动，可自由浏览；继续播放后按开关恢复。
- **多篇文章顺延**：遇到分页文章时点击“载入下一篇”，扩展读取同一站点的“下一篇/下一页”链接，预加载后在当前文章读完后自动继续。
- **同步高亮**：按行 / 段落 / 字高亮原网页，支持跟随、跨屏长段落和内层滚动区域。
- **扩展内启动服务**：无需双击桌面脚本，直接在侧栏点击“启动本机服务”。

## 结构

```
extension/           Chrome 扩展（Manifest V3）
  manifest.json      扩展清单
  background.js      后台：脚本注入、下一篇文章预加载、调用本机启动桥接
  content.js         页面侧：正文捕获、定位、高亮、下一页链接发现
  reader.html/js/css 侧栏朗读面板
server.py           本机 Edge TTS 桥接（仅监听 127.0.0.1:18765）
native_host.py       Native Messaging：仅接受固定扩展 ID 的启动请求
native-host.cmd/.json  本机启动程序入口与清单模板
install-native-host.ps1/.cmd  一次性安装本机启动桥接
test_bridge.py      服务端离线协议测试
test_native_host.py 本机启动程序离线测试
```

## 快速开始

1. 需要 Python 3.11+。
2. 创建虚拟环境并安装依赖：

   ```bat
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

3. 生成扩展配置（随机本机 token），把 `.venv` 与随机 token 写入 `extension/config.js` 和 `config.json`（参考 `extension/config.example.js`）。
4. 可选：双击 `install-native-host.cmd`，为当前用户注册 Chrome 本机启动程序，之后可在扩展侧栏内启动服务。
5. 打开 `chrome://extensions`，开启开发者模式，“加载已解压的扩展程序”，选择 `extension/` 目录。

也可以直接运行 `start.ps1` 启动服务并打开粘贴文字朗读页。

## 测试

```bat
.venv\Scripts\python.exe -B test_bridge.py
.venv\Scripts\python.exe -B test_native_host.py
```

## 说明

- 本机服务只监听 `127.0.0.1:18765`，`config.json` 内的本机凭证不要公开。
- 原生启动程序只允许固定扩展 ID 调用；更换扩展加载目录会改变 ID，需要同步修改常量。
- 语音合成依赖网络访问微软 Edge 语音服务。

## 许可

MIT
