# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: track_service.py
"""
from typing import Optional, Dict, Any
from jianyingdraft.jianying.track import Track
from jianyingdraft.utils.response import ToolResponse


def create_track_service(draft_id: str, track_type: str, track_name: Optional[str] = None) -> ToolResponse:
    """
    轨道创建服务 - 封装复杂的轨道创建逻辑
    
    Args:
        draft_id: 草稿ID
        track_type: 轨道类型 ("video", "audio", "text")
        track_name: 轨道名称（可选）
    
    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建Track实例
        track = Track(draft_id)
        
        # 调用轨道创建方法
        track_id = track.add_track(track_type, track_name)
        
        # 构建返回数据
        result_data = {
            "track_id": track_id,
            "draft_id": draft_id,
            "track_type": track_type
        }
        
        # 如果有轨道名称，添加到返回数据中
        if track_name:
            result_data["track_name"] = track_name
        
        return ToolResponse(
            success=True, 
            message="轨道创建成功", 
            data=result_data
        )
        
    except ValueError as e:
        # 处理轨道类型无效或轨道名称格式错误
        return ToolResponse(
            success=False, 
            message=f"参数错误: {str(e)}"
        )
        
    except NameError as e:
        # 处理轨道名称已存在或同类型轨道需要指定名称
        return ToolResponse(
            success=False, 
            message=f"轨道冲突: {str(e)}"
        )
        
    except Exception as e:
        # 处理其他未预期的错误
        return ToolResponse(
            success=False, 
            message=f"轨道创建失败: {str(e)}"
        )
