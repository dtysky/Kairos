# JianYing MCP - 剪映视频制作 MCP 服务器

[![Python](https://img.shields.io/badge/Python-3.13+-blue.svg)](https://python.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

一个基于 Model Context Protocol (MCP) 的剪映视频制作自动化工具，让 AI 助手能够通过自然语言创建专业的视频内容。

## 🎯 项目简介

jianying mcp是一个强大的视频制作自动化工具，通过mcp协议让AI能够：

- 🎬 **自动创建剪映草稿项目**
- 🎵 **智能添加音频、视频、文本素材**
- ✨ **应用各种特效、滤镜、动画**
- 🎨 **自动化视频编辑流程**
- 📤 **导出为剪映可编辑的项目文件**

## 🚀 核心功能

### 📋 草稿管理
- `rules` - 制作视频规范
- `create_draft` - 创建新的视频草稿项目
- `export_draft` - 导出为剪映项目文件

### 🛤️ 轨道管理
- `create_track` - 创建视频/音频/文本轨道

### 🎥 视频处理
- `add_video_segment` - 添加视频片段(可以是本地文件，也可以是url)
- `add_video_animation` - 添加入场/出场动画
- `add_video_transition` - 添加转场效果
- `add_video_filter` - 应用滤镜效果
- `add_video_mask` - 添加蒙版效果
- `add_video_background_filling` - 背景填充
- `add_video_keyframe` - 关键帧动画

### 🎵 音频处理
- `add_audio_segment` - 添加音频片段(可以是本地文件，也可以是url)
- `add_audio_effect` - 音频特效（电音、混响等）
- `add_audio_fade` - 淡入淡出效果
- `add_audio_keyframe` - 音频关键帧

### 📝 文本处理
- `add_text_segment` - 添加文本片段
- `add_text_animation` - 文字动画效果
- `add_text_bubble` - 文字气泡效果
- `add_text_effect` - 文字花字特效

### 🔧 实用工具
- `parse_media_info` - 解析媒体文件信息
- `find_effects_by_type` - 查找可用特效资源

## 📦 快速开始

### 1. 安装 uv

**Windows:**
```bash
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**macOS/Linux:**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2. 克隆项目并安装依赖

```bash
git clone https://github.com/your-username/jianying-mcp.git
cd jianying-mcp
uv sync
```

### 3. 配置 MCP 客户端

以 Augment Code 为例，在 MCP 客户端中添加服务器配置：

```json
{
  "mcpServers": {
    "jianying-mcp": {
      "command": "uv",
      "args": [
        "--directory",
        "/your-path/jianying-mcp/jianyingdraft",
        "run",
        "server.py"
      ],
      "env": {
        "SAVE_PATH": "/your-path/draft",
        "OUTPUT_PATH": "/your-path/output"
      }
    }
  }
}
```
- SAVE_PATH:数据存储路径 - 存储草稿的操作数据
- OUTPUT_PATH:导出路径 - 生成的剪映草稿文件存放位置

## 🎥 演示视频

🎬 [点击观看完整演示视频](https://www.bilibili.com/video/BV1rhe4z1Eu1)


## 🔧 开发指南

### 调试模式

使用 MCP Inspector 进行调试：

```bash
uv run mcp dev jianyingdraft/server.py
```


## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io) - 提供了强大的 AI 集成协议
- [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft) - 剪映项目文件处理库
---

⭐ 如果这个项目对你有帮助，请给个 Star 支持一下！