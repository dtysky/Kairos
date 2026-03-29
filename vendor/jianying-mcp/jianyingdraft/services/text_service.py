# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: text_service.py
"""
from typing import Optional, Dict, Any
from jianyingdraft.jianying.text import TextSegment
from jianyingdraft.utils.response import ToolResponse


def add_text_segment_service(
    draft_id: str,
    text: str,
    timerange: str,
    font: Optional[str] = None,
    style: Optional[Dict[str, Any]] = None,
    clip_settings: Optional[Dict[str, Any]] = None,
    border: Optional[Dict[str, Any]] = None,
    background: Optional[Dict[str, Any]] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    文本片段添加服务 - 创建文本片段
    
    Args:
        draft_id: 草稿ID
        text: 文本内容
        timerange: 时间范围，格式如 "0s-5s"
        font: 字体类型名称（可选）
        style: 字体样式字典（可选）
        clip_settings: 图像调节设置字典（可选）
        border: 文本描边参数字典（可选）
        background: 文本背景参数字典（可选）
        track_name: 指定的轨道名称（可选）
    
    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建TextSegment实例
        text_segment = TextSegment(draft_id, track_name=track_name)
        
        # 调用文本片段添加方法
        result_data = text_segment.add_text_segment(
            text=text,
            timerange=timerange,
            font=font,
            style=style,
            clip_settings=clip_settings,
            border=border,
            background=background,
            track_name=track_name
        )
        
        # 构建返回数据
        response_data = {
            "text_segment_id": text_segment.text_segment_id,
            "draft_id": draft_id,
            "text": text,
            "timerange": timerange,
            "add_text_segment": result_data
        }
        
        # 添加可选参数到返回数据
        if font:
            response_data["font"] = font
        if style:
            response_data["style"] = style
        if clip_settings:
            response_data["clip_settings"] = clip_settings
        if border:
            response_data["border"] = border
        if background:
            response_data["background"] = background
        if track_name:
            response_data["track_name"] = track_name
        
        return ToolResponse(
            success=True,
            message=f"文本片段添加成功: {text[:20]}{'...' if len(text) > 20 else ''}",
            data=response_data
        )
        
    except ValueError as e:
        # 处理参数错误
        return ToolResponse(
            success=False,
            message=f"参数错误: {str(e)}"
        )
        
    except NameError as e:
        # 处理轨道不存在错误
        return ToolResponse(
            success=False,
            message=f"轨道错误: {str(e)}"
        )
        
    except Exception as e:
        # 处理其他未预期的错误
        return ToolResponse(
            success=False,
            message=f"文本片段添加失败: {str(e)}"
        )


def add_text_animation_service(
    draft_id: str,
    text_segment_id: str,
    animation_type: str,
    animation_name: str,
    duration: Optional[str] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    文本动画添加服务 - 为文本片段添加动画效果

    Args:
        draft_id: 草稿ID
        text_segment_id: 文本片段ID
        animation_type: 动画类型，"TextIntro"、"TextOutro"、"TextLoopAnim"
        animation_name: 动画名称，如 "复古打字机"、"弹簧"、"色差故障" 等
        duration: 动画持续时间（可选），格式如 "1s"、"500ms"
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建TextSegment实例，传入text_segment_id
        text_segment = TextSegment(draft_id, text_segment_id=text_segment_id, track_name=track_name)

        # 调用文本动画添加方法
        result_data = text_segment.add_animation(
            animation_type=animation_type,
            animation_name=animation_name,
            duration=duration
        )

        # 构建返回数据
        response_data = {
            "text_segment_id": text_segment_id,
            "draft_id": draft_id,
            "animation_type": animation_type,
            "animation_name": animation_name,
            "add_animation": result_data
        }

        # 添加可选参数到返回数据
        if duration:
            response_data["duration"] = duration
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"文本动画添加成功: {animation_type}.{animation_name}",
            data=response_data
        )

    except ValueError as e:
        # 处理参数错误
        return ToolResponse(
            success=False,
            message=f"参数错误: {str(e)}"
        )

    except NameError as e:
        # 处理轨道不存在错误
        return ToolResponse(
            success=False,
            message=f"轨道错误: {str(e)}"
        )

    except Exception as e:
        # 处理其他未预期的错误
        return ToolResponse(
            success=False,
            message=f"文本动画添加失败: {str(e)}"
        )
