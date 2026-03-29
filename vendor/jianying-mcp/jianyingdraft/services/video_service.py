# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: video_service.py
"""
from typing import Optional, Dict, Any, List
from jianyingdraft.jianying.video import VideoSegment
from jianyingdraft.utils.response import ToolResponse


def add_video_segment_service(
    draft_id: str,
    material: str,
    target_timerange: str,
    source_timerange: Optional[str] = None,
    speed: Optional[float] = None,
    volume: float = 1.0,
    change_pitch: bool = False,
    clip_settings: Optional[Dict[str, Any]] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频片段创建服务 - 封装复杂的视频片段创建逻辑
    
    Args:
        draft_id: 草稿ID
        material: 视频文件路径，包括文本文件路径或者url
        target_timerange: 片段在轨道上的目标时间范围，格式如 "0s-4.2s"
        source_timerange: 从源视频文件中截取的时间范围，格式如 "1s-4.2s"（可选）
        speed: 播放速度，默认为1.0（可选）
        volume: 音量，默认为1.0（可选）
        change_pitch: 是否跟随变速改变音调，默认为False（可选）
        clip_settings: 图像调节设置字典（可选）
        track_name: 指定的轨道名称（可选）
    
    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例
        video_segment = VideoSegment(draft_id, track_name=track_name)
        
        # 调用视频片段创建方法
        result_data = video_segment.add_video_segment(
            material=material,
            target_timerange=target_timerange,
            source_timerange=source_timerange,
            speed=speed,
            volume=volume,
            change_pitch=change_pitch,
            clip_settings=clip_settings,
            track_name=track_name
        )
        
        # 构建返回数据，包含video_segment_id
        response_data = {
            "video_segment_id": video_segment.video_segment_id,
            "draft_id": draft_id,
            "add_video_segment": result_data
        }
        
        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name
        
        return ToolResponse(
            success=True,
            message="视频片段创建成功",
            data=response_data
        )
        
    except ValueError as e:
        # 处理参数错误（时间范围格式、轨道类型等）
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
        
    except TypeError as e:
        # 处理轨道类型错误
        return ToolResponse(
            success=False,
            message=f"轨道类型错误: {str(e)}"
        )
        
    except FileNotFoundError as e:
        # 处理文件不存在错误
        return ToolResponse(
            success=False,
            message=f"文件错误: {str(e)}"
        )
        
    except Exception as e:
        # 处理其他未预期的错误
        return ToolResponse(
            success=False,
            message=f"视频片段创建失败: {str(e)}"
        )


def add_video_animation_service(
    draft_id: str,
    video_segment_id: str,
    animation_type: str,
    animation_name: str,
    duration: Optional[str] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频动画添加服务 - 为视频片段添加动画效果

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        animation_type: 动画类型，支持 "IntroType", "OutroType", "GroupAnimationType"
        animation_name: 动画名称，如 "上下抖动", "向上滑动" 等
        duration: 动画持续时间，格式如 "1s"（可选）
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频动画添加方法
        result_data = video_segment.add_animation(
            animation_type=animation_type,
            animation_name=animation_name,
            duration=duration
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "animation_type": animation_type,
            "animation_name": animation_name,
            "duration": duration,
            "add_animation": result_data
        }

        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频动画添加成功: {animation_type}.{animation_name}",
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
            message=f"视频动画添加失败: {str(e)}"
        )


def add_video_transition_service(
    draft_id: str,
    video_segment_id: str,
    transition_type: str,
    duration: Optional[str] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频转场添加服务 - 为视频片段添加转场效果

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        transition_type: 转场类型名称，如 "信号故障", "淡入淡出" 等
        duration: 转场持续时间，格式如 "1s"（可选）
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频转场添加方法
        result_data = video_segment.add_transition(
            transition_type=transition_type,
            duration=duration
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "transition_type": transition_type,
            "duration": duration,
            "add_transition": result_data
        }

        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频转场添加成功: {transition_type}",
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
            message=f"视频转场添加失败: {str(e)}"
        )


def add_video_keyframe_service(
    draft_id: str,
    video_segment_id: str,
    property_name: str,
    time_offset: str,
    value: float,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频关键帧添加服务 - 为视频片段添加关键帧

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        property_name: 属性名称，如 "position_x", "rotation", "alpha" 等
        time_offset: 时间偏移量，如 "0.5s", "1s" 等
        value: 属性值
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频关键帧添加方法
        result_data = video_segment.add_keyframe(
            property_name=property_name,
            time_offset=time_offset,
            value=value
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "property_name": property_name,
            "time_offset": time_offset,
            "value": value,
            "add_keyframe": result_data
        }

        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频关键帧添加成功: {property_name}={value} at {time_offset}",
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
            message=f"视频关键帧添加失败: {str(e)}"
        )


def add_video_filter_service(
    draft_id: str,
    video_segment_id: str,
    filter_type: str,
    intensity: float = 100.0,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频滤镜添加服务 - 为视频片段添加滤镜效果

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        filter_type: 滤镜类型名称，如 "亮肤", "复古", "冰雪世界" 等
        intensity: 滤镜强度 (0-100)，默认100.0
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频滤镜添加方法
        result_data = video_segment.add_filter(
            filter_type=filter_type,
            intensity=intensity
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "filter_type": filter_type,
            "intensity": intensity,
            "add_filter": result_data
        }

        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频滤镜添加成功: {filter_type} (强度: {intensity})",
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
            message=f"视频滤镜添加失败: {str(e)}"
        )


def add_video_background_filling_service(
    draft_id: str,
    video_segment_id: str,
    fill_type: str,
    blur: float = 0.0625,
    color: str = "#00000000",
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频背景填充添加服务 - 为视频片段添加背景填充效果

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        fill_type: 填充类型，"blur"表示模糊，"color"表示颜色
        blur: 模糊程度，0.0-1.0，仅在fill_type为"blur"时有效，默认0.0625
        color: 填充颜色，格式为'#RRGGBBAA'，仅在fill_type为"color"时有效，默认"#00000000"
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频背景填充添加方法
        result_data = video_segment.add_background_filling(
            fill_type=fill_type,
            blur=blur,
            color=color
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "fill_type": fill_type,
            "blur": blur,
            "color": color,
            "add_background_filling": result_data
        }

        # 如果有轨道名称，添加到返回数据中
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频背景填充添加成功: {fill_type}",
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
            message=f"视频背景填充添加失败: {str(e)}"
        )


def add_video_mask_service(
    draft_id: str,
    video_segment_id: str,
    mask_type: str,
    center_x: float = 0.0,
    center_y: float = 0.0,
    size: float = 0.5,
    rotation: float = 0.0,
    feather: float = 0.0,
    invert: bool = False,
    rect_width: Optional[float] = None,
    round_corner: Optional[float] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频蒙版添加服务 - 为视频片段添加蒙版效果

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        mask_type: 蒙版类型名称，如 "圆形", "矩形", "线性" 等
        center_x: 蒙版中心点X坐标(以素材的像素为单位)，默认0.0
        center_y: 蒙版中心点Y坐标(以素材的像素为单位)，默认0.0
        size: 蒙版的主要尺寸，以占素材高度的比例表示，默认0.5
        rotation: 蒙版顺时针旋转的角度，默认0.0
        feather: 蒙版的羽化参数，取值范围0~100，默认0.0
        invert: 是否反转蒙版，默认False
        rect_width: 矩形蒙版的宽度，仅在蒙版类型为矩形时有效，默认None
        round_corner: 矩形蒙版的圆角参数，仅在蒙版类型为矩形时有效，默认None
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频蒙版添加方法
        result_data = video_segment.add_mask(
            mask_type=mask_type,
            center_x=center_x,
            center_y=center_y,
            size=size,
            rotation=rotation,
            feather=feather,
            invert=invert,
            rect_width=rect_width,
            round_corner=round_corner
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "mask_type": mask_type,
            "center_x": center_x,
            "center_y": center_y,
            "size": size,
            "rotation": rotation,
            "feather": feather,
            "invert": invert,
            "add_mask": result_data
        }

        # 添加可选参数到返回数据
        if rect_width is not None:
            response_data["rect_width"] = rect_width
        if round_corner is not None:
            response_data["round_corner"] = round_corner
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频蒙版添加成功: {mask_type}",
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
            message=f"视频蒙版添加失败: {str(e)}"
        )


def add_video_effect_service(
    draft_id: str,
    video_segment_id: str,
    effect_type: str,
    params: Optional[List[Optional[float]]] = None,
    track_name: Optional[str] = None
) -> ToolResponse:
    """
    视频特效添加服务 - 为视频片段添加特效

    Args:
        draft_id: 草稿ID
        video_segment_id: 视频片段ID
        effect_type: 特效类型名称，如 "1998", "70s", "CCD闪光" 等
        params: 特效参数列表，参数范围0-100（可选）
        track_name: 轨道名称（可选）

    Returns:
        ToolResponse: 包含操作结果的响应对象
    """
    try:
        # 创建VideoSegment实例，传入video_segment_id
        video_segment = VideoSegment(draft_id, video_segment_id=video_segment_id, track_name=track_name)

        # 调用视频特效添加方法
        result_data = video_segment.add_effect(
            effect_type=effect_type,
            params=params
        )

        # 构建返回数据
        response_data = {
            "video_segment_id": video_segment_id,
            "draft_id": draft_id,
            "effect_type": effect_type,
            "add_effect": result_data
        }

        # 添加可选参数到返回数据
        if params:
            response_data["params"] = params
        if track_name:
            response_data["track_name"] = track_name

        return ToolResponse(
            success=True,
            message=f"视频特效添加成功: {effect_type}",
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
            message=f"视频特效添加失败: {str(e)}"
        )
