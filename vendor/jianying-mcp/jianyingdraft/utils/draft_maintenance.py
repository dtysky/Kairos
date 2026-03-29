# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: draft_maintenance.py
"""
import os
import json
from typing import List
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 获取环境变量
SAVE_PATH = os.getenv('SAVE_PATH')


def clean_global_index(draft_base_path: str = None) -> List[str]:
    """
    清理 global_index.json 中多余的草稿数据

    遍历 draft 文件夹下的所有文件夹，这些就是存在的草稿。
    如果 global_index.json 中有多余的草稿数据，就删除该草稿相关的所有数据。

    Args:
        draft_base_path: 草稿基础路径，默认使用环境变量 SAVE_PATH

    Returns:
        List[str]: 被删除的草稿ID列表
    """
    # 如果没有提供路径，使用环境变量
    if draft_base_path is None:
        draft_base_path = SAVE_PATH

    global_index_path = os.path.join(draft_base_path, "global_index.json")

    # 1. 获取所有存在的草稿文件夹
    existing_drafts = set()
    try:
        for item in os.listdir(draft_base_path):
            item_path = os.path.join(draft_base_path, item)
            if os.path.isdir(item_path) and item != "__pycache__":
                # 简单验证是否为草稿ID格式（包含连字符）
                if "-" in item:
                    existing_drafts.add(item)
    except Exception as e:
        print(f"扫描草稿文件夹失败: {e}")
        return []

    # 2. 加载 global_index.json
    try:
        with open(global_index_path, 'r', encoding='utf-8') as f:
            index_data = json.load(f)
    except FileNotFoundError:
        print(f"全局索引文件不存在: {global_index_path}")
        return []
    except json.JSONDecodeError as e:
        print(f"全局索引文件格式错误: {e}")
        return []
    except Exception as e:
        print(f"加载全局索引文件失败: {e}")
        return []

    # 3. 找出需要删除的草稿ID
    deleted_drafts = []

    # 从 draft_mappings 中找出多余的草稿
    draft_mappings = index_data.get("draft_mappings", {})
    for draft_id in list(draft_mappings.keys()):
        if draft_id not in existing_drafts:
            deleted_drafts.append(draft_id)

    # 从其他映射中找出多余的草稿
    for mapping_name in ["track_mappings", "video_segment_mappings", "text_segment_mappings", "audio_segment_mappings"]:
        mappings = index_data.get(mapping_name, {})
        for item_info in mappings.values():
            draft_id = item_info.get("draft_id")
            if draft_id and draft_id not in existing_drafts and draft_id not in deleted_drafts:
                deleted_drafts.append(draft_id)

    # 4. 删除多余的草稿相关数据
    if deleted_drafts:
        # 删除 draft_mappings 中的数据
        draft_mappings = index_data.get("draft_mappings", {})
        for draft_id in deleted_drafts:
            if draft_id in draft_mappings:
                del draft_mappings[draft_id]

        # 删除其他映射中相关的数据
        for mapping_name in ["track_mappings", "video_segment_mappings", "text_segment_mappings", "audio_segment_mappings"]:
            mappings = index_data.get(mapping_name, {})
            for item_id in list(mappings.keys()):
                item_info = mappings[item_id]
                draft_id = item_info.get("draft_id")
                if draft_id in deleted_drafts:
                    del mappings[item_id]

        # 5. 保存更新后的索引文件
        try:
            with open(global_index_path, 'w', encoding='utf-8') as f:
                json.dump(index_data, f, ensure_ascii=False, indent=2)
            print(f"已清理 global_index.json，删除了 {len(deleted_drafts)} 个多余的草稿数据")
            print(f"删除的草稿ID: {deleted_drafts}")
        except Exception as e:
            print(f"保存全局索引文件失败: {e}")
            return []
    else:
        print("没有发现多余的草稿数据，无需清理")

    return deleted_drafts


if __name__ == "__main__":
    # 测试清理功能
    deleted_drafts = clean_global_index()
    if deleted_drafts:
        print(f"清理完成，删除了 {len(deleted_drafts)} 个草稿的数据")
    else:
        print("没有需要清理的数据")
