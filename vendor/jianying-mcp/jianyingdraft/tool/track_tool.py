# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: track_tool.py
"""
from mcp.server.fastmcp import FastMCP
from jianyingdraft.services.track_service import create_track_service
from jianyingdraft.utils.response import ToolResponse
from jianyingdraft.utils.index_manager import index_manager


def track_tools(mcp: FastMCP):
    @mcp.tool()
    def create_track(draft_id: str, track_type: str, track_name: str)-> ToolResponse:
        """
        创建轨道
        Args:
            draft_id: 草稿ID
            track_type: 轨道类型，支持 "video", "audio", "text"，
                    一个轨道可以有多个素材，如video轨道想添加两个视频，使用同一个track_id就可以
            track_name: 轨道名称,同类型轨道名不能相同
        """
        # 调用服务层处理业务逻辑
        result = create_track_service(draft_id, track_type, track_name)

        # 如果轨道创建成功，添加索引记录
        if result.success and result.data and "track_id" in result.data:
            track_id = result.data["track_id"]
            index_manager.add_track_mapping(track_id, draft_id, track_name, track_type)

        return result
