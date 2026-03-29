# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name:draft_tool.py
"""
from jianyingdraft.jianying.export import ExportDraft
import uuid
import json
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 获取环境变量
SAVE_PATH = os.getenv('SAVE_PATH')


class Draft:
    def __init__(self):
        pass

    def create_draft(self, draft_name: str = '', width: int = 1920, height: int = 1080, fps: int = 30):
        """
        创建草稿

        Args:
            draft_name:  str 草稿名称，默认为空，不过最好加上
            width: int,视频宽度,默认1920
            height: int，视频高度，默认1080
            fps: int，帧率，默认30
        """
        # 验证SAVE_PATH是否存在
        if not os.path.exists(SAVE_PATH):
            raise FileNotFoundError(f"草稿存储路径不存在: {SAVE_PATH}")
        # 生成草稿ID
        draft_id = str(uuid.uuid4())
        # 构建完整的草稿路径
        draft_path = os.path.join(SAVE_PATH, draft_id)

        # 创建草稿数据
        draft_data = {
            "draft_id": draft_id,
            "draft_name": draft_name,
            "width": width,
            "height": height,
            "fps": fps
        }
        # 在SAVE_PATH下创建以草稿ID命名的文件夹
        os.makedirs(draft_path, exist_ok=True)

        # 保存draft.json文件
        draft_json_path = os.path.join(draft_path, "draft.json")
        with open(draft_json_path, "w", encoding="utf-8") as f:
            json.dump(draft_data, f, ensure_ascii=False, indent=4)
        return draft_data

    def export_draft(self, draft_id: str, output_path: str = ''):
        """
        导出草稿

        Args:
            draft_id: str, 草稿ID
            output_path: str, 导出路径,可选，默认"./output"

        Returns:
            str: 导出结果信息
        """
        export_manager = ExportDraft(output_path)
        return export_manager.export(draft_id)

